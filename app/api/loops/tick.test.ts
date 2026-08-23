// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The maintenance tick, against the real database.
 *
 * This endpoint exists because the Next.js app runs no background loops — it is
 * serverless-shaped, so a timer there is a promise the runtime cannot keep. On a
 * dashboard-only deployment nothing ever swept an expired lease, a deadline or an
 * event log, and this is what an external cron points at instead.
 *
 * The auth cases are the substance. A global maintenance endpoint reachable with
 * a tenant's credential would let any org trigger work across every other org, so
 * the interesting assertions are the ones about who is refused.
 */

import { and, eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, sql } from "@core/schema/index.js";
import { claims, events, orgs, tasks } from "@core/schema/schema.js";
import { claim } from "@core/kernel/work.js";
import { POST } from "./tick/route.js";

const TOKEN = "maintenance-token-for-tests";

let orgId: string;
let taskId: string;

beforeEach(async () => {
	await sql`truncate table cost_events, circuit_breakers, automation_runs, automations, artifacts, session_events, sandboxes, session_repos, secrets, user_scm_tokens, environment_repos, environments, repos, activity, session_prompts, session_participants, sessions, runs, agent_presence, events, claims, tasks, projects, api_keys, digests, connectors, users, orgs cascade`;
	const [org] = await db.insert(orgs).values({ name: "Tick Org" }).returning();
	orgId = org!.id;
	const [task] = await db
		.insert(tasks)
		.values({ orgId, title: "Work an agent died holding", status: "open" })
		.returning();
	taskId = task!.id;
});

afterEach(() => {
	delete process.env.HARBOR_MAINTENANCE_TOKEN;
});

afterAll(async () => {
	await sql.end();
});

function tick(headers: Record<string, string> = {}): Promise<Response> {
	return POST(new Request("http://localhost/api/loops/tick", { method: "POST", headers }));
}

describe("who may run a maintenance tick", () => {
	it("answers 503, not 401, when no token is configured", async () => {
		const response = await tick({ authorization: `Bearer ${TOKEN}` });

		// The distinction is the whole point of the case. 401 sends an operator
		// looking for a wrong token; this deployment has not enabled the feature at
		// all, and the body has to say which of the two it is.
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ reason: "not_configured" });
	});

	it("refuses a request with no token", async () => {
		process.env.HARBOR_MAINTENANCE_TOKEN = TOKEN;

		const response = await tick();

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ reason: "token_invalid" });
	});

	it("refuses a wrong token, including one that is merely a prefix", async () => {
		process.env.HARBOR_MAINTENANCE_TOKEN = TOKEN;

		expect((await tick({ authorization: "Bearer wrong" })).status).toBe(401);
		// A length-equal comparison that returned early would accept this; the
		// constant-time compare in `secretEquals` is what makes it a 401.
		expect((await tick({ authorization: `Bearer ${TOKEN.slice(0, -1)}` })).status).toBe(401);
	});

	it("accepts the header alternative, for crons that cannot set Authorization", async () => {
		process.env.HARBOR_MAINTENANCE_TOKEN = TOKEN;

		expect((await tick({ "x-harbor-maintenance-token": TOKEN })).status).toBe(200);
	});
});

describe("what a tick actually does", () => {
	async function lapsedLease() {
		await claim(orgId, taskId, "dead-agent", {
			intent: "Reproduce the crash before the lease runs out.",
			leaseMinutes: 1,
		});
		await db
			.update(claims)
			.set({ expiresAt: new Date(Date.now() - 60_000) })
			.where(and(eq(claims.taskId, taskId), isNull(claims.releasedAt)));
	}

	it("sweeps a lapsed lease nobody has read or contended for", async () => {
		process.env.HARBOR_MAINTENANCE_TOKEN = TOKEN;
		await lapsedLease();

		const response = await tick({ authorization: `Bearer ${TOKEN}` });
		expect(response.status).toBe(200);

		const active = await db.query.claims.findMany({
			where: and(eq(claims.taskId, taskId), isNull(claims.releasedAt)),
		});
		expect(active).toHaveLength(0);
		expect((await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) }))!.status).toBe("open");
		const expired = await db.query.events.findMany({
			where: and(eq(events.orgId, orgId), eq(events.type, "claim_expired")),
		});
		expect(expired).toHaveLength(1);
	});

	it("reports a verdict per loop, named, rather than one opaque status", async () => {
		process.env.HARBOR_MAINTENANCE_TOKEN = TOKEN;

		const body = (await (await tick({ authorization: `Bearer ${TOKEN}` })).json()) as {
			ok: boolean;
			loops: Array<{ name: string; ok: boolean }>;
		};

		// An operator reading a cron log needs to know WHICH sweep is failing. A bare
		// 500 would also make the cron retry the loops that worked.
		expect(body.ok).toBe(true);
		expect(body.loops.map((entry) => entry.name).sort()).toEqual([
			"automations",
			"claims",
			"compaction",
			"deadlines",
			"devin",
			"images",
			"orphans",
			"pull_requests",
			"sessions",
		]);
	});

	it("is safe to run twice concurrently, as a cron with overlapping runs will", async () => {
		process.env.HARBOR_MAINTENANCE_TOKEN = TOKEN;
		await lapsedLease();

		const [first, second] = await Promise.all([
			tick({ authorization: `Bearer ${TOKEN}` }),
			tick({ authorization: `Bearer ${TOKEN}` }),
		]);

		expect(first!.status).toBe(200);
		expect(second!.status).toBe(200);
		// One release, one event, however many ticks raced for it.
		const expired = await db.query.events.findMany({
			where: and(eq(events.orgId, orgId), eq(events.type, "claim_expired")),
		});
		expect(expired).toHaveLength(1);
	});
});
