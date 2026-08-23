// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@core/schema/index.js";
import { automations, environments, repos } from "@core/schema/schema.js";
import { currentSession } from "../../lib/session.js";
import { AGENT_RUNTIMES } from "../../contracts/agent.js";
import { encrypt, encryptionConfigured } from "../../lib/crypto.js";
import { parseCron, nextRun } from "../../triggers/cron.js";
import { parseConditions } from "../../triggers/conditions.js";
import { TRIGGER_SOURCE_TYPES } from "../../triggers/sources/registry.js";

/**
 * Create an automation.
 *
 * There was no creation path in the product before this — automations could be
 * run, resumed and listed, but only ever came into existence from a seed or a
 * test inserting a row directly. This closes that, for cron *and* the two event
 * sources, org-scoped exactly like the run/resume routes: the target is loaded
 * with the org in the `where`, never filtered after, so a `targetId` from another
 * tenant misses rather than leaking.
 *
 * The one asymmetry with the connector route is that an event source's secret is
 * **required at creation** rather than tolerated-and-backfilled. A connector has
 * an OAuth install step that a webhook does not, so there is no window where an
 * unsigned delivery would have to be accepted; requiring it up front means the
 * endpoint is never briefly open.
 */

// harbor-lint-allow-constant: an input-validation bound on a display field, not an
// operational tunable — a self-hoster does not need per-repo control over how long an
// automation name may be, and nothing downstream reads it.
const MAX_NAME = 200;
// harbor-lint-allow-constant: mirrors queuePrompt's own 8000-character ceiling
// (src/lib/sessions.ts) so an over-long prompt is refused at creation with a clear
// message rather than at the first fire. It must equal that limit, not float free of it.
const MAX_PROMPT = 8000;

function bad(message: string, status = 400) {
	return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
	const session = await currentSession();
	if (!session) return bad("Not signed in.", 401);

	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return bad("Invalid JSON body.");
	}

	const name = typeof body.name === "string" ? body.name.trim() : "";
	if (!name) return bad("An automation needs a name.");
	if (name.length > MAX_NAME) return bad(`Name is too long (max ${MAX_NAME}).`);

	const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
	if (!prompt) return bad("An automation needs a prompt.");
	if (prompt.length > MAX_PROMPT) return bad(`Prompt is too long (max ${MAX_PROMPT}).`);

	const source = typeof body.source === "string" ? body.source : "";
	const allowedSources = ["cron", ...TRIGGER_SOURCE_TYPES];
	if (!allowedSources.includes(source)) {
		return bad(`Unknown source "${source}". One of: ${allowedSources.join(", ")}.`);
	}

	const runtime = body.runtime === undefined || body.runtime === null ? null : String(body.runtime);
	if (runtime !== null && !(AGENT_RUNTIMES as readonly string[]).includes(runtime)) {
		return bad(`Unknown runtime "${runtime}". One of: ${AGENT_RUNTIMES.join(", ")}.`);
	}

	const targetKind = body.targetKind === "environment" ? "environment" : body.targetKind === "repo" ? "repo" : null;
	const targetId = typeof body.targetId === "string" ? body.targetId : "";
	if (!targetKind) return bad("targetKind must be `repo` or `environment`.");
	if (!targetId) return bad("A target is required.");

	// Loaded with the org in the where — an id from another tenant misses here
	// rather than being filtered out downstream.
	const target =
		targetKind === "repo"
			? await db.query.repos.findFirst({
					where: and(eq(repos.id, targetId), eq(repos.orgId, session.orgId)),
				})
			: await db.query.environments.findFirst({
					where: and(eq(environments.id, targetId), eq(environments.orgId, session.orgId)),
				});
	if (!target) return bad(`No such ${targetKind} in this organisation.`, 404);

	const specInput = (typeof body.spec === "object" && body.spec !== null ? body.spec : {}) as Record<
		string,
		unknown
	>;

	let spec: Record<string, unknown>;
	if (source === "cron") {
		const expression = typeof specInput.expression === "string" ? specInput.expression.trim() : "";
		if (!expression) return bad("A cron automation needs a schedule expression.");
		const timezone = typeof specInput.timezone === "string" && specInput.timezone.trim()
			? specInput.timezone.trim()
			: "UTC";
		try {
			parseCron(expression);
			// nextRun also validates the timezone — an unknown IANA zone throws here
			// rather than at every tick.
			nextRun(expression, new Date(), timezone);
		} catch (error) {
			return bad(`Invalid schedule: ${(error as Error).message}`);
		}
		spec = { expression, timezone };
	} else {
		// Event source: webhook or sentry.
		if (!encryptionConfigured()) {
			return bad(
				"HARBOR_ENCRYPTION_KEY is not configured, so an event automation's signing "
					+ "secret cannot be stored. Set it and try again.",
				503,
			);
		}
		const secret = typeof specInput.secret === "string" ? specInput.secret.trim() : "";
		if (secret.length < 16) {
			return bad("An event automation needs a signing secret of at least 16 characters.");
		}
		// `parseConditions` reads from `{ conditions: [...] }`, so it validates and
		// discards malformed entries in one pass — the same normalisation the
		// evaluator applies at fire time, done once at creation.
		const conditions = parseConditions(specInput);
		spec = { secret: encrypt(secret), conditions };
	}

	const [created] = await db
		.insert(automations)
		.values({
			orgId: session.orgId,
			name,
			source,
			spec,
			targetKind,
			targetId,
			prompt,
			runtime,
			// Event automations never get a nextRunAt; cron computes it on the first
			// tick so creating one does not fire it immediately.
			nextRunAt: null,
		})
		.returning();

	// Never echo the secret back, even encrypted.
	const safeSpec = { ...(created!.spec as Record<string, unknown>) };
	delete safeSpec.secret;

	return NextResponse.json({ automation: { ...created!, spec: safeSpec } }, { status: 201 });
}
