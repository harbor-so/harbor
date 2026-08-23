// SPDX-License-Identifier: Apache-2.0
/**
 * These run against the real Postgres from docker-compose, not a mock.
 *
 * The whole coordination guarantee is a Postgres partial unique index and how
 * the code reacts to the violation it raises. A mocked database would assert
 * that the code does what the code does, and would have passed just as happily
 * with a read-then-write check that races. So: real transactions, real
 * concurrency, real index.
 */

import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, sql } from "../schema/index.js";
import { apiKeys, claims, events, orgs, projects, tasks } from "../schema/schema.js";
import {
	claim,
	createTask,
	listWork,
	presentAgents,
	release,
	renewClaim,
	revokeLease,
	sweepExpiredClaims,
	touchPresence,
	type ClaimOptions,
} from "./work.js";

let orgId: string;
let taskId: string;

beforeEach(async () => {
	// TRUNCATE CASCADE rather than ordered DELETEs: immune to foreign-key
	// ordering, and it resets cleanly even if a previous test left a connection
	// in a bad state.
	await sql`truncate table session_prompts, session_participants, sessions, runs, agent_presence, events, claims, tasks, projects, api_keys, digests, connectors, users, orgs cascade`;

	const [org] = await db.insert(orgs).values({ name: "Test Org" }).returning();
	orgId = org!.id;
	const [task] = await db
		.insert(tasks)
		.values({ orgId, title: "Fix auth token refresh bug", status: "open" })
		.returning();
	taskId = task!.id;
});

afterAll(async () => {
	await sql.end();
});

// Intent is required at mint now, so these behavioural tests would all fail the
// precondition if they kept calling claim() bare. `claimT` supplies a valid
// default intent (and still accepts a bare lease-minutes number for the tests
// that only care about lease length), so each test states only what it is about.
// Intent enforcement itself is tested directly against claim(), below.
const TEST_INTENT = "Test coordination path end to end.";
function claimT(
	org: string,
	ref: string,
	agentId: string,
	opts?: number | ClaimOptions,
): ReturnType<typeof claim> {
	if (opts === undefined) return claim(org, ref, agentId, { intent: TEST_INTENT });
	if (typeof opts === "number") {
		return claim(org, ref, agentId, { leaseMinutes: opts, intent: TEST_INTENT });
	}
	return claim(org, ref, agentId, { intent: TEST_INTENT, ...opts });
}

describe("claim", () => {
	it("gives exactly one winner when two agents race for the same task", async () => {
		const [first, second] = await Promise.all([
			claimT(orgId, taskId, "claude-code:wt-1"),
			claimT(orgId, taskId, "codex:wt-2"),
		]);

		const winners = [first, second].filter((r) => r.ok);
		const losers = [first, second].filter((r) => !r.ok);
		expect(winners).toHaveLength(1);
		expect(losers).toHaveLength(1);

		// The loser is told who holds it and until when — that is what lets it go
		// do something else instead of retrying blindly.
		const loser = losers[0]!;
		if (loser.ok) throw new Error("unreachable");
		expect(loser.conflict.agentId).toBe(winners[0]!.ok ? "claude-code:wt-1" : "codex:wt-2");
		expect(loser.conflict.expiresAt.getTime()).toBeGreaterThan(Date.now());
	});

	it("writes a claim_conflict event, which is the product's core metric", async () => {
		await claimT(orgId, taskId, "agent-a");
		await claimT(orgId, taskId, "agent-b");

		const conflicts = await db.query.events.findMany({
			where: and(eq(events.orgId, orgId), eq(events.type, "claim_conflict")),
		});
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]!.agentId).toBe("agent-b");
		expect(conflicts[0]!.payload).toMatchObject({ heldBy: "agent-a" });
	});

	it("survives ten agents racing at once with exactly one winner", async () => {
		const results = await Promise.all(
			Array.from({ length: 10 }, (_, i) => claimT(orgId, taskId, `agent-${i}`)),
		);
		expect(results.filter((r) => r.ok)).toHaveLength(1);

		const active = await db.query.claims.findMany({
			where: and(eq(claims.taskId, taskId), isNull(claims.releasedAt)),
		});
		expect(active).toHaveLength(1);
	});

	it("lets a new agent take over a task whose lease already lapsed", async () => {
		await claimT(orgId, taskId, "dead-agent", 1);
		await db
			.update(claims)
			.set({ expiresAt: new Date(Date.now() - 60_000) })
			.where(eq(claims.taskId, taskId));

		// Correctness must not depend on the sweeper having run.
		const result = await claimT(orgId, taskId, "fresh-agent");
		expect(result.ok).toBe(true);

		const expiredEvents = await db.query.events.findMany({
			where: and(eq(events.orgId, orgId), eq(events.type, "claim_expired")),
		});
		expect(expiredEvents.length).toBeGreaterThan(0);
	});

	it("accepts the short id an agent was shown", async () => {
		const short = taskId.replace(/-/g, "").slice(0, 4);
		expect((await claimT(orgId, short, "agent-a")).ok).toBe(true);
	});
});

describe("release", () => {
	it("marks a task completed when given a summary, open when not", async () => {
		await claimT(orgId, taskId, "agent-a");
		await release(orgId, taskId, "agent-a", "Serialised refresh behind a mutex.");
		expect((await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) }))!.status).toBe(
			"completed",
		);

		await claimT(orgId, taskId, "agent-b");
		await release(orgId, taskId, "agent-b");
		expect((await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) }))!.status).toBe(
			"open",
		);
	});

	it("refuses to release a claim held by someone else", async () => {
		await claimT(orgId, taskId, "agent-a");
		await expect(release(orgId, taskId, "agent-b")).rejects.toThrow(/held by agent-a/);
	});
});

describe("lease duration settings", () => {
	// leaseExpiry reads the settings at call time, so pinning the env inside a
	// test works without any module-cache gymnastics. Restore in finally: a
	// leaked HARBOR_LEASE_MINUTES would silently reshape every later suite.
	const withEnv = async (env: Record<string, string>, fn: () => Promise<void>) => {
		const saved = new Map(Object.entries(env).map(([k]) => [k, process.env[k]]));
		for (const [k, v] of Object.entries(env)) process.env[k] = v;
		try {
			await fn();
		} finally {
			for (const [k, v] of saved.entries()) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	};

	it("HARBOR_LEASE_MINUTES sets the default lease", async () => {
		await withEnv({ HARBOR_LEASE_MINUTES: "5" }, async () => {
			const before = Date.now();
			const result = await claimT(orgId, taskId, "agent-a");
			if (!result.ok) throw new Error("expected claim");
			const minutes = (result.expiresAt.getTime() - before) / 60_000;
			expect(minutes).toBeGreaterThan(4.9);
			expect(minutes).toBeLessThan(5.5);
		});
	});

	it("a requested lease is clamped to HARBOR_MAX_LEASE_MINUTES, not refused", async () => {
		await withEnv({ HARBOR_MAX_LEASE_MINUTES: "60" }, async () => {
			const before = Date.now();
			const result = await claimT(orgId, taskId, "agent-a", 480);
			if (!result.ok) throw new Error("expected claim");
			const minutes = (result.expiresAt.getTime() - before) / 60_000;
			expect(minutes).toBeGreaterThan(59.9);
			expect(minutes).toBeLessThan(60.5);
		});
	});

	it("renewClaim honours the configured default", async () => {
		const first = await claimT(orgId, taskId, "agent-a", 5);
		if (!first.ok) throw new Error("expected claim");
		await withEnv({ HARBOR_LEASE_MINUTES: "90" }, async () => {
			const before = Date.now();
			const renewed = await renewClaim(orgId, taskId, "agent-a");
			const minutes = (renewed.expiresAt.getTime() - before) / 60_000;
			expect(minutes).toBeGreaterThan(89.9);
			expect(minutes).toBeLessThan(90.5);
		});
	});
});

describe("renewClaim", () => {
	it("extends the lease for the holder and refuses everyone else", async () => {
		const first = await claimT(orgId, taskId, "agent-a", 5);
		if (!first.ok) throw new Error("expected claim");

		const renewed = await renewClaim(orgId, taskId, "agent-a", 60);
		expect(renewed.expiresAt.getTime()).toBeGreaterThan(first.expiresAt.getTime());
		await expect(renewClaim(orgId, taskId, "agent-b")).rejects.toThrow(/held by agent-a/);
	});
});

describe("sweepExpiredClaims", () => {
	it("returns a lapsed task to open and logs it", async () => {
		await claimT(orgId, taskId, "dead-agent", 1);
		await db
			.update(claims)
			.set({ expiresAt: new Date(Date.now() - 60_000) })
			.where(eq(claims.taskId, taskId));

		expect(await sweepExpiredClaims()).toBe(1);
		expect((await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) }))!.status).toBe(
			"open",
		);
		const swept = await db.query.events.findMany({
			where: and(eq(events.orgId, orgId), eq(events.type, "claim_expired")),
		});
		expect(swept).toHaveLength(1);
	});

	it("leaves a live claim alone", async () => {
		await claimT(orgId, taskId, "agent-a", 30);
		expect(await sweepExpiredClaims()).toBe(0);
	});
});

/**
 * The deployment that runs no loops.
 *
 * `startBackgroundLoops` belongs to the MCP server process; the Next.js app
 * deliberately starts nothing, because it is serverless-shaped and a timer there
 * is a promise the runtime cannot keep. So on a dashboard-only deployment the
 * periodic sweep never runs at all, and before these paths swept for themselves a
 * crashed agent held its scope until somebody happened to contend for that exact
 * task. That is the lease primitive not working, and it presents to a human as
 * "why is this ticket still claimed by an agent that died on Tuesday".
 *
 * Every test here calls the read paths WITHOUT ever calling `sweepExpiredClaims`,
 * because that is the deployment being modelled. A test that swept first would
 * pass against the bug.
 */
describe("lapsed leases converge with no background loop running", () => {
	async function lapse(agentId: string, task = taskId) {
		await claimT(orgId, task, agentId, 1);
		await db
			.update(claims)
			.set({ expiresAt: new Date(Date.now() - 60_000) })
			.where(and(eq(claims.taskId, task), isNull(claims.releasedAt)));
	}

	it("does not report a lapsed lease as held", async () => {
		await lapse("dead-agent");

		const [row] = await listWork(orgId);
		expect(row!.claim).toBeNull();
	});

	it("releases the row and reopens the task, so every other reader converges too", async () => {
		await lapse("dead-agent");

		await listWork(orgId);

		// The point of sweeping rather than only filtering the read: the dashboard,
		// the timeline and the next `claim` all see it, not just this caller.
		const active = await db.query.claims.findMany({
			where: and(eq(claims.taskId, taskId), isNull(claims.releasedAt)),
		});
		expect(active).toHaveLength(0);
		expect((await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) }))!.status).toBe("open");
	});

	it("writes exactly one claim_expired event however many times it is read", async () => {
		await lapse("dead-agent");

		await Promise.all([listWork(orgId), listWork(orgId), listWork(orgId)]);

		// Three concurrent readers, one release. The UPDATE's own predicate is the
		// compare-and-set: whichever transaction lands first flips `released_at`, and
		// the others match zero rows and write nothing. A second event here would
		// mean the timeline gains a duplicate every time anyone opens the dashboard.
		const expired = await db.query.events.findMany({
			where: and(eq(events.orgId, orgId), eq(events.type, "claim_expired")),
		});
		expect(expired).toHaveLength(1);
	});

	it("frees the scope for the next agent without a sweep in between", async () => {
		await lapse("dead-agent");

		const taken = await claimT(orgId, taskId, "live-agent");
		expect(taken.ok).toBe(true);
	});

	it("distinguishes a lease released on contention from one merely swept", async () => {
		await lapse("dead-agent");

		await claimT(orgId, taskId, "live-agent");

		const [expired] = await db.query.events.findMany({
			where: and(eq(events.orgId, orgId), eq(events.type, "claim_expired")),
		});
		// Somebody was waiting for this one. "Swept" would say nobody was, which is
		// the difference between a lease that was too short and an agent that died.
		expect((expired!.payload as { reason: string }).reason).toContain("contention");
	});

	it("does not touch another org's lapsed leases on a read", async () => {
		const [other] = await db.insert(orgs).values({ name: "Other Org" }).returning();
		const [otherTask] = await db
			.insert(tasks)
			.values({ orgId: other!.id, title: "Their work", status: "open" })
			.returning();
		await claimT(other!.id, otherTask!.id, "their-agent", 1);
		await db
			.update(claims)
			.set({ expiresAt: new Date(Date.now() - 60_000) })
			.where(and(eq(claims.taskId, otherTask!.id), isNull(claims.releasedAt)));

		await listWork(orgId);

		// Unbounded work on behalf of a tenant who did not ask, and one org's traffic
		// becoming another org's lock contention. The global loop does this; a read
		// serving one tenant must not.
		const theirs = await db.query.claims.findMany({
			where: and(eq(claims.taskId, otherTask!.id), isNull(claims.releasedAt)),
		});
		expect(theirs).toHaveLength(1);
	});
});

describe("listWork and createTask", () => {
	it("creates a project on demand rather than needing a sixth tool to ask", async () => {
		const created = await createTask(orgId, { title: "New work", project: "platform" });
		expect(created.project).toBe("platform");

		const again = await createTask(orgId, { title: "More work", project: "PLATFORM" });
		expect(again.project).toBe("platform");
		const rows = await db.query.projects.findMany({ where: eq(projects.orgId, orgId) });
		expect(rows).toHaveLength(1);
	});

	it("reports the live claim alongside each task", async () => {
		await claimT(orgId, taskId, "claude-code:wt-2", 22);
		const [row] = await listWork(orgId);
		expect(row!.claim?.agentId).toBe("claude-code:wt-2");
	});

	it("filters by project and status", async () => {
		await createTask(orgId, { title: "Backend thing", project: "backend" });
		expect(await listWork(orgId, { project: "backend" })).toHaveLength(1);
		expect(await listWork(orgId, { status: "open" })).toHaveLength(2);
	});
});

/**
 * The races that a five-agent review reproduced 39 times out of 40.
 *
 * These are regression tests for lost updates in `release` and `renewClaim`. The
 * shape is always the same: agent A's lease has lapsed but A is still working;
 * agent B claims the task legitimately; A then finishes and reports. Before the
 * `FOR UPDATE` lock, A's write landed anyway — so the task read as completed,
 * A's summary went into the weekly digest as shipped work, and B was left holding
 * a live claim on a task the product had already declared done.
 *
 * The precondition is ordinary, not adversarial: a thirty-minute lease running
 * out on a job that took longer.
 */
describe("lost updates against a concurrent claim", () => {
	async function lapsedClaimHeldBy(agentId: string) {
		await claimT(orgId, taskId, agentId, 1);
		await db
			.update(claims)
			.set({ expiresAt: new Date(Date.now() - 60_000) })
			.where(and(eq(claims.taskId, taskId), isNull(claims.releasedAt)));
	}

	it("refuses a release once another agent has taken the lapsed lease", async () => {
		await lapsedClaimHeldBy("agent-a");

		const [, releaseOutcome] = await Promise.allSettled([
			claimT(orgId, taskId, "agent-b"),
			release(orgId, taskId, "agent-a", "I finished it, honest."),
		]);

		const active = await db.query.claims.findMany({
			where: and(eq(claims.taskId, taskId), isNull(claims.releasedAt)),
		});
		const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });

		// The invariant is order-independent, which matters because both orderings
		// are legitimate: if A releases before B claims, A's release is valid and B
		// simply takes an open task. What must never happen is B holding a live
		// claim while the task reads `completed` from A's summary — that is the
		// state where the digest reports abandoned work as shipped and B is working
		// on something the product has already declared done.
		const corrupted =
			active.length === 1 && active[0]!.agentId === "agent-b" && task!.status === "completed";
		expect(corrupted, "B holds the task but A's release marked it completed").toBe(false);
		expect(active.length).toBeLessThanOrEqual(1);
		if (releaseOutcome.status === "rejected") {
			expect(String(releaseOutcome.reason)).toMatch(/taken by another agent|not currently claimed/);
		}
	});

	it("refuses a renew once another agent has taken the lapsed lease", async () => {
		await lapsedClaimHeldBy("agent-a");

		const [, renewOutcome] = await Promise.allSettled([
			claimT(orgId, taskId, "agent-b"),
			renewClaim(orgId, taskId, "agent-a", 480),
		]);

		const active = await db.query.claims.findMany({
			where: and(eq(claims.taskId, taskId), isNull(claims.releasedAt)),
		});
		expect(active).toHaveLength(1);
		// A's renew must never extend a lease that now belongs to B. An 8-hour
		// expiry on B's claim is the fingerprint of the lost update.
		if (active[0]!.agentId === "agent-b") {
			expect(
				active[0]!.expiresAt.getTime(),
				"A's renew extended B's lease",
			).toBeLessThan(Date.now() + 60 * 60_000);
		}
		if (renewOutcome.status === "rejected") {
			expect(String(renewOutcome.reason)).toMatch(/taken by another agent|held by|No task matching|no active claim/);
		}
	});

	it("never lets two agents hold one task across 30 interleaved rounds", async () => {
		for (let round = 0; round < 30; round += 1) {
			await sql`truncate table session_prompts, session_participants, sessions, runs, agent_presence, events, claims cascade`;
			await db.update(tasks).set({ status: "open" }).where(eq(tasks.id, taskId));
			await lapsedClaimHeldBy("agent-a");

			await Promise.allSettled([
				claimT(orgId, taskId, "agent-b"),
				release(orgId, taskId, "agent-a", "done"),
				renewClaim(orgId, taskId, "agent-a", 60),
			]);

			const active = await db.query.claims.findMany({
				where: and(eq(claims.taskId, taskId), isNull(claims.releasedAt)),
			});
			const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
			expect(active.length, `round ${round}: two live claims`).toBeLessThanOrEqual(1);
			const corrupted =
				active.length === 1 && active[0]!.agentId === "agent-b" && task!.status === "completed";
			expect(corrupted, `round ${round}: B holds a task marked completed by A`).toBe(false);
		}
	});
});

describe("resolveTaskId hardening", () => {
	it("refuses LIKE wildcards and the empty string instead of matching everything", async () => {
		for (const bad of ["", "%", "_", "____", "%%", "zzzz!"]) {
			await expect(claimT(orgId, bad, "agent-a"), `input ${JSON.stringify(bad)}`).rejects.toThrow(
				/not a task id|No task matching/,
			);
		}
	});

	it("still accepts a real short id and a full uuid", async () => {
		expect((await claimT(orgId, taskId.replace(/-/g, "").slice(0, 4), "agent-a")).ok).toBe(true);
		await release(orgId, taskId, "agent-a");
		expect((await claimT(orgId, taskId, "agent-b")).ok).toBe(true);
	});
});

describe("cross-tenant writes", () => {
	it("refuses to renew, release, or read another org's claim by its exact task uuid", async () => {
		const [other] = await db.insert(orgs).values({ name: "Victim Org" }).returning();
		const [victimTask] = await db
			.insert(tasks)
			.values({ orgId: other!.id, title: "Rotate production keys", status: "open" })
			.returning();
		await claimT(other!.id, victimTask!.id, "victim-agent", 5);

		// The attacker holds a valid key for their own org and the victim's task id.
		// renew simplified: no task pre-load, the org-scoped lock is the whole check,
		// so a cross-org uuid simply matches no active claim in the attacker's org.
		await expect(renewClaim(orgId, victimTask!.id, "victim-agent", 480)).rejects.toThrow(
			/no active claim/i,
		);
		// release from the wrong org must also refuse rather than free the victim's lease.
		await expect(release(orgId, victimTask!.id, "victim-agent", "done")).rejects.toThrow();
		// and the victim's task never appears in the attacker's listing.
		expect((await listWork(orgId)).some((t) => t.id === victimTask!.id)).toBe(false);

		const held = await db.query.claims.findFirst({
			where: and(eq(claims.taskId, victimTask!.id), isNull(claims.releasedAt)),
		});
		// The victim's lease is untouched — still held, still ~5 minutes out.
		expect(held).toBeDefined();
		expect(held!.agentId).toBe("victim-agent");
		expect(held!.expiresAt.getTime()).toBeLessThan(Date.now() + 30 * 60_000);
	});
});

describe("intent", () => {
	it("records why the work is happening and shows it to the next agent", async () => {
		await claimT(orgId, taskId, "agent-a", {
			intent: "Blocking three support tickets; fix before Friday.",
			intentRef: "https://linear.app/acme/issue/ACM-482",
		});

		const [row] = await listWork(orgId);
		expect(row!.claim?.intent).toBe("Blocking three support tickets; fix before Friday.");
		// The reason belongs to the attempt, so it must survive on the claim row
		// even after the work is finished — that is the whole point of putting it
		// there rather than on the task.
		await release(orgId, taskId, "agent-a", "Fixed.");
		const stored = await db.query.claims.findFirst({ where: eq(claims.taskId, taskId) });
		expect(stored!.intent).toContain("support tickets");
		expect(stored!.intentRef).toContain("linear.app");
	});

	it("honours an explicit lease length", async () => {
		const result = await claimT(orgId, taskId, "agent-a", 5);
		if (!result.ok) throw new Error("expected claim");
		expect(result.expiresAt.getTime()).toBeLessThan(Date.now() + 6 * 60_000);
	});

	it("refuses a claim with no intent, or one under the minimum length", async () => {
		// Enforced in the kernel, not just the MCP schema — it must be impossible to
		// hold a lease without a reason no matter which caller reaches claim().
		await expect(claim(orgId, taskId, "agent-a")).rejects.toThrow(/intent/i);
		await expect(claim(orgId, taskId, "agent-a", { intent: "too short" })).rejects.toThrow(
			/at least/i,
		);
		// And a real one is accepted.
		expect((await claim(orgId, taskId, "agent-a", { intent: TEST_INTENT })).ok).toBe(true);
	});
});

describe("scope", () => {
	it("leases a Linear task by its external identity and a native task by its id", async () => {
		const [linearTask] = await db
			.insert(tasks)
			.values({
				orgId,
				title: "Ship the billing fix",
				source: "linear",
				sourceRef: "ENG-4471",
				status: "open",
			})
			.returning();
		await claimT(orgId, linearTask!.id, "agent-a");
		await claimT(orgId, taskId, "agent-b");

		const linearClaim = await db.query.claims.findFirst({
			where: eq(claims.taskId, linearTask!.id),
		});
		const nativeClaim = await db.query.claims.findFirst({ where: eq(claims.taskId, taskId) });
		expect(linearClaim!.scope).toBe("linear:ENG-4471");
		expect(nativeClaim!.scope).toBe(`harbor:${taskId}`);
		// Every lease is minted read+write for now.
		expect(nativeClaim!.rights.sort()).toEqual(["read", "write"]);
	});
});

describe("lease delegation", () => {
	it("revoking a parent cascades to its children, and stays within the org", async () => {
		// Delegation has no minting path yet, so the tree is built directly: a parent
		// lease and two children pointing at it, one of them with a grandchild.
		const now = new Date();
		const [parent] = await db
			.insert(claims)
			.values({
				orgId,
				scope: "github:acme/api#src/**",
				agentId: "lead",
				rights: ["read", "write"],
				intent: "Own the billing refactor and delegate slices of it.",
				expiresAt: new Date(now.getTime() + 3_600_000),
			})
			.returning();
		const [childA] = await db
			.insert(claims)
			.values({
				orgId,
				scope: "github:acme/api#src/billing/**",
				agentId: "worker-a",
				parentLeaseId: parent!.id,
				rights: ["read", "write"],
				intent: "Handle the billing subtree under the lead's lease.",
				expiresAt: new Date(now.getTime() + 3_600_000),
			})
			.returning();
		const [grandchild] = await db
			.insert(claims)
			.values({
				orgId,
				scope: "github:acme/api#src/billing/invoice.ts",
				agentId: "worker-a2",
				parentLeaseId: childA!.id,
				rights: ["read"],
				intent: "Just the invoice file, narrowed from the billing lease.",
				expiresAt: new Date(now.getTime() + 3_600_000),
			})
			.returning();

		// A lease in another org that must be untouched by this revocation.
		const [other] = await db.insert(orgs).values({ name: "Other Co" }).returning();
		const [foreign] = await db
			.insert(claims)
			.values({
				orgId: other!.id,
				scope: "github:acme/api#src/**",
				agentId: "outsider",
				intent: "A same-scope lease in a different tenant.",
				expiresAt: new Date(now.getTime() + 3_600_000),
			})
			.returning();

		const { revoked } = await revokeLease(orgId, parent!.id);
		expect(revoked).toBe(3);

		const stillActive = async (id: string) =>
			(await db.query.claims.findFirst({ where: eq(claims.id, id) }))!.releasedAt === null;
		expect(await stillActive(parent!.id)).toBe(false);
		expect(await stillActive(childA!.id)).toBe(false);
		expect(await stillActive(grandchild!.id)).toBe(false);
		// The other tenant's lease with the same scope is untouched.
		expect(await stillActive(foreign!.id)).toBe(true);
	});

	it("refuses to revoke a lease in another org", async () => {
		const [other] = await db.insert(orgs).values({ name: "Victim" }).returning();
		const [foreign] = await db
			.insert(claims)
			.values({
				orgId: other!.id,
				scope: "harbor:xyz",
				agentId: "victim",
				intent: "A lease that belongs to someone else.",
				expiresAt: new Date(Date.now() + 3_600_000),
			})
			.returning();
		const { revoked } = await revokeLease(orgId, foreign!.id);
		expect(revoked).toBe(0);
		const row = await db.query.claims.findFirst({ where: eq(claims.id, foreign!.id) });
		expect(row!.releasedAt).toBeNull();
	});
});

describe("presence", () => {
	it("reports an agent as present after any tool call and drops it when stale", async () => {
		await touchPresence(orgId, "claude-code:wt-9", "claim");
		const present = await presentAgents(orgId);
		expect(present.map((a) => a.agentId)).toContain("claude-code:wt-9");

		await sql`update agent_presence set last_seen_at = now() - interval '10 minutes'`;
		expect((await presentAgents(orgId)).map((a) => a.agentId)).not.toContain("claude-code:wt-9");
	});

	it("keeps presence scoped to one org", async () => {
		const [other] = await db.insert(orgs).values({ name: "Other" }).returning();
		await touchPresence(other!.id, "someone-elses-agent", "claim");
		await touchPresence(orgId, "my-agent", "claim");
		expect((await presentAgents(orgId)).map((a) => a.agentId)).toEqual(["my-agent"]);
	});
})
