// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * State changes and their ledger events commit together, or not at all.
 *
 * The invariant under test: **every lifecycle transition appends its session
 * event in the same transaction as the state change.** Not after. Not in a
 * callback. Not best-effort. Before this suite existed, every pair in
 * `manager.ts` was two transactions — the state committed first and the event
 * followed — so a crash between the two produced facts with no record: a
 * sandbox attached to a container the timeline never mentions, a stopped box
 * whose transcript says it is running, a snapshot nobody can see was taken.
 *
 * The harness is a Postgres trigger that aborts the INSERT of a chosen event
 * type. That is a real mid-transaction failure at exactly the point the old
 * code could not survive, which is something no mock can produce: with the
 * trigger armed, the invariant holds only if the state change rolls back with
 * its event. Each case asserts both directions — armed: neither row; disarmed:
 * both rows — and where the saga has a recovery path, that a retry completes
 * the work.
 *
 * These tests run against the real Postgres from docker-compose. The trigger
 * is scoped to one event type and this suite truncates in beforeEach, so cases
 * cannot poison each other.
 */

import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, sql } from "@core/schema/index.js";
import { costEvents, orgs, sandboxes, sessionEvents, sessionPrompts, sessions } from "@core/schema/schema.js";
import { appendEvent, appendEvents } from "../lib/session-events.js";
import { completeTurn, takeNextPrompt } from "../lib/session-runner.js";
import { createSession, queuePrompt } from "../lib/sessions.js";
import { ensureSandbox, markSandboxReady, onInactivity, snapshotSandbox, stopSandbox } from "./manager.js";
import { SandboxProviderError } from "./provider.js";
import type {
	CreateSandboxConfig,
	CreatedSandbox,
	SandboxInspection,
	SandboxProvider,
} from "./provider.js";

let orgId: string;
let sessionId: string;

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

/** The manager-test fake: records creates, answers findByAttemptId from them. */
function fakeProvider() {
	const created: Array<{ attemptId: string; externalId: string }> = [];
	let createCalls = 0;
	let stopCalls = 0;

	const provider: SandboxProvider = {
		kind: "ephemeral",
		name: "fake",
		capabilities: {
			supportsSandboxTimeout: true,
			supportsSnapshots: false,
			supportsRestore: false,
		},
		async create(config: CreateSandboxConfig): Promise<CreatedSandbox> {
			createCalls += 1;
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
		get createCalls() {
			return createCalls;
		},
		get stopCalls() {
			return stopCalls;
		},
	};
}

/**
 * Arm a BEFORE INSERT trigger that aborts any `session_events` row of the given
 * type. The abort happens inside whatever transaction attempted the insert,
 * which is precisely the crash window the invariant must survive.
 */
async function armAbortOn(eventType: string): Promise<void> {
	await sql.unsafe(`
		create or replace function harbor_test_abort_event() returns trigger as $$
		begin
			raise exception 'test-induced abort on %', new.type;
		end $$ language plpgsql;
	`);
	await sql.unsafe(`
		drop trigger if exists harbor_test_abort on session_events;
		create trigger harbor_test_abort
			before insert on session_events
			for each row
			when (new.type = '${eventType}')
			execute function harbor_test_abort_event();
	`);
}

async function disarm(): Promise<void> {
	await sql.unsafe("drop trigger if exists harbor_test_abort on session_events");
}

const eventsOfType = async (type: string) =>
	db
		.select()
		.from(sessionEvents)
		.where(and(eq(sessionEvents.sessionId, sessionId), eq(sessionEvents.type, type)));

const sandboxRows = async () =>
	db.select().from(sandboxes).where(eq(sandboxes.sessionId, sessionId));

const nextSeq = async () => {
	const [row] = await db
		.select({ nextEventSeq: sessions.nextEventSeq })
		.from(sessions)
		.where(eq(sessions.id, sessionId));
	return row!.nextEventSeq;
};

beforeEach(async () => {
	await disarm();
	await sql`truncate table cost_events, circuit_breakers, automation_runs, automations, artifacts, session_events, sandboxes, session_repos, secrets, user_scm_tokens, environment_repos, environments, repos, activity, session_prompts, session_participants, sessions, runs, agent_presence, events, claims, tasks, projects, api_keys, digests, connectors, users, orgs cascade`;
	const [org] = await db.insert(orgs).values({ name: "Atomicity Org" }).returning();
	orgId = org!.id;
	const session = await createSession({ orgId, title: "Atomicity", createdBy: "rin" });
	sessionId = session.id;
	process.env.HARBOR_PUBLIC_URL = "http://host.docker.internal:3000";
});

afterEach(async () => {
	await disarm();
});

afterAll(async () => {
	await sql.unsafe("drop function if exists harbor_test_abort_event() cascade");
	await sql.end();
});

// ---------------------------------------------------------------------------
// The executor option itself
// ---------------------------------------------------------------------------

describe("appendEvents with a caller's executor", () => {
	it("commits the event with the caller's transaction", async () => {
		await db.transaction(async (tx) => {
			await tx.update(sessions).set({ title: "renamed" }).where(eq(sessions.id, sessionId));
			await appendEvent(
				{ orgId, sessionId, type: "session_error", payload: { probe: true } },
				{ executor: tx },
			);
		});
		const rows = await eventsOfType("session_error");
		expect(rows).toHaveLength(1);
		const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
		expect(session!.title).toBe("renamed");
	});

	it("rolls the event AND the seq allocation back when the caller aborts", async () => {
		const seqBefore = await nextSeq();
		await expect(
			db.transaction(async (tx) => {
				await tx.update(sessions).set({ title: "doomed" }).where(eq(sessions.id, sessionId));
				await appendEvent(
					{ orgId, sessionId, type: "session_error", payload: { probe: true } },
					{ executor: tx },
				);
				throw new Error("caller aborts after appending");
			}),
		).rejects.toThrow(/caller aborts/);

		// No event, no rename — and critically no seq hole: the counter bump rolled
		// back with the insert, so the next append reuses the number and a client
		// waiting on contiguity is not parked behind a seq that will never arrive.
		expect(await eventsOfType("session_error")).toHaveLength(0);
		const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
		expect(session!.title).not.toBe("doomed");
		expect(await nextSeq()).toBe(seqBefore);
	});

	it("keeps seqs contiguous when executor-mode and plain appends interleave", async () => {
		await db.transaction(async (tx) => {
			await appendEvents(
				{
					orgId,
					sessionId,
					events: [
						{ type: "agent_message", payload: { i: 1 } },
						{ type: "agent_message", payload: { i: 2 } },
					],
				},
				{ executor: tx },
			);
		});
		await appendEvent({ orgId, sessionId, type: "agent_message", payload: { i: 3 } });
		await db.transaction(async (tx) => {
			await appendEvent(
				{ orgId, sessionId, type: "agent_message", payload: { i: 4 } },
				{ executor: tx },
			);
		});

		const rows = await db
			.select({ seq: sessionEvents.seq })
			.from(sessionEvents)
			.where(eq(sessionEvents.sessionId, sessionId))
			.orderBy(sessionEvents.seq);
		const seqs = rows.map((row) => row.seq);
		for (let index = 1; index < seqs.length; index += 1) {
			expect(seqs[index]).toBe(seqs[index - 1]! + 1);
		}
	});

	it("sends no NOTIFY from inside the transaction, and the caller's fires after", async () => {
		// A dedicated LISTEN connection, because notifications only surface on the
		// connection that listened. The executor-mode append must be silent — a
		// NOTIFY sent inside the transaction wakes listeners before the rows are
		// visible — and the follow-up plain append proves the listener works.
		const listener = postgres(
			process.env.DATABASE_URL ?? "postgres://harbor:harbor@localhost:5433/harbor",
			{ max: 1 },
		);
		const notifications: string[] = [];
		try {
			await listener.listen("harbor_changes", (payload) => {
				notifications.push(payload);
			});

			await expect(
				db.transaction(async (tx) => {
					await appendEvent(
						{ orgId, sessionId, type: "agent_message", payload: { doomed: true } },
						{ executor: tx },
					);
					throw new Error("abort");
				}),
			).rejects.toThrow();
			// Give a stray in-transaction NOTIFY time to surface if one existed.
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect(notifications).toHaveLength(0);

			await appendEvent({ orgId, sessionId, type: "agent_message", payload: { live: true } });
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(notifications.length).toBeGreaterThan(0);
		} finally {
			await listener.end();
		}
	});
});

// ---------------------------------------------------------------------------
// The spawn saga's pairs
// ---------------------------------------------------------------------------

describe("intent and its sandbox_requested event are one transaction", () => {
	it("an aborted event insert rolls back the intent row — no invisible attempt", async () => {
		await armAbortOn("sandbox_requested");
		const fake = fakeProvider();

		await expect(
			ensureSandbox({ orgId, sessionId, provider: fake.provider }),
		).rejects.toThrow(/test-induced abort|session_events/);

		// Nothing was persisted and, just as important, nothing was CREATED: the
		// provider call sits after the intent commit, so the crash window cannot
		// bill anybody.
		expect(await sandboxRows()).toHaveLength(0);
		expect(await eventsOfType("sandbox_requested")).toHaveLength(0);
		expect(fake.createCalls).toBe(0);

		// Recovery: the failure left no residue, so a plain retry works.
		await disarm();
		const outcome = await ensureSandbox({ orgId, sessionId, provider: fake.provider });
		expect(outcome.kind).toBe("created");
		expect(await eventsOfType("sandbox_requested")).toHaveLength(1);
	});
});

describe("attach and its sandbox_spawning event are one transaction", () => {
	it("an aborted event rolls back the attach, and reconciliation adopts the box on retry", async () => {
		await armAbortOn("sandbox_spawning");
		const fake = fakeProvider();

		const outcome = await ensureSandbox({ orgId, sessionId, provider: fake.provider });
		// The saga caught the aborted transaction as a spawn failure — honestly
		// reported, not thrown — and the box the provider DID create is now an
		// orphan the record can still find.
		expect(outcome.kind).toBe("failed");
		expect(fake.createCalls).toBe(1);

		const [row] = await sandboxRows();
		// The attach rolled back whole: still `requested`, no external id — a row
		// in `spawning` with no `sandbox_spawning` event is the split brain the
		// shared transaction exists to prevent.
		expect(row!.status).toBe("requested");
		expect(row!.externalId).toBeNull();
		expect(await eventsOfType("sandbox_spawning")).toHaveLength(0);

		// Retry: `classifyPendingAttempt` reads the failure mark as resumable,
		// reconciliation asks the provider, and the orphan is ADOPTED rather than
		// a second box being created.
		await disarm();
		const retried = await ensureSandbox({ orgId, sessionId, provider: fake.provider });
		expect(retried.kind).toBe("adopted");
		expect(fake.createCalls).toBe(1);
		const spawningEvents = await eventsOfType("sandbox_spawning");
		expect(spawningEvents).toHaveLength(1);
		expect((spawningEvents[0]!.payload as { adopted?: boolean }).adopted).toBe(true);
	});
});

describe("ready and its sandbox_ready event are one transaction", () => {
	it("an aborted event leaves the row un-ready, and the bridge's retry lands both", async () => {
		const fake = fakeProvider();
		const outcome = await ensureSandbox({ orgId, sessionId, provider: fake.provider });
		if (outcome.kind !== "created") throw new Error(`expected created, got ${outcome.kind}`);

		await armAbortOn("sandbox_ready");
		await expect(markSandboxReady(outcome.sandbox_id)).rejects.toThrow(/test-induced abort|session_events/);

		const [row] = await sandboxRows();
		expect(row!.status).toBe("spawning");
		expect(row!.readyAt).toBeNull();
		expect(await eventsOfType("sandbox_ready")).toHaveLength(0);

		// The bridge re-reports ready on reconnect; the retry writes both halves.
		await disarm();
		const retried = await markSandboxReady(outcome.sandbox_id);
		expect(retried.accepted).toBe(true);
		const [after] = await sandboxRows();
		expect(after!.status).toBe("ready");
		expect(after!.readyAt).not.toBeNull();
		expect(await eventsOfType("sandbox_ready")).toHaveLength(1);
	});
});

describe("stop and its sandbox_stopped event are one transaction, before the provider", () => {
	it("an aborted event leaves the box alive and the provider untouched", async () => {
		const fake = fakeProvider();
		const outcome = await ensureSandbox({ orgId, sessionId, provider: fake.provider });
		if (outcome.kind !== "created") throw new Error(`expected created, got ${outcome.kind}`);
		await markSandboxReady(outcome.sandbox_id);

		await armAbortOn("sandbox_stopped");
		await expect(
			stopSandbox(outcome.sandbox_id, "stopped_by_operator", { provider: fake.provider }),
		).rejects.toThrow(/test-induced abort|session_events/);

		// The decision did not commit, so the provider must not have been asked:
		// persist-before-close means a stop the record does not show never happens.
		const [row] = await sandboxRows();
		expect(row!.status).toBe("ready");
		expect(await eventsOfType("sandbox_stopped")).toHaveLength(0);
		expect(fake.stopCalls).toBe(0);

		await disarm();
		const stopped = await stopSandbox(outcome.sandbox_id, "stopped_by_operator", {
			provider: fake.provider,
		});
		expect(stopped.kind).toBe("stopped");
		expect(fake.stopCalls).toBe(1);
		expect(await eventsOfType("sandbox_stopped")).toHaveLength(1);
	});
});

describe("the inactivity reaper's transition and event are one transaction", () => {
	it("an aborted event leaves the box live for the next sweep", async () => {
		const fake = fakeProvider();
		const outcome = await ensureSandbox({ orgId, sessionId, provider: fake.provider });
		if (outcome.kind !== "created") throw new Error(`expected created, got ${outcome.kind}`);
		await markSandboxReady(outcome.sandbox_id);
		// Make the session idle past any threshold.
		await db
			.update(sessions)
			.set({ lastActivityAt: new Date(Date.now() - 24 * 3_600_000) })
			.where(eq(sessions.id, sessionId));

		await armAbortOn("sandbox_stopped");
		await expect(
			onInactivity(new Date(), { provider: fake.provider }),
		).rejects.toThrow(/test-induced abort|session_events/);

		const [row] = await sandboxRows();
		expect(row!.status).toBe("ready");
		expect(fake.stopCalls).toBe(0);
		expect(await eventsOfType("sandbox_stopped")).toHaveLength(0);

		// The failure changed nothing, so the very next sweep completes the reap.
		await disarm();
		const report = await onInactivity(new Date(), { provider: fake.provider });
		expect(report.acted).toEqual([outcome.sandbox_id]);
		const [after] = await sandboxRows();
		expect(after!.status).toBe("stopped");
		expect(await eventsOfType("sandbox_stopped")).toHaveLength(1);
		expect(fake.stopCalls).toBe(1);
	});
});

describe("snapshot ref, its event and its cost row are one transaction", () => {
	const snapshotProvider = (base: ReturnType<typeof fakeProvider>) =>
		({
			...base.provider,
			kind: "snapshot",
			async snapshot(externalId: string) {
				return {
					provider: "fake",
					handle: `snap-${externalId}`,
					sourceExternalId: externalId,
					takenAt: new Date().toISOString(),
				};
			},
			async restoreFromSnapshot() {
				throw new Error("not exercised here");
			},
		}) as unknown as import("./provider.js").SnapshotProvider;

	it("an aborted event leaves no ref, no event and no cost row; the retry lands all three", async () => {
		const fake = fakeProvider();
		const outcome = await ensureSandbox({ orgId, sessionId, provider: fake.provider });
		if (outcome.kind !== "created") throw new Error(`expected created, got ${outcome.kind}`);
		await markSandboxReady(outcome.sandbox_id);
		const provider = snapshotProvider(fake);

		await armAbortOn("sandbox_snapshotted");
		const failed = await snapshotSandbox(provider, outcome.sandbox_id);
		expect(failed.kind).toBe("failed");

		const [row] = await sandboxRows();
		expect(row!.snapshotRef).toBeNull();
		expect(await eventsOfType("sandbox_snapshotted")).toHaveLength(0);
		const costBefore = await db
			.select()
			.from(costEvents)
			.where(eq(costEvents.sessionId, sessionId));
		expect(costBefore.filter((r) => r.kind.includes("provider_call"))).toHaveLength(0);

		// A snapshot used to be doubly invisible: no timeline event and no cost
		// row. The retry proves all three halves land together.
		await disarm();
		const captured = await snapshotSandbox(provider, outcome.sandbox_id);
		expect(captured.kind).toBe("captured");
		const [after] = await sandboxRows();
		expect(after!.snapshotRef).not.toBeNull();
		expect(await eventsOfType("sandbox_snapshotted")).toHaveLength(1);
		const costAfter = await db
			.select()
			.from(costEvents)
			.where(eq(costEvents.sessionId, sessionId));
		expect(costAfter.filter((r) => r.kind.includes("provider_call"))).toHaveLength(1);
	});
});

describe("completeTurn's CAS and prompt_finished are one transaction", () => {
	it("an aborted event leaves the prompt delivered, and the ingest retry closes it once", async () => {
		await queuePrompt({ orgId, sessionId, author: "rin", authorKind: "human", body: "go" });
		const taken = await takeNextPrompt(orgId, sessionId);
		expect(taken).not.toBeNull();

		await armAbortOn("prompt_finished");
		await expect(
			completeTurn({ orgId, sessionId, outcome: "completed", promptId: taken!.id }),
		).rejects.toThrow(/test-induced abort|session_events/);

		const [prompt] = await db
			.select()
			.from(sessionPrompts)
			.where(eq(sessionPrompts.id, taken!.id));
		// Still delivered: the terminal status rolled back with its event, so the
		// execution-timeout sweep (or the bridge's retried batch) still owns it.
		expect(prompt!.status).toBe("delivered");
		expect(await eventsOfType("prompt_finished")).toHaveLength(0);

		await disarm();
		const retried = await completeTurn({
			orgId,
			sessionId,
			outcome: "completed",
			promptId: taken!.id,
		});
		expect(retried.finished).toEqual([taken!.id]);
		expect(await eventsOfType("prompt_finished")).toHaveLength(1);

		// And the retry after success is the idempotent no-op the CAS promises.
		const again = await completeTurn({
			orgId,
			sessionId,
			outcome: "completed",
			promptId: taken!.id,
		});
		expect(again.finished).toEqual([]);
		expect(await eventsOfType("prompt_finished")).toHaveLength(1);
	});
});
