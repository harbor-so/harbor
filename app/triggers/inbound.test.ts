// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Inbound event delivery, against the real database — because the idempotency
 * guarantee is the partial unique index on `automation_runs (automation_id,
 * dedupe_key)`, and a mock happily passes a read-then-write dedupe check that
 * races exactly when a retry storm makes it matter.
 *
 * The suite asserts the two things that keep this endpoint from being a spawn
 * primitive: an unauthenticated caller cannot fire anything (every auth failure is
 * an indistinguishable 401 and creates no rows), and an authentic-but-shouldn't
 * delivery — filtered, paused, over budget, already seen — creates no session and
 * never counts toward auto-pause.
 */

// A valid 32-byte key, set before any crypto call. The event secret is stored
// encrypted, so the whole suite needs one.
process.env.HARBOR_ENCRYPTION_KEY = Buffer.from(
	"0123456789abcdef0123456789abcdef",
).toString("base64");

import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, sql } from "@core/schema/index.js";
import {
	automationRuns,
	automations,
	environmentRepos,
	environments,
	orgs,
	repos,
	sessions,
} from "@core/schema/schema.js";
import { encrypt } from "../lib/crypto.js";
import { deliverEvent } from "./inbound.js";
import { tickAutomations } from "./automations.js";

const SECRET = "a-signing-secret-at-least-16-chars";

let orgId: string;
let repoId: string;

beforeEach(async () => {
	await sql`truncate table cost_events, circuit_breakers, automation_runs, automations, artifacts, session_events, sandboxes, session_repos, secrets, user_scm_tokens, environment_repos, environments, repos, activity, session_prompts, session_participants, sessions, runs, agent_presence, events, claims, tasks, projects, api_keys, digests, connectors, users, orgs cascade`;
	const [org] = await db.insert(orgs).values({ name: "Trigger Test Org" }).returning();
	orgId = org!.id;
	const [repo] = await db
		.insert(repos)
		.values({ orgId, provider: "github", owner: "acme", name: "web" })
		.returning();
	repoId = repo!.id;
});

afterAll(async () => {
	await sql.end();
});

type NewAutomation = {
	source?: string;
	conditions?: unknown[];
	enabled?: boolean;
	pausedReason?: string | null;
	targetKind?: "repo" | "environment";
	targetId?: string;
	withSecret?: boolean;
};

async function makeAutomation(options: NewAutomation = {}) {
	const source = options.source ?? "webhook";
	const spec: Record<string, unknown> = { conditions: options.conditions ?? [] };
	if (options.withSecret !== false) spec.secret = encrypt(SECRET);
	const [row] = await db
		.insert(automations)
		.values({
			orgId,
			name: "Test automation",
			source,
			spec,
			targetKind: options.targetKind ?? "repo",
			targetId: options.targetId ?? repoId,
			prompt: "Do the thing.",
			enabled: options.enabled ?? true,
			pausedReason: options.pausedReason ?? null,
		})
		.returning();
	return row!;
}

function signed(
	source: string,
	payload: unknown,
	extraHeaders: Record<string, string> = {},
	key = SECRET,
) {
	const raw = JSON.stringify(payload);
	const hex = createHmac("sha256", key).update(raw).digest("hex");
	const headers: Record<string, string | undefined> =
		source === "sentry"
			? { "sentry-hook-signature": hex }
			: { "x-harbor-signature": `sha256=${hex}` };
	return { raw, headers: { ...headers, ...extraHeaders } };
}

async function runCount(automationId: string) {
	const rows = await db.query.automationRuns.findMany({
		where: eq(automationRuns.automationId, automationId),
	});
	return rows.length;
}

async function sessionCount() {
	return (await db.query.sessions.findMany({ where: eq(sessions.orgId, orgId) })).length;
}

describe("deliverEvent — authentication", () => {
	it("rejects a wrong-secret signature with 401 and no rows", async () => {
		const automation = await makeAutomation();
		const { raw, headers } = signed("webhook", { branch: "main" }, {}, "the-wrong-secret");
		const result = await deliverEvent({ source: "webhook", automationId: automation.id, raw, headers });
		expect(result.status).toBe(401);
		expect(result.fired).toBe(false);
		expect(await runCount(automation.id)).toBe(0);
		expect(await sessionCount()).toBe(0);
	});

	it("returns 401 for an unknown id, indistinguishable from a bad signature", async () => {
		const { raw, headers } = signed("webhook", { branch: "main" });
		const result = await deliverEvent({
			source: "webhook",
			automationId: "00000000-0000-0000-0000-000000000000",
			raw,
			headers,
		});
		expect(result.status).toBe(401);
	});

	it("returns 404 for an unknown source", async () => {
		const automation = await makeAutomation();
		const { raw, headers } = signed("webhook", { branch: "main" });
		const result = await deliverEvent({ source: "jira", automationId: automation.id, raw, headers });
		expect(result.status).toBe(404);
	});

	it("returns 401 when the delivered source does not match the automation's", async () => {
		const automation = await makeAutomation({ source: "webhook" });
		// Sign as sentry but the row is a webhook automation.
		const { raw, headers } = signed("sentry", { action: "created" });
		const result = await deliverEvent({ source: "sentry", automationId: automation.id, raw, headers });
		expect(result.status).toBe(401);
	});

	it("returns 401 with no rows when the automation has no stored secret", async () => {
		const automation = await makeAutomation({ withSecret: false });
		const { raw, headers } = signed("webhook", { branch: "main" });
		const result = await deliverEvent({ source: "webhook", automationId: automation.id, raw, headers });
		expect(result.status).toBe(401);
		expect(await runCount(automation.id)).toBe(0);
	});
});

describe("deliverEvent — gating", () => {
	it("fires on a matching condition and creates exactly one session, org-scoped", async () => {
		const automation = await makeAutomation({
			conditions: [{ field: "branch", operator: "exact", value: "main" }],
		});
		const { raw, headers } = signed("webhook", { branch: "main", title: "x" });
		const result = await deliverEvent({ source: "webhook", automationId: automation.id, raw, headers });
		expect(result).toMatchObject({ status: 200, fired: true });
		expect(await runCount(automation.id)).toBe(1);
		const created = await db.query.sessions.findMany({ where: eq(sessions.orgId, orgId) });
		expect(created).toHaveLength(1);
		expect(created[0]!.orgId).toBe(orgId);
		expect(created[0]!.repoId).toBe(repoId);
	});

	it("skips (200) when a condition does not match and creates nothing", async () => {
		const automation = await makeAutomation({
			conditions: [{ field: "branch", operator: "exact", value: "main" }],
		});
		const { raw, headers } = signed("webhook", { branch: "dev" });
		const result = await deliverEvent({ source: "webhook", automationId: automation.id, raw, headers });
		expect(result).toMatchObject({ status: 200, fired: false, reason: "filtered" });
		expect(await runCount(automation.id)).toBe(0);
		expect(await sessionCount()).toBe(0);
	});

	it("does not fire a disabled automation", async () => {
		const automation = await makeAutomation({ enabled: false });
		const { raw, headers } = signed("webhook", { branch: "main" });
		const result = await deliverEvent({ source: "webhook", automationId: automation.id, raw, headers });
		expect(result).toMatchObject({ status: 200, fired: false, reason: "disabled" });
		expect(await runCount(automation.id)).toBe(0);
	});

	it("does not fire a paused automation and leaves its failure count untouched", async () => {
		const automation = await makeAutomation({ pausedReason: "Paused after 3 failures." });
		const { raw, headers } = signed("webhook", { branch: "main" });
		const result = await deliverEvent({ source: "webhook", automationId: automation.id, raw, headers });
		expect(result).toMatchObject({ status: 200, fired: false, reason: "paused" });
		expect(await runCount(automation.id)).toBe(0);
		const [after] = await db
			.select()
			.from(automations)
			.where(eq(automations.id, automation.id));
		expect(after!.consecutiveFailures).toBe(0);
	});

	it("sheds a delivery when the budget is exhausted, without a run or a failure strike", async () => {
		const automation = await makeAutomation();
		const previous = process.env.HARBOR_MAX_SPEND_PER_DAY_MICRO_USD;
		process.env.HARBOR_MAX_SPEND_PER_DAY_MICRO_USD = "0";
		try {
			const { raw, headers } = signed("webhook", { branch: "main" });
			const result = await deliverEvent({ source: "webhook", automationId: automation.id, raw, headers });
			expect(result).toMatchObject({ status: 200, fired: false, reason: "budget" });
			expect(await runCount(automation.id)).toBe(0);
			const [after] = await db
				.select()
				.from(automations)
				.where(eq(automations.id, automation.id));
			expect(after!.consecutiveFailures).toBe(0);
		} finally {
			if (previous === undefined) delete process.env.HARBOR_MAX_SPEND_PER_DAY_MICRO_USD;
			else process.env.HARBOR_MAX_SPEND_PER_DAY_MICRO_USD = previous;
		}
	});

	it("filters a Sentry alert by event type via a folded label condition", async () => {
		const automation = await makeAutomation({
			source: "sentry",
			conditions: [{ field: "label", operator: "any_of", value: ["action:created"] }],
		});
		const fired = signed("sentry", {
			action: "created",
			data: { issue: { id: "1", title: "Boom", level: "error" } },
		});
		expect(
			await deliverEvent({ source: "sentry", automationId: automation.id, ...fired }),
		).toMatchObject({ fired: true });

		const ignored = signed("sentry", {
			action: "resolved",
			data: { issue: { id: "2", title: "Fixed", level: "info" } },
		});
		expect(
			await deliverEvent({ source: "sentry", automationId: automation.id, ...ignored }),
		).toMatchObject({ fired: false, reason: "filtered" });
	});
});

describe("deliverEvent — idempotency and rate", () => {
	it("collapses a redelivered event to one session via the dedupe index", async () => {
		const automation = await makeAutomation();
		const first = signed("webhook", { branch: "main" }, { "x-harbor-delivery-id": "delivery-1" });
		const one = await deliverEvent({ source: "webhook", automationId: automation.id, ...first });
		expect(one).toMatchObject({ fired: true });

		// Same delivery id, retried — a real sender re-POSTs a 5xx.
		const retry = signed("webhook", { branch: "main" }, { "x-harbor-delivery-id": "delivery-1" });
		const two = await deliverEvent({ source: "webhook", automationId: automation.id, ...retry });
		expect(two).toMatchObject({ status: 200, fired: false, reason: "duplicate" });

		expect(await runCount(automation.id)).toBe(1);
		expect(await sessionCount()).toBe(1);
	});

	it("sheds deliveries past the per-minute cap", async () => {
		const automation = await makeAutomation();
		const previous = process.env.HARBOR_TRIGGER_MAX_RUNS_PER_MINUTE_PER_AUTOMATION;
		process.env.HARBOR_TRIGGER_MAX_RUNS_PER_MINUTE_PER_AUTOMATION = "1";
		try {
			const first = signed("webhook", { branch: "main" }, { "x-harbor-delivery-id": "d1" });
			expect(
				await deliverEvent({ source: "webhook", automationId: automation.id, ...first }),
			).toMatchObject({ fired: true });
			const second = signed("webhook", { branch: "main" }, { "x-harbor-delivery-id": "d2" });
			expect(
				await deliverEvent({ source: "webhook", automationId: automation.id, ...second }),
			).toMatchObject({ status: 200, fired: false, reason: "rate_limited" });
		} finally {
			if (previous === undefined) delete process.env.HARBOR_TRIGGER_MAX_RUNS_PER_MINUTE_PER_AUTOMATION;
			else process.env.HARBOR_TRIGGER_MAX_RUNS_PER_MINUTE_PER_AUTOMATION = previous;
		}
	});
});

describe("deliverEvent — multi-repo fan-out", () => {
	it("fires one session across an environment's repositories", async () => {
		const [repoTwo] = await db
			.insert(repos)
			.values({ orgId, provider: "github", owner: "acme", name: "api" })
			.returning();
		const [environment] = await db
			.insert(environments)
			.values({ orgId, name: "stack" })
			.returning();
		await db.insert(environmentRepos).values([
			{ orgId, environmentId: environment!.id, repoId, position: 0 },
			{ orgId, environmentId: environment!.id, repoId: repoTwo!.id, position: 1 },
		]);
		const automation = await makeAutomation({
			targetKind: "environment",
			targetId: environment!.id,
		});
		const { raw, headers } = signed("webhook", { branch: "main" });
		const result = await deliverEvent({ source: "webhook", automationId: automation.id, raw, headers });
		expect(result).toMatchObject({ fired: true });
		const created = await db.query.sessions.findMany({ where: eq(sessions.orgId, orgId) });
		expect(created).toHaveLength(1);
		expect(created[0]!.environmentId).toBe(environment!.id);
		expect(created[0]!.repoId).toBeNull();
	});
});

describe("scheduler tick — event automations are not clock-driven", () => {
	it("never selects, runs, or stamps an event automation", async () => {
		const automation = await makeAutomation({ source: "webhook" });
		await tickAutomations(new Date());
		const [after] = await db
			.select()
			.from(automations)
			.where(eq(automations.id, automation.id));
		expect(after!.lastRunAt).toBeNull();
		expect(after!.nextRunAt).toBeNull();
		expect(await runCount(automation.id)).toBe(0);
	});
});
