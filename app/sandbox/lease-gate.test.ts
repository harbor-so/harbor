// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Destruction fails closed on authority.
 *
 * The rule under test, from ADR 0003 and `evaluateDestruction`: an unknown or
 * unreadable lease is treated as NOT-abandoned for destruction. This is the
 * direction a tidy-minded contributor will read as an inconsistency — liveness
 * fails open, spawn-granting fails closed, and destruction *also* fails closed
 * — and it is the one most likely to be "fixed", because deferring a reap looks
 * like a bug when you have not considered that the alternative is killing a
 * sandbox whose lease holder is mid-flight, with no undo.
 *
 * Before this suite existed the rule was not implemented at all: no destruction
 * path read the lease. `onInactivity`, `onStaleHeartbeat` and
 * `onConnectingTimeout` destroyed on liveness verdicts alone, so a claims table
 * that answered anything — or nothing — never changed what got destroyed.
 *
 * The unreadable-lease cases use the `readLease` seam on `SweepOptions`,
 * because a test cannot make a healthy Postgres fail one specific query. The
 * seam is the same function shape the production default implements against
 * the claims table, and the leaseless/held/released cases below run against
 * the real table to keep the seam honest.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, sql } from "@core/schema/index.js";
import { claims, orgs, sandboxes, sessionEvents, sessions, tasks } from "@core/schema/schema.js";
import { claim, createTask, release } from "@core/kernel/work.js";
import { createSession } from "../lib/sessions.js";
import {
	ensureSandbox,
	markSandboxReady,
	onConnectingTimeout,
	onInactivity,
	onStaleHeartbeat,
	readLeaseState,
} from "./manager.js";
import type {
	CreateSandboxConfig,
	CreatedSandbox,
	SandboxInspection,
	SandboxProvider,
} from "./provider.js";

let orgId: string;

function inspection(externalId: string, attemptId: string): SandboxInspection {
	return {
		externalId,
		provider: "fake",
		state: "running",
		rawState: "running",
		attemptId,
		sessionId: null,
		sandboxId: null,
		startedAt: new Date().toISOString(),
		exitCode: null,
	};
}

function fakeProvider() {
	const created: Array<{ attemptId: string; externalId: string }> = [];
	let stopCalls = 0;
	let findCalls = 0;

	const provider: SandboxProvider = {
		kind: "ephemeral",
		name: "fake",
		capabilities: {
			supportsSandboxTimeout: true,
			supportsSnapshots: false,
			supportsRestore: false,
		},
		async create(config: CreateSandboxConfig): Promise<CreatedSandbox> {
			const externalId = `ext-${created.length + 1}`;
			created.push({ attemptId: config.attemptId, externalId });
			return {
				externalId,
				provider: "fake",
				attemptId: config.attemptId,
				state: "running",
				createdAt: new Date().toISOString(),
			};
		},
		async findByAttemptId(attemptId: string): Promise<SandboxInspection | null> {
			findCalls += 1;
			const hit = created.find((row) => row.attemptId === attemptId);
			return hit ? inspection(hit.externalId, hit.attemptId) : null;
		},
		async inspect(externalId: string): Promise<SandboxInspection | null> {
			const hit = created.find((row) => row.externalId === externalId);
			return hit ? inspection(hit.externalId, hit.attemptId) : null;
		},
		async stop() {
			stopCalls += 1;
			return "stopped" as const;
		},
		supportedFeatures: [],
	} as unknown as SandboxProvider;

	return {
		provider,
		created,
		get stopCalls() {
			return stopCalls;
		},
		get findCalls() {
			return findCalls;
		},
	};
}

/** A session backed by a task, with a ready sandbox that has gone idle. */
async function idleTaskSession(fake: ReturnType<typeof fakeProvider>) {
	const created = await createTask(orgId, { title: "Gate me" });
	const session = await createSession({
		orgId,
		title: "Gated",
		createdBy: "rin",
		taskId: created.id,
	});
	const claimed = await claim(orgId, created.id, "runner:gate", { intent: "Hold this task for the sandbox test." });
	if (!claimed.ok) throw new Error("expected claim");

	const outcome = await ensureSandbox({
		orgId,
		sessionId: session.id,
		claimId: claimed.claimId,
		provider: fake.provider,
	});
	if (outcome.kind !== "created") throw new Error(`expected created, got ${outcome.kind}`);
	await markSandboxReady(outcome.sandbox_id);

	// Idle for a day, heartbeat fresh — squarely in onInactivity's jurisdiction.
	await db
		.update(sessions)
		.set({ lastActivityAt: new Date(Date.now() - 24 * 3_600_000) })
		.where(eq(sessions.id, session.id));

	return { session, taskId: created.id, sandboxId: outcome.sandbox_id, agentId: "runner:gate" };
}

const unreadable = async (): Promise<never> => {
	throw new Error("claims table unreachable");
};

const statusOf = async (sandboxId: string) => {
	const [row] = await db.select().from(sandboxes).where(eq(sandboxes.id, sandboxId));
	return row!.status;
};

beforeEach(async () => {
	await sql`truncate table cost_events, circuit_breakers, automation_runs, automations, artifacts, session_events, sandboxes, session_repos, secrets, user_scm_tokens, environment_repos, environments, repos, activity, session_prompts, session_participants, sessions, runs, agent_presence, events, claims, tasks, projects, api_keys, digests, connectors, users, orgs cascade`;
	const [org] = await db.insert(orgs).values({ name: "Lease Gate Org" }).returning();
	orgId = org!.id;
	process.env.HARBOR_PUBLIC_URL = "http://host.docker.internal:3000";
});

afterAll(async () => {
	await sql.end();
});

// ---------------------------------------------------------------------------
// readLeaseState: the lost-claim degradation
// ---------------------------------------------------------------------------

describe("readLeaseState distinguishes leaseless-by-design from lease-lost", () => {
	it("no claim presented, no task: held — a scratch session has no lease to hold", async () => {
		expect(await readLeaseState(null, null, new Date())).toBe("held");
	});

	it("no claim presented but the session HAS a task: not_held — the claim was lost", async () => {
		expect(await readLeaseState(null, "some-task-id", new Date())).toBe("not_held");
	});

	it("a released claim reads not_held even when a decoy re-read would have found a live one", async () => {
		// The exact failure the claimId threading fixes: agent A's claim is
		// released, agent B claims the same task, and a caller that re-read
		// "the active claim for this task" would happily present B's claim as its
		// own authority. Presenting A's actual claim id answers not_held.
		const created = await createTask(orgId, { title: "Decoy" });
		const first = await claim(orgId, created.id, "agent-a", { intent: "Hold this task for the sandbox test." });
		if (!first.ok) throw new Error("expected claim");
		await release(orgId, created.id, "agent-a", "done");
		const second = await claim(orgId, created.id, "agent-b", { intent: "Hold this task for the sandbox test." });
		if (!second.ok) throw new Error("expected claim");

		expect(await readLeaseState(first.claimId, created.id, new Date())).toBe("not_held");
		expect(await readLeaseState(second.claimId, created.id, new Date())).toBe("held");
	});
});

describe("ensureSandbox refuses a task-backed session with no claim", () => {
	it("claimId null + task present → refused lease_not_held, provider never called", async () => {
		const created = await createTask(orgId, { title: "No claim" });
		const session = await createSession({
			orgId,
			title: "Refused",
			createdBy: "rin",
			taskId: created.id,
		});
		const fake = fakeProvider();

		const outcome = await ensureSandbox({
			orgId,
			sessionId: session.id,
			claimId: null,
			provider: fake.provider,
		});

		expect(outcome).toEqual({ kind: "refused", reason: "lease_not_held" });
		expect(fake.created).toHaveLength(0);
	});

	it("a claim released between claim() and ensureSandbox() refuses rather than spawning", async () => {
		const created = await createTask(orgId, { title: "Lost between" });
		const session = await createSession({
			orgId,
			title: "Lost",
			createdBy: "rin",
			taskId: created.id,
		});
		const claimed = await claim(orgId, created.id, "agent-a", { intent: "Hold this task for the sandbox test." });
		if (!claimed.ok) throw new Error("expected claim");
		await release(orgId, created.id, "agent-a", "gave up");

		const fake = fakeProvider();
		const outcome = await ensureSandbox({
			orgId,
			sessionId: session.id,
			claimId: claimed.claimId,
			provider: fake.provider,
		});
		expect(outcome).toEqual({ kind: "refused", reason: "lease_not_held" });
		expect(fake.created).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// The destruction gate, handler by handler
// ---------------------------------------------------------------------------

describe("onInactivity", () => {
	it("defers — zero stops, zero transitions — when the lease cannot be read", async () => {
		const fake = fakeProvider();
		const box = await idleTaskSession(fake);
		// Release the lease so only the unreadable reader stands between the
		// sweep and the destroy — the deferral below is the reader's doing alone.
		await release(orgId, box.taskId, box.agentId, "done");

		const report = await onInactivity(new Date(), {
			provider: fake.provider,
			readLease: unreadable,
		});

		expect(report.deferred).toEqual([box.sandboxId]);
		expect(report.acted).toEqual([]);
		expect(fake.stopCalls).toBe(0);
		expect(await statusOf(box.sandboxId)).toBe("ready");
	});

	it("defers while the lease is held, destroys after it releases", async () => {
		const fake = fakeProvider();
		const box = await idleTaskSession(fake);

		const held = await onInactivity(new Date(), { provider: fake.provider });
		expect(held.deferred).toEqual([box.sandboxId]);
		expect(await statusOf(box.sandboxId)).toBe("ready");

		await release(orgId, box.taskId, box.agentId, "done");
		const released = await onInactivity(new Date(), { provider: fake.provider });
		expect(released.acted).toEqual([box.sandboxId]);
		expect(await statusOf(box.sandboxId)).toBe("stopped");
		expect(fake.stopCalls).toBe(1);
	});

	it("still reaps a leaseless dashboard session — the cost lever is untouched", async () => {
		const fake = fakeProvider();
		const session = await createSession({ orgId, title: "Scratch", createdBy: "rin" });
		const outcome = await ensureSandbox({ orgId, sessionId: session.id, provider: fake.provider });
		if (outcome.kind !== "created") throw new Error(`expected created, got ${outcome.kind}`);
		await markSandboxReady(outcome.sandbox_id);
		await db
			.update(sessions)
			.set({ lastActivityAt: new Date(Date.now() - 24 * 3_600_000) })
			.where(eq(sessions.id, session.id));

		const report = await onInactivity(new Date(), { provider: fake.provider });
		expect(report.acted).toEqual([outcome.sandbox_id]);
		expect(report.deferred).toEqual([]);
		expect(await statusOf(outcome.sandbox_id)).toBe("stopped");
	});

	it("recovers on the next sweep once the lease reader is healthy again", async () => {
		const fake = fakeProvider();
		const box = await idleTaskSession(fake);
		await release(orgId, box.taskId, box.agentId, "done");

		const failing = await onInactivity(new Date(), {
			provider: fake.provider,
			readLease: unreadable,
		});
		expect(failing.deferred).toEqual([box.sandboxId]);

		// The reader recovers (default: the real claims table) and the very next
		// pass completes the reap — deferral cost one interval, not correctness.
		const recovered = await onInactivity(new Date(), { provider: fake.provider });
		expect(recovered.acted).toEqual([box.sandboxId]);
		expect(await statusOf(box.sandboxId)).toBe("stopped");
	});

	it("stays idempotent with the gate in place: the second pass acts on nothing", async () => {
		const fake = fakeProvider();
		const box = await idleTaskSession(fake);
		await release(orgId, box.taskId, box.agentId, "done");

		const first = await onInactivity(new Date(), { provider: fake.provider });
		expect(first.acted).toEqual([box.sandboxId]);
		const second = await onInactivity(new Date(), { provider: fake.provider });
		expect(second.acted).toEqual([]);
		expect(second.deferred).toEqual([]);
		expect(fake.stopCalls).toBe(1);

		const stopEvents = await db
			.select()
			.from(sessionEvents)
			.where(eq(sessionEvents.sessionId, box.session.id));
		expect(stopEvents.filter((event) => event.type === "sandbox_stopped")).toHaveLength(1);
	});
});

describe("onStaleHeartbeat", () => {
	it("defers on an unreadable lease rather than declaring the box stale", async () => {
		const fake = fakeProvider();
		const box = await idleTaskSession(fake);
		await release(orgId, box.taskId, box.agentId, "done");
		// Heartbeat long gone — squarely in this handler's jurisdiction.
		await db
			.update(sandboxes)
			.set({ lastHeartbeatAt: new Date(Date.now() - 3_600_000) })
			.where(eq(sandboxes.id, box.sandboxId));

		const report = await onStaleHeartbeat(new Date(), {
			provider: fake.provider,
			readLease: unreadable,
		});
		expect(report.deferred).toEqual([box.sandboxId]);
		expect(fake.stopCalls).toBe(0);
		expect(await statusOf(box.sandboxId)).toBe("ready");

		const recovered = await onStaleHeartbeat(new Date(), { provider: fake.provider });
		expect(recovered.acted).toEqual([box.sandboxId]);
		expect(await statusOf(box.sandboxId)).toBe("stale");
	});
});

describe("onConnectingTimeout", () => {
	/** A requested row old enough to have blown the boot timeout. */
	async function timedOutAttempt() {
		const created = await createTask(orgId, { title: "Slow boot" });
		const session = await createSession({
			orgId,
			title: "Slow",
			createdBy: "rin",
			taskId: created.id,
		});
		const [row] = await db
			.insert(sandboxes)
			.values({
				orgId,
				sessionId: session.id,
				provider: "fake",
				status: "requested",
				createdAt: new Date(Date.now() - 2 * 480_000),
			})
			.returning();
		return { session, taskId: created.id, row: row! };
	}

	it("defers on an unreadable lease WITHOUT asking the provider", async () => {
		const fake = fakeProvider();
		const attempt = await timedOutAttempt();

		const report = await onConnectingTimeout(new Date(), {
			provider: fake.provider,
			readLease: unreadable,
		});
		expect(report.deferred).toEqual([attempt.row.id]);
		// The gate sits before reconciliation: a deferred attempt is the lease
		// holder's to reconcile, so the provider was never consulted.
		expect(fake.findCalls).toBe(0);
		expect(await statusOf(attempt.row.id)).toBe("requested");
	});

	it("defers on a provider that cannot answer, and the next sweep concludes it", async () => {
		const fake = fakeProvider();
		const attempt = await timedOutAttempt();

		let failOnce = true;
		const flaky: SandboxProvider = {
			...fake.provider,
			async findByAttemptId(attemptId: string) {
				if (failOnce) {
					failOnce = false;
					throw new Error("backend unreachable");
				}
				return fake.provider.findByAttemptId(attemptId);
			},
		} as SandboxProvider;

		const first = await onConnectingTimeout(new Date(), { provider: flaky });
		// The row is NOT concluded: `failed` is on the dead deny-list and nothing
		// ever revisits it, so an unanswerable provider defers instead — the exact
		// opposite of the old behaviour, which swallowed the error after already
		// writing `failed` and stranded the container forever.
		expect(first.deferred).toEqual([attempt.row.id]);
		expect(await statusOf(attempt.row.id)).toBe("requested");

		const second = await onConnectingTimeout(new Date(), { provider: flaky });
		expect(second.acted).toEqual([attempt.row.id]);
		expect(await statusOf(attempt.row.id)).toBe("failed");
	});

	it("stops the orphan it reconciles, exactly once across two sweeps", async () => {
		const fake = fakeProvider();
		const attempt = await timedOutAttempt();
		// The provider DID create a box for this attempt — the response was lost.
		await fake.provider.create({
			sessionId: attempt.session.id,
			sandboxId: attempt.row.id,
			attemptId: attempt.row.id,
			image: "img",
			workspace: "/workspace",
			env: {},
			timeoutMs: 1000,
			features: {},
		} as CreateSandboxConfig);

		const first = await onConnectingTimeout(new Date(), { provider: fake.provider });
		expect(first.acted).toEqual([attempt.row.id]);
		expect(fake.stopCalls).toBe(1);
		expect(await statusOf(attempt.row.id)).toBe("failed");

		const [event] = await db
			.select()
			.from(sessionEvents)
			.where(eq(sessionEvents.sessionId, attempt.session.id))
			.then((rows) => rows.filter((row) => row.type === "sandbox_failed"));
		expect((event!.payload as { reconciled_orphan: string | null }).reconciled_orphan).toBe(
			"ext-1",
		);

		const second = await onConnectingTimeout(new Date(), { provider: fake.provider });
		expect(second.acted).toEqual([]);
		expect(fake.stopCalls).toBe(1);
	});
});
