// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The automation creation endpoint, against the real database.
 *
 * `currentSession` reads a cookie through `next/headers`, which has no request
 * scope in a unit test, so the cookie accessor is stubbed to "no cookie" and the
 * route falls through to the dev-login bypass — which resolves to the first org
 * in the database. That is exactly the org each case seeds first, so the session
 * the route sees is this org, and the cross-tenant case can prove that a target
 * belonging to a *second* org is refused.
 */

process.env.HARBOR_ENCRYPTION_KEY = Buffer.from(
	"0123456789abcdef0123456789abcdef",
).toString("base64");

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
	cookies: async () => ({ get: () => undefined }),
}));

import { eq } from "drizzle-orm";
import { db, sql } from "@core/schema/index.js";
import { automations, orgs, repos } from "@core/schema/schema.js";
import { POST } from "./route.js";

let orgId: string;
let repoId: string;

beforeEach(async () => {
	await sql`truncate table cost_events, circuit_breakers, automation_runs, automations, artifacts, session_events, sandboxes, session_repos, secrets, user_scm_tokens, environment_repos, environments, repos, activity, session_prompts, session_participants, sessions, runs, agent_presence, events, claims, tasks, projects, api_keys, digests, connectors, users, orgs cascade`;
	// The bypass resolves to the earliest-created org, so this must be inserted first.
	const [org] = await db.insert(orgs).values({ name: "Primary Org" }).returning();
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

function post(body: unknown) {
	return POST(
		new Request("http://localhost/api/automations", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
}

describe("POST /api/automations", () => {
	it("rejects an invalid cron expression with the parser's message", async () => {
		const response = await post({
			name: "Nightly",
			source: "cron",
			targetKind: "repo",
			targetId: repoId,
			prompt: "sweep deps",
			spec: { expression: "not a cron" },
		});
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string };
		expect(body.error).toMatch(/schedule/i);
	});

	it("requires a signing secret for an event automation", async () => {
		const response = await post({
			name: "Webhook",
			source: "webhook",
			targetKind: "repo",
			targetId: repoId,
			prompt: "handle it",
			spec: { conditions: [] },
		});
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string };
		expect(body.error).toMatch(/secret/i);
	});

	it("refuses a target that belongs to another organisation", async () => {
		const [other] = await db.insert(orgs).values({ name: "Other Org" }).returning();
		const [otherRepo] = await db
			.insert(repos)
			.values({ orgId: other!.id, provider: "github", owner: "them", name: "secret" })
			.returning();
		const response = await post({
			name: "Cross-tenant",
			source: "cron",
			targetKind: "repo",
			targetId: otherRepo!.id,
			prompt: "should not run",
			spec: { expression: "0 9 * * 1" },
		});
		expect(response.status).toBe(404);
	});

	it("creates a cron automation and leaves nextRunAt null", async () => {
		const response = await post({
			name: "Monday sweep",
			source: "cron",
			targetKind: "repo",
			targetId: repoId,
			prompt: "sweep deps",
			spec: { expression: "0 9 * * 1", timezone: "UTC" },
		});
		expect(response.status).toBe(201);
		const rows = await db.select().from(automations).where(eq(automations.orgId, orgId));
		expect(rows).toHaveLength(1);
		expect(rows[0]!.source).toBe("cron");
		expect(rows[0]!.nextRunAt).toBeNull();
	});

	it("creates an event automation and never echoes the secret", async () => {
		const response = await post({
			name: "Sentry triage",
			source: "sentry",
			targetKind: "repo",
			targetId: repoId,
			prompt: "triage it",
			spec: { secret: "a-signing-secret-at-least-16-chars", conditions: [] },
		});
		expect(response.status).toBe(201);
		const body = (await response.json()) as { automation: { spec: Record<string, unknown> } };
		expect(body.automation.spec.secret).toBeUndefined();
		// …but it is stored, encrypted, so the endpoint can verify future deliveries.
		const [stored] = await db.select().from(automations).where(eq(automations.orgId, orgId));
		expect(typeof (stored!.spec as { secret?: string }).secret).toBe("string");
	});
});
