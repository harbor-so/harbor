// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Inbound event delivery — the pipeline behind `POST /api/triggers/<source>/<id>`.
 *
 * The ordering here is the security model, read top to bottom, and it is the same
 * discipline as the connector webhook route: each step may only use a fact the
 * step before it established. Signature over the raw bytes before anything parses
 * them; the automation loaded by id but its org read off the row, never asserted
 * by the sender; the decision to fire made only after enabled/paused, conditions,
 * rate and budget have each had their say.
 *
 * The response-code split is deliberate and matches what Slack, Sentry and GitHub
 * senders do with the answer. Anything that fails authentication — unknown id,
 * wrong source, missing secret, bad signature, stale timestamp — is **401**, all
 * indistinguishable, because telling an unauthenticated caller which of those it
 * was tells them whether the endpoint is worth attacking. Anything that
 * authenticated but chose not to fire — disabled, paused, filtered, rate-limited,
 * over-budget, already-seen — is **200 with a reason**, because those senders
 * retry a non-2xx, and a retry re-runs this whole pipeline: returning 500 for "the
 * conditions did not match" would have Sentry hammering the endpoint until it gave
 * up. Only an unknown source (404), an oversize body (413) and malformed JSON
 * (400) sit outside that split.
 */

import { createHash } from "node:crypto";
import { and, eq, gte, sql as raw } from "drizzle-orm";
import { db } from "@core/schema/index.js";
import { automationRuns, automations, events } from "@core/schema/schema.js";
import { setting } from "@core/kernel/config.js";
import { CryptoError, decrypt } from "../lib/crypto.js";
import { budgetStatusSafe } from "./budget-bridge.js";
import { evaluateAll, parseConditions } from "./conditions.js";
import { runAutomationForEvent } from "./automations.js";
import { sourceFor } from "./sources/registry.js";

export interface DeliverInput {
	source: string;
	automationId: string;
	raw: string;
	headers: Record<string, string | undefined>;
	now?: Date;
}

export interface DeliverResult {
	status: number;
	fired: boolean;
	/** Why it did not fire, when it authenticated but chose not to. Absent on a fire. */
	reason?: string;
}

/** The stored signing secret lives under `spec.secret` as a crypto envelope. */
function storedSecret(spec: unknown): string | null {
	if (typeof spec !== "object" || spec === null) return null;
	const value = (spec as { secret?: unknown }).secret;
	return typeof value === "string" && value.length > 0 ? value : null;
}

export async function deliverEvent(input: DeliverInput): Promise<DeliverResult> {
	const now = input.now ?? new Date();

	const source = sourceFor(input.source);
	if (!source) return { status: 404, fired: false, reason: "unknown_source" };

	if (input.raw.length > setting("triggerMaxBodyBytes")) {
		return { status: 413, fired: false, reason: "too_large" };
	}

	const automation = await db.query.automations.findFirst({
		where: eq(automations.id, input.automationId),
	});

	// Unknown id, wrong source and no-secret are all indistinguishable to the
	// sender — a valid signature is the only thing that proves anything, and none
	// of these can produce one. The no-secret case is logged for the operator,
	// because "every delivery is rejected" with nothing in the logs reads as the
	// endpoint being broken rather than unconfigured.
	if (!automation || automation.source !== input.source) {
		return { status: 401, fired: false, reason: "unauthorized" };
	}
	const envelope = storedSecret(automation.spec);
	if (!envelope) {
		console.error(
			`[trigger] automation ${automation.id} (${input.source}) has no signing secret. `
				+ "Every delivery will be rejected until one is set.",
		);
		return { status: 401, fired: false, reason: "unauthorized" };
	}

	let secret: string;
	try {
		secret = decrypt(envelope);
	} catch (error) {
		// A secret that will not decrypt is a key-rotation or corruption problem, not
		// a caller problem — but the caller still learns nothing beyond "unauthorized".
		console.error(
			`[trigger] automation ${automation.id}: stored secret did not decrypt: `
				+ `${(error as CryptoError).message}`,
		);
		return { status: 401, fired: false, reason: "unauthorized" };
	}

	if (!source.verify(input.raw, input.headers, secret, now)) {
		return { status: 401, fired: false, reason: "unauthorized" };
	}

	// Past this line the delivery is authentic. Every remaining outcome is a 200.
	let payload: unknown;
	try {
		payload = JSON.parse(input.raw);
	} catch {
		return { status: 400, fired: false, reason: "invalid_json" };
	}

	if (!automation.enabled) return { status: 200, fired: false, reason: "disabled" };
	if (automation.pausedReason) return { status: 200, fired: false, reason: "paused" };

	const conditions = parseConditions(automation.spec);
	if (!evaluateAll(conditions, source.normalize(payload))) {
		return { status: 200, fired: false, reason: "filtered" };
	}

	// Rate cap before budget: shedding a retry storm should cost one indexed count,
	// not a budget round-trip, and a webhook with no time bound is the amplification
	// path cron does not have.
	const windowStart = new Date(now.getTime() - 60_000); // one minute, the unit of the cap
	const [rate] = await db
		.select({ count: raw<number>`count(*)::int` })
		.from(automationRuns)
		.where(
			and(
				eq(automationRuns.automationId, automation.id),
				gte(automationRuns.startedAt, windowStart),
			),
		);
	if ((rate?.count ?? 0) >= setting("triggerMaxRunsPerMinutePerAutomation")) {
		return { status: 200, fired: false, reason: "rate_limited" };
	}

	// Budget is pre-checked here so an exhausted cap sheds the delivery without
	// creating a run row or touching `consecutiveFailures` — an event source firing
	// into a full budget all afternoon must not auto-pause itself.
	const budget = await budgetStatusSafe(automation.orgId);
	if (budget.exhausted) return { status: 200, fired: false, reason: "budget" };

	// Idempotency: the source names the delivery, and a body hash is the fallback
	// when it cannot. A hash collides only on a byte-identical redelivery, which is
	// exactly the retry we want to collapse — erring toward skipping a genuine
	// duplicate rather than double-spending.
	const dedupeKey =
		source.deliveryId(payload, input.headers)
		?? createHash("sha256").update(input.raw).digest("hex");

	const outcome = await runAutomationForEvent(automation, {
		dedupeKey,
		extraContext: source.describe(payload),
	});

	await db.insert(events).values({
		orgId: automation.orgId,
		type: "automation_delivery",
		payload: {
			source: input.source,
			automation_id: automation.id,
			outcome,
			dedupe_key: dedupeKey,
			trace_id: input.headers["x-harbor-trace-id"] ?? null,
		},
	});

	if (outcome === "duplicate") return { status: 200, fired: false, reason: "duplicate" };
	return { status: 200, fired: true };
}
