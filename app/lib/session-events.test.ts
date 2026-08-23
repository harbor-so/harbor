// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Tests for the session timeline, aimed at the four properties that are hard to
 * get right rather than at the CRUD around them: the seq counter under
 * concurrency, snapshot truncation and paging, idempotent compaction, and the
 * convergence contract itself.
 *
 * Against real Postgres, and not negotiable. Three of the four are properties of
 * how Postgres allocates, locks and makes rows visible — a mock would happily
 * pass a `max(seq) + 1` implementation that drops one client's events the first
 * time two people type at once, which is the exact bug this module exists to
 * prevent. The pure payload-bounding tests below use no database at all and are
 * asserted at exact boundary values, because "one character over the limit" is
 * the only interesting input.
 */

import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_EVENT_TYPES, type SessionEvent } from "../contracts/index.js";
import { db, sql } from "@core/schema/index.js";
import { orgs, sessionEvents, sessions } from "@core/schema/schema.js";
import {
	appendEvent,
	appendEvents,
	compactSession,
	compactionRole,
	eventPage,
	retainedFromSeq,
	snapshotSession,
	truncatePayload,
} from "./session-events.js";
import { createSession, queuePrompt } from "./sessions.js";

let orgId: string;
let sessionId: string;
let sessionKey: string;

/** Environment set inside a test, undone afterwards so cases cannot leak into each other. */
const touchedEnv = new Set<string>();

function useSetting(env: string, value: number): void {
	touchedEnv.add(env);
	process.env[env] = String(value);
}

/**
 * A fresh org and session per case, and deliberately NO `truncate`.
 *
 * Every assertion below is scoped by org id or session id, so this suite does not
 * need to own the database — and a suite that truncates does own it, whether or
 * not it means to. Sharing one Postgres with the rest of the test suite, a
 * `truncate ... cascade` in one file deletes the org another file is mid-way
 * through using, and the failure surfaces as a foreign key violation in unrelated
 * code with a stack trace that points nowhere near the cause.
 */
beforeEach(async () => {
	const [org] = await db.insert(orgs).values({ name: "Timeline Org" }).returning();
	orgId = org!.id;
	const session = await createSession({
		orgId,
		title: "Fix the webhook retry bug",
		createdBy: "@rin",
	});
	sessionId = session.id;
	sessionKey = session.key;
});

afterEach(() => {
	for (const env of touchedEnv) delete process.env[env];
	touchedEnv.clear();
});

afterAll(async () => {
	await sql.end();
});

async function storedEvents() {
	return db
		.select()
		.from(sessionEvents)
		.where(eq(sessionEvents.sessionId, sessionId))
		.orderBy(asc(sessionEvents.seq));
}

// ---------------------------------------------------------------------------

describe("appending", () => {
	it("returns the event in wire shape, snake_case and all", async () => {
		const event = await appendEvent({
			orgId,
			sessionId,
			type: "session_created",
			payload: { title: "Fix the webhook retry bug" },
			actor: "@rin",
		});

		expect(event.seq).toBe(1);
		expect(event.session_id).toBe(sessionId);
		expect(event.type).toBe("session_created");
		expect(event.actor).toBe("@rin");
		expect(typeof event.created_at).toBe("string");
		expect(new Date(event.created_at).getTime()).not.toBeNaN();
		// camelCase leaking out of here is how `session_id` and `sessionId` end up in
		// the same log line and correlation turns into grep archaeology.
		expect(Object.keys(event)).toEqual([
			"id",
			"session_id",
			"seq",
			"type",
			"payload",
			"actor",
			"created_at",
		]);
	});

	it("allocates 1..200 exactly, with no gaps and no duplicates, under 200 concurrent appends", async () => {
		// The test that proves the counter discipline, and the one that fails against
		// a `select max(seq) + 1` implementation. Under READ COMMITTED two callers
		// read the same maximum, the unique index rejects the loser, and somebody's
		// event vanishes — so the assertion is that NOTHING was dropped, not merely
		// that what survived is unique. An earlier version of the sibling test in
		// sessions.test.ts made exactly that mistake and passed against a broken
		// implementation.
		const appends = 200;
		const results = await Promise.allSettled(
			Array.from({ length: appends }, (_, i) =>
				appendEvent({
					orgId,
					sessionId,
					type: "agent_message",
					payload: { text: `token ${i}` },
					actor: "claude-code:wt-1",
				}),
			),
		);

		const rejected = results.filter((r) => r.status === "rejected");
		expect(rejected.map((r) => (r as PromiseRejectedResult).reason)).toEqual([]);

		const stored = await storedEvents();
		expect(stored).toHaveLength(appends);
		expect(stored.map((row) => row.seq)).toEqual(
			Array.from({ length: appends }, (_, i) => i + 1),
		);
		expect(new Set(stored.map((row) => row.id)).size).toBe(appends);

		// Every distinct body survived: no two appends collapsed onto one row.
		const bodies = new Set(stored.map((row) => (row.payload as { text: string }).text));
		expect(bodies.size).toBe(appends);
	});

	it("allocates one contiguous range per batch", async () => {
		await appendEvent({ orgId, sessionId, type: "prompt_delivered", actor: "harbor" });
		const batch = await appendEvents({
			orgId,
			sessionId,
			events: Array.from({ length: 5 }, (_, i) => ({
				type: "agent_message" as const,
				payload: { text: `chunk ${i}` },
			})),
		});
		const after = await appendEvent({ orgId, sessionId, type: "agent_finished" });

		expect(batch.map((e) => e.seq)).toEqual([2, 3, 4, 5, 6]);
		expect(after.seq).toBe(7);
		expect((await storedEvents()).map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
	});

	it("is a no-op on an empty batch rather than burning a seq", async () => {
		expect(await appendEvents({ orgId, sessionId, events: [] })).toEqual([]);
		const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
		expect(session!.nextEventSeq).toBe(1);
	});

	it("keeps the event counter separate from the prompt counter", async () => {
		// Sharing one counter would make every streamed token advance the prompt
		// numbering, so "message #3" would mean nothing to the people in the room.
		await appendEvents({
			orgId,
			sessionId,
			events: [{ type: "agent_message" }, { type: "agent_message" }],
		});
		const prompt = await queuePrompt({ orgId, sessionId, author: "@rin", body: "go" });
		expect(prompt.seq).toBe(1);
		expect((await appendEvent({ orgId, sessionId, type: "prompt_queued" })).seq).toBe(3);
	});

	it("bumps last activity, so the dashboard's ordering follows the agent", async () => {
		const [before] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
		await new Promise((resolve) => setTimeout(resolve, 5));
		await appendEvent({ orgId, sessionId, type: "agent_message" });
		const [after] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
		expect(after!.lastActivityAt.getTime()).toBeGreaterThan(before!.lastActivityAt.getTime());
	});

	it("refuses a session belonging to another org — authority fails CLOSED", async () => {
		const [other] = await db.insert(orgs).values({ name: "Other" }).returning();
		await expect(
			appendEvent({ orgId: other!.id, sessionId, type: "agent_message" }),
		).rejects.toThrow(/No such session/);
		expect(await storedEvents()).toHaveLength(0);
	});

	it("truncates the payload BEFORE it is stored, not on the way out", async () => {
		useSetting("HARBOR_MAX_EVENT_PAYLOAD_CHARS", 300);
		await appendEvent({
			orgId,
			sessionId,
			type: "agent_tool_call",
			payload: { tool: "bash", output: "x".repeat(50_000) },
		});

		const [row] = await storedEvents();
		const stored = JSON.stringify(row!.payload);
		expect(stored.length).toBeLessThanOrEqual(300);
		// The small, useful fields survive; the log does not.
		expect((row!.payload as { tool: string }).tool).toBe("bash");
		// And the loss is stated in the payload rather than left for a reader to
		// infer from prose that stops mid-sentence.
		expect((row!.payload as { harbor_truncated_chars: number }).harbor_truncated_chars)
			.toBeGreaterThan(50_000);
	});
});

// ---------------------------------------------------------------------------

describe("payload bounding", () => {
	// No database and no mocks: this is a pure function and the only interesting
	// inputs are the ones exactly at the limit.
	const payloadOf = (chars: number) => ({ text: "x".repeat(chars) });
	const lengthOf = (value: unknown) => JSON.stringify(value).length;

	it("stores a payload exactly at the limit verbatim", () => {
		const payload = payloadOf(64);
		const limit = lengthOf(payload);
		const result = truncatePayload(payload, limit);
		expect(result.removedChars).toBe(0);
		expect(result.payload).toEqual(payload);
	});

	it("truncates a payload one character over the limit", () => {
		const payload = payloadOf(64);
		const limit = lengthOf(payload) - 1;
		const result = truncatePayload(payload, limit);
		expect(result.removedChars).toBeGreaterThan(0);
		expect(lengthOf(result.payload)).toBeLessThanOrEqual(limit);
		expect((result.payload as { harbor_truncated_chars: number }).harbor_truncated_chars).toBe(
			lengthOf(payload),
		);
	});

	it("cuts the longest string first and keeps the small useful fields", () => {
		const payload = {
			tool: "bash",
			exit_code: 0,
			path: "src/lib/work.ts",
			output: "y".repeat(5_000),
		};
		const result = truncatePayload(payload, 400);
		expect(lengthOf(result.payload)).toBeLessThanOrEqual(400);
		expect(result.payload).toMatchObject({ tool: "bash", exit_code: 0, path: "src/lib/work.ts" });
		expect((result.payload as { output: string }).output.endsWith("…")).toBe(true);
	});

	it("reaches strings nested inside objects and arrays", () => {
		const payload = { steps: [{ stdout: "z".repeat(9_000) }], tool: "pytest" };
		const result = truncatePayload(payload, 200);
		expect(lengthOf(result.payload)).toBeLessThanOrEqual(200);
		expect(result.payload).toMatchObject({ tool: "pytest" });
	});

	it("survives values JSON.stringify would throw on, rather than losing the event", () => {
		const cyclic: Record<string, unknown> = { tool: "bash" };
		cyclic.self = cyclic;
		const result = truncatePayload({ ...cyclic, when: new Date(0), big: 1n }, 8_000);
		expect(result.payload).toMatchObject({ tool: "bash", big: "1", when: "1970-01-01T00:00:00.000Z" });
	});

	it("ladders down to an honest marker when the structure alone cannot fit", () => {
		// Sixty numeric fields and not a single string to cut: the keys alone blow
		// the budget. This is the shape that defeats a per-field cap, and the ladder
		// is what stops one pathological event making every future snapshot of the
		// session too large to send.
		const payload = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i]));
		const original = lengthOf(payload);
		const dropped = { harbor_payload_dropped: true, harbor_truncated_chars: original };
		const minimal = { harbor_truncated_chars: original };

		// Exactly enough room for the "dropped" marker and no more.
		expect(truncatePayload(payload, lengthOf(dropped)).payload).toEqual(dropped);
		// One character short of it, and the ladder takes the next rung down.
		expect(truncatePayload(payload, lengthOf(dropped) - 1).payload).toEqual(minimal);
		// One short of that, and there is nothing honest left to say.
		expect(truncatePayload(payload, lengthOf(minimal) - 1).payload).toBeNull();
	});

	it("passes a null payload through untouched", () => {
		expect(truncatePayload(null, 10)).toEqual({ payload: null, removedChars: 0 });
		expect(truncatePayload(undefined, 10)).toEqual({ payload: null, removedChars: 0 });
	});
});

// ---------------------------------------------------------------------------

describe("snapshots", () => {
	it("assembles the room: session, events, participants, prompts, artifacts", async () => {
		await queuePrompt({ orgId, sessionId, author: "@rin", body: "start with the tests" });
		await appendEvent({ orgId, sessionId, type: "prompt_queued", actor: "@rin" });
		await appendEvent({ orgId, sessionId, type: "agent_message", payload: { text: "on it" } });
		await sql`insert into sandboxes (org_id, session_id, provider, status, boot_mode) values (${orgId}, ${sessionId}, 'docker', 'ready', 'fresh')`;
		await sql`insert into artifacts (org_id, session_id, kind, title, url) values (${orgId}, ${sessionId}, 'pull_request', 'Fix retries', 'https://example.test/pr/1')`;

		const snapshot = (await snapshotSession(orgId, sessionKey))!;
		expect(snapshot.session.key).toBe(sessionKey);
		expect(snapshot.snapshot_through_seq).toBe(2);
		expect(snapshot.retained_from_seq).toBe(1);
		expect(snapshot.truncated).toBe(false);
		expect(snapshot.events.map((e) => e.seq)).toEqual([1, 2]);
		expect(snapshot.participants.map((p) => p.participant)).toEqual(["@rin"]);
		expect(snapshot.prompts.map((p) => p.body)).toEqual(["start with the tests"]);
		expect(snapshot.sandbox).toMatchObject({ status: "ready", provider: "docker", boot_mode: "fresh" });
		expect(snapshot.artifacts.map((a) => a.kind)).toEqual(["pull_request"]);
		// A snapshot is logged, cached and replayed, so it must never be able to
		// carry a credential — that is the difference between a bug that leaks state
		// and a bug that leaks secrets.
		expect(JSON.stringify(snapshot)).not.toContain("auth_token");
	});

	it("caps the participants list — the one list that used to be unbounded", async () => {
		// The snapshot's own comment argued that a second uncapped list defeats
		// the event budget; participants WAS that list, so a session a bot farm
		// joined ten thousand times made every connect and reconnect carry all of
		// them. Earliest joiners survive the cap: the creator and the regulars.
		useSetting("HARBOR_MAX_SNAPSHOT_EVENTS", 5);
		const { joinSession } = await import("./sessions.js");
		for (let n = 0; n < 8; n += 1) {
			await joinSession(sessionId, orgId, `viewer-${n}`, "human");
		}

		const snapshot = (await snapshotSession(orgId, sessionKey))!;
		expect(snapshot.participants).toHaveLength(5);
		// The creator joined first and must survive.
		expect(snapshot.participants[0]!.participant).toBe("@rin");
	});

	it("reports the next seq as the retention boundary on a brand-new session", async () => {
		const snapshot = (await snapshotSession(orgId, sessionKey))!;
		expect(snapshot.events).toEqual([]);
		expect(snapshot.retained_from_seq).toBe(1);
		// Nothing has been written, so nothing is reflected. A client told "0" applies
		// every live event it sees, which is the correct behaviour for an empty room.
		expect(snapshot.snapshot_through_seq).toBe(0);
	});

	it("prefers a live sandbox and never hides a dead one — liveness fails OPEN", async () => {
		await sql`insert into sandboxes (org_id, session_id, provider, status, created_at) values (${orgId}, ${sessionId}, 'docker', 'stopped', now() - interval '1 hour')`;
		await sql`insert into sandboxes (org_id, session_id, provider, status, created_at) values (${orgId}, ${sessionId}, 'docker', 'busy', now())`;
		expect((await snapshotSession(orgId, sessionKey))!.sandbox!.status).toBe("busy");

		await sql`update sandboxes set status = 'stopped' where session_id = ${sessionId}`;
		// Every box is dead: the newest is still reported, because "stopped" is what
		// the client needs in order to offer a resume button.
		expect((await snapshotSession(orgId, sessionKey))!.sandbox!.status).toBe("stopped");

		// A status this build has never heard of counts as LIVE. An allow-list would
		// default it to dead and abandon a box that is demonstrably running.
		await sql`insert into sandboxes (org_id, session_id, provider, status, created_at) values (${orgId}, ${sessionId}, 'docker', 'hibernating', now() + interval '1 minute')`;
		expect((await snapshotSession(orgId, sessionKey))!.sandbox!.status).toBe("hibernating");
	});

	it("returns null for an unknown key, and for a key belonging to another org", async () => {
		const [other] = await db.insert(orgs).values({ name: "Other" }).returning();
		expect(await snapshotSession(orgId, "nosuchkey")).toBeNull();
		// Indistinguishable from "never minted", so the key space is not an oracle.
		expect(await snapshotSession(other!.id, sessionKey)).toBeNull();
	});

	it("truncates at the cap, returns the tail, and pages back to the very beginning", async () => {
		useSetting("HARBOR_MAX_SNAPSHOT_EVENTS", 50);
		useSetting("HARBOR_EVENT_RETENTION_COUNT", 100_000);
		const cap = 50;
		const total = cap + 50;

		await appendEvents({
			orgId,
			sessionId,
			events: Array.from({ length: total }, (_, i) => ({
				type: "agent_message" as const,
				payload: { text: `token ${i}` },
			})),
		});

		const snapshot = (await snapshotSession(orgId, sessionKey))!;
		expect(snapshot.truncated).toBe(true);
		expect(snapshot.events).toHaveLength(cap);
		// The TAIL, not the head: a client attaching to an old session wants what
		// just happened, and the beginning is one page request away.
		expect(snapshot.events.at(-1)!.seq).toBe(total);
		expect(snapshot.events[0]!.seq).toBe(total - cap + 1);
		expect(snapshot.snapshot_through_seq).toBe(total);

		const walked: SessionEvent[] = [];
		let before = snapshot.events[0]!.seq;
		for (let guard = 0; guard < 20; guard += 1) {
			const page = await eventPage(orgId, sessionId, { before, limit: 20 });
			expect(page.retained_from_seq).toBe(1);
			walked.unshift(...page.events);
			if (!page.has_more) break;
			before = page.events[0]!.seq;
		}

		const seqs = [...walked.map((e) => e.seq), ...snapshot.events.map((e) => e.seq)];
		expect(seqs).toEqual(Array.from({ length: total }, (_, i) => i + 1));
	});

	it("refuses to page another org's session rather than answering 'no history'", async () => {
		const [other] = await db.insert(orgs).values({ name: "Other" }).returning();
		await expect(eventPage(other!.id, sessionId, {})).rejects.toThrow(/No such session/);
	});

	it("does not report a cursor past a hole in the sequence", async () => {
		// Seq 3 is missing — a transaction that allocated it and rolled back, or one
		// still in flight. `max(seq)` would say 5, the client would discard 3 when it
		// finally arrived on the live channel, and the event would be gone from that
		// client with nothing logging an error anywhere. Stopping at the gap costs a
		// few re-applied events, which the contract defines as a no-op.
		for (const seq of [1, 2, 4, 5]) {
			await sql`insert into session_events (org_id, session_id, seq, type) values (${orgId}, ${sessionId}, ${seq}, 'agent_message')`;
		}
		const snapshot = (await snapshotSession(orgId, sessionKey))!;
		expect(snapshot.snapshot_through_seq).toBe(2);
		expect(snapshot.events.map((e) => e.seq)).toEqual([1, 2, 4, 5]);
	});
});

// ---------------------------------------------------------------------------

/** Six turns of ten streamed events each, delimited the way a real run is. */
async function seedTurns(turns: number, perTurn: number): Promise<number> {
	for (let turn = 0; turn < turns; turn += 1) {
		await appendEvents({
			orgId,
			sessionId,
			events: [
				{ type: "prompt_delivered", payload: { body: `turn ${turn}` }, actor: "@rin" },
				...Array.from({ length: perTurn }, (_, i) => ({
					type: (i % 3 === 2 ? "agent_tool_call" : "agent_message") as
						| "agent_tool_call"
						| "agent_message",
					payload:
						i % 3 === 2
							? { tool: "bash", command: `step ${i}` }
							: { text: `turn ${turn} token ${i}` },
					actor: "claude-code:wt-1",
				})),
				{ type: "agent_finished", payload: { turn }, actor: "claude-code:wt-1" },
			],
		});
	}
	return turns * (perTurn + 2);
}

describe("compaction", () => {
	it("classifies every event type, and never folds the spine of the timeline", () => {
		// A pure, zero-mock check over the whole closed set. The dangerous
		// implementation is a foldable list plus an `else` that folds everything
		// else: a new `budget_exhausted` variant would then be swallowed into a
		// summary, and the record of why a session stopped would disappear from
		// exactly the sessions where somebody is trying to find out why it stopped.
		const roles = SESSION_EVENT_TYPES.map((type) => [type, compactionRole(type)] as const);
		expect(roles.filter(([, role]) => role === "foldable").map(([type]) => type)).toEqual([
			"agent_message",
			"agent_tool_call",
		]);
		expect(roles.every(([, role]) => role === "foldable" || role === "structural")).toBe(true);
	});

	it("does nothing while the session is under the retention count", async () => {
		useSetting("HARBOR_EVENT_RETENTION_COUNT", 100);
		const total = await seedTurns(2, 10);
		expect(await compactSession(orgId, sessionId)).toEqual({ compacted: 0, remaining: total });
	});

	it("folds old turns, advances the retention boundary, and is a no-op the second time", async () => {
		useSetting("HARBOR_EVENT_RETENTION_COUNT", 20);
		useSetting("HARBOR_MAX_SNAPSHOT_EVENTS", 20);
		const total = await seedTurns(6, 10);

		const first = await compactSession(orgId, sessionId);
		expect(first.compacted).toBeGreaterThan(0);
		expect(first.remaining).toBe(total - first.compacted);

		const after = await storedEvents();
		expect(after).toHaveLength(first.remaining);
		expect(after.length).toBeLessThan(total);

		// The structural events survive at any age: what was asked, and how each turn
		// ended, is still there after everything around it was folded away.
		expect(after.filter((row) => row.type === "prompt_delivered")).toHaveLength(6);
		expect(after.filter((row) => row.type === "agent_finished")).toHaveLength(6);

		const summaries = after.filter((row) => row.compactedAt !== null);
		expect(summaries.length).toBeGreaterThan(0);
		for (const summary of summaries) {
			const payload = summary.payload as Record<string, unknown>;
			// The summary sits at the bottom of the range it describes, so it sorts
			// where the turn happened rather than after everything that came later.
			expect(payload.from_seq).toBe(summary.seq);
			expect(payload.to_seq as number).toBeGreaterThan(summary.seq);
			expect(payload.compacted).toBe(true);
			// Stated in the payload, never discovered as silence by a client that asks.
			expect(payload.replayable).toBe(false);
			expect(payload.note).toMatch(/cannot be replayed/);
			expect(payload.event_count).toBe(
				(payload.to_seq as number) - (payload.from_seq as number) + 1,
			);
			expect(payload.tools).toEqual(["bash"]);
			// A run that started with a tool call still survives as a message: a client
			// switching on `agent_tool_call` would try to render prose as a tool.
			expect(summary.type).toBe("agent_message");
		}

		const boundary = Math.max(...summaries.map((s) => (s.payload as { to_seq: number }).to_seq));
		expect(await retainedFromSeq(sessionId)).toBe(boundary + 1);
		expect(await retainedFromSeq(sessionId)).toBeGreaterThan(1);

		// Idempotence. `compactedAt` marks the survivor, so a second pass does not
		// summarise a summary — which would multiply the counts and lose the original
		// seq range with every run.
		const second = await compactSession(orgId, sessionId);
		expect(second).toEqual({ compacted: 0, remaining: first.remaining });
		expect(await storedEvents()).toEqual(after);
	});

	it("compacts a turn that never ended, rather than waiting forever for a boundary", async () => {
		// A crashed bridge or a hung tool means no `agent_finished` ever arrives. Held
		// back for a turn boundary, this session has one infinite turn and is never
		// compacted at all — and it is precisely the session that needs compacting.
		useSetting("HARBOR_EVENT_RETENTION_COUNT", 20);
		await appendEvents({
			orgId,
			sessionId,
			events: Array.from({ length: 60 }, (_, i) => ({
				type: "agent_message" as const,
				payload: { text: `token ${i}` },
			})),
		});
		const result = await compactSession(orgId, sessionId);
		expect(result.compacted).toBe(39);
		expect(result.remaining).toBe(21);
	});

	it("reports the new boundary in the snapshot, and still finds the top of the stream", async () => {
		useSetting("HARBOR_EVENT_RETENTION_COUNT", 20);
		useSetting("HARBOR_MAX_SNAPSHOT_EVENTS", 20);
		const total = await seedTurns(6, 10);
		await compactSession(orgId, sessionId);

		const snapshot = (await snapshotSession(orgId, sessionKey))!;
		expect(snapshot.retained_from_seq).toBe(await retainedFromSeq(sessionId));
		expect(snapshot.retained_from_seq).toBeGreaterThan(1);
		// Compaction leaves permanent holes below the boundary — the deleted
		// originals. The cursor must step over those, or it would be pinned at the
		// first summary forever and every reconnect would re-send the whole session.
		expect(snapshot.snapshot_through_seq).toBe(total);
		expect(await appendEvent({ orgId, sessionId, type: "agent_message" })).toMatchObject({
			seq: total + 1,
		});
	});

	it("refuses to compact another org's session", async () => {
		const [other] = await db.insert(orgs).values({ name: "Other" }).returning();
		await expect(compactSession(other!.id, sessionId)).rejects.toThrow(/No such session/);
	});
});

// ---------------------------------------------------------------------------

describe("convergence", () => {
	it("a snapshot plus the live tail equals the server, with no gaps and no duplicate application", async () => {
		useSetting("HARBOR_MAX_SNAPSHOT_EVENTS", 500);
		useSetting("HARBOR_EVENT_RETENTION_COUNT", 100_000);

		await appendEvents({
			orgId,
			sessionId,
			events: Array.from({ length: 30 }, (_, i) => ({
				type: "agent_message" as const,
				payload: { text: `before ${i}` },
			})),
		});

		// The interesting moment: writes landing while the snapshot is being read.
		// Whether they make it into the snapshot is exactly what a client cannot know
		// and must not have to care about.
		const [snapshot] = await Promise.all([
			snapshotSession(orgId, sessionKey),
			(async () => {
				for (let i = 0; i < 20; i += 1) {
					await appendEvent({
						orgId,
						sessionId,
						type: "agent_message",
						payload: { text: `during ${i}` },
					});
				}
			})(),
		]);
		await appendEvent({ orgId, sessionId, type: "agent_finished", payload: { ok: true } });

		const server = (await storedEvents()).map((row) => ({ id: row.id, seq: row.seq }));

		// What the live channel would have delivered: everything the snapshot did not
		// account for. Anything at or below the cursor is dropped by number, which is
		// the whole reason the cursor has to be honest.
		const live = server.filter((row) => row.seq > snapshot!.snapshot_through_seq);
		expect(live.length).toBeGreaterThan(0);

		// A client, implemented exactly as the contract describes: the snapshot
		// REPLACES state, then live events are applied idempotently by id.
		const client = new Map<string, number>();
		let applications = 0;
		const apply = (event: { id: string; seq: number }) => {
			applications += 1;
			client.set(event.id, event.seq);
		};
		for (const event of snapshot!.events) apply({ id: event.id, seq: event.seq });
		// Delivered twice — a reconnect that replays, a duplicated broadcast. Both are
		// ordinary, and both must cost nothing.
		for (const event of live) apply(event);
		for (const event of live) apply(event);

		expect(applications).toBeGreaterThan(client.size);
		expect([...client.values()].sort((a, b) => a - b)).toEqual(server.map((row) => row.seq));
		expect(client.size).toBe(server.length);
		for (const row of server) expect(client.get(row.id)).toBe(row.seq);
		// No gaps: the client holds a contiguous 1..N.
		expect([...client.values()].sort((a, b) => a - b)).toEqual(
			Array.from({ length: server.length }, (_, i) => i + 1),
		);
	});

	it("converges after compaction too: the summary replaces the range it describes", async () => {
		useSetting("HARBOR_EVENT_RETENTION_COUNT", 20);
		useSetting("HARBOR_MAX_SNAPSHOT_EVENTS", 500);
		await seedTurns(6, 10);
		await compactSession(orgId, sessionId);

		const snapshot = (await snapshotSession(orgId, sessionKey))!;
		const client = new Map<number, SessionEvent>();
		for (const event of snapshot.events) client.set(event.seq, event);

		const live = await appendEvents({
			orgId,
			sessionId,
			events: [{ type: "agent_message", payload: { text: "still here" } }],
		});
		for (const event of live) {
			if (event.seq > snapshot.snapshot_through_seq) client.set(event.seq, event);
		}

		const server = await storedEvents();
		expect([...client.keys()].sort((a, b) => a - b)).toEqual(server.map((row) => row.seq));
		// And the client has been told, in the payload, that the compacted range is
		// not something it can ever ask for.
		expect(snapshot.retained_from_seq).toBeGreaterThan(1);
		const belowBoundary = [...client.values()].filter(
			(event) => event.seq < snapshot.retained_from_seq,
		);
		expect(belowBoundary.some((event) => event.payload?.compacted === true)).toBe(true);
	});
});
