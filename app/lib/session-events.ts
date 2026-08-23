// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The session timeline: append, snapshot, page, compact.
 *
 * This module implements the guarantee written down in `SessionSnapshot` in
 * `src/contracts/index.ts`, and it is worth restating which guarantee that is,
 * because the obvious one is unimplementable. It is **convergence**, not
 * exactly-once delivery. A socket can drop after the server has written an event
 * and before the client has applied it, and without an acknowledgement protocol
 * nothing on this side can tell those two cases apart. So a client's state is
 * made to converge on the server's instead:
 *
 *   - a snapshot REPLACES client state rather than merging into it;
 *   - the snapshot says how far it goes (`snapshot_through_seq`);
 *   - live events carry a stable `id` and `seq` and are applied idempotently, so
 *     a duplicate costs nothing and the client never has to reason about whether
 *     it has already seen something;
 *   - anything below `retained_from_seq` was compacted and is stated to be
 *     unreplayable, rather than being discovered as silence by a client that asks.
 *
 * Three decisions here are corrections of the obvious implementation, and each
 * one fixes a failure that is expensive to find in production:
 *
 *  1. **`seq` comes from a counter on the session row, never `max(seq) + 1`.**
 *     The subquery races under READ COMMITTED; see the long note on `appendEvents`.
 *
 *  2. **`snapshot_through_seq` is the end of the contiguous run, not `max(seq)`.**
 *     A hole below the maximum means an event that will yet become visible below
 *     it, and a client told "everything up to 90 is reflected" discards the
 *     missing 87 forever when it arrives on the live channel. See `snapshotMeta`.
 *
 *  3. **Compaction rewrites the oldest event of a run in place** rather than
 *     appending a summary at the end of the timeline. A summary allocated a fresh
 *     seq would sort *after* live events, so a two-day-old turn would render
 *     underneath what the agent said a second ago.
 */

import { and, asc, desc, eq, gt, inArray, lt, sql as raw } from "drizzle-orm";
import { setting } from "@core/kernel/config.js";
import {
	ARTIFACT_KINDS,
	BOOT_MODES,
	DEAD_SANDBOX_STATUSES,
	SESSION_EVENT_TYPES,
	type ArtifactKind,
	type BootMode,
	type SandboxStatus,
	type SessionEvent,
	type SessionEventType,
	type SessionSnapshot,
} from "../contracts/index.js";
import { db } from "@core/schema/index.js";
import {
	artifacts,
	sandboxes,
	sessionEvents,
	sessionParticipants,
	sessionPrompts,
	sessions,
} from "@core/schema/schema.js";
import { HarborError, notifyChange } from "@core/kernel/work.js";

/**
 * The db handle or a transaction on it.
 *
 * Derived from `db.transaction`'s own callback for the same reason `work.ts`
 * does it: casting a transaction to `typeof db` compiles only because the cast
 * silences a real difference — a transaction has no `$client`.
 *
 * Exported because it is the type of `AppendOptions.executor`, which is how a
 * state change and its ledger event share one transaction.
 */
export type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Compile-time exhaustiveness, with a runtime story that is not a crash.
 *
 * Every switch below omits `default`, so adding a member to `SESSION_EVENT_TYPES`
 * is a compile error at each decision point rather than a silent fall-through to
 * whatever the last branch happened to be. This is reached only if a value that
 * TypeScript proved impossible shows up anyway — which for a `text` column read
 * back out of Postgres is not impossible at all, so callers narrow first (see
 * `asEventType`) and this stays the assertion of last resort.
 */
function unreachable(value: never, context: string): never {
	throw new HarborError(`${context}: unhandled variant ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------------------
// Payload bounding
// ---------------------------------------------------------------------------

/**
 * What happened to a payload on its way into the table.
 *
 * `removedChars` is returned rather than logged because the caller — a bridge
 * ingest route, a normalizer — is the only place that knows whether losing 40KB
 * of a tool's stdout is expected (a build log) or a bug (a payload built in a
 * loop). A boolean would answer neither question.
 */
export interface TruncatedPayload {
	payload: Record<string, unknown> | null;
	/** Characters dropped. Zero means the payload was stored verbatim. */
	removedChars: number;
}

/**
 * Serialise the way Postgres will, and never throw on the way in.
 *
 * A payload arriving from a normalizer can contain a `Date`, a `BigInt`, a cycle
 * or a class instance, and `JSON.stringify` throws on two of those. A throw here
 * would lose the *event*, not just the field — an agent's whole turn vanishing
 * from the timeline because one tool returned a circular object is not a trade
 * anyone would make deliberately, so the unrepresentable value is replaced and
 * the event survives.
 */
function safeStringify(value: unknown): string {
	const seen = new WeakSet<object>();
	return (
		JSON.stringify(value, (_key, item) => {
			if (typeof item === "bigint") return `${item}`;
			if (typeof item === "function" || typeof item === "symbol") return undefined;
			if (typeof item === "object" && item !== null) {
				if (seen.has(item)) return "[circular]";
				seen.add(item);
			}
			return item;
		}) ?? "null"
	);
}

interface StringLeaf {
	path: Array<string | number>;
	text: string;
}

/** Every string in the payload, wherever it is nested. Tool output is rarely top level. */
function collectStringLeaves(value: unknown, path: Array<string | number>, out: StringLeaf[]): void {
	if (typeof value === "string") {
		out.push({ path, text: value });
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((item, index) => collectStringLeaves(item, [...path, index], out));
		return;
	}
	if (typeof value === "object" && value !== null) {
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			collectStringLeaves(item, [...path, key], out);
		}
	}
}

function setAtPath(root: unknown, path: Array<string | number>, text: string): void {
	let cursor = root as Record<string | number, unknown>;
	for (const step of path.slice(0, -1)) cursor = cursor[step] as Record<string | number, unknown>;
	cursor[path[path.length - 1]!] = text;
}

/**
 * Bound a payload before it is stored, and say so inside the payload.
 *
 * The limit is `maxEventPayloadChars` and it is a budget for the *whole
 * serialised object*, not per field. Per-field caps are what let a payload with
 * two hundred short fields sail past a limit that exists to keep a snapshot
 * shippable — and a snapshot is the most-repeated payload in the system, sent
 * again on every reconnect.
 *
 * Longest string first, because that is nearly always the one nobody meant to
 * store: a build log, a diff, a `cat` of a lockfile. Cutting it first preserves
 * the small fields — the tool name, the exit code, the file path — that a person
 * reading the timeline actually needs.
 *
 * `harbor_truncated_chars` is written into the payload *before* the cutting
 * starts, so it is inside the budget rather than pushing the result over it, and
 * so the fact of truncation survives every subsequent pass. A client must be able
 * to see that something was removed; discovering it by noticing prose that stops
 * mid-sentence is how a display bug gets filed against the agent.
 */
export function truncatePayload(
	payload: Record<string, unknown> | null | undefined,
	limit: number,
): TruncatedPayload {
	if (payload === null || payload === undefined) return { payload: null, removedChars: 0 };

	const original = safeStringify(payload);
	if (original.length <= limit) {
		// Round-tripping even the untruncated case normalises Dates, undefined and
		// cycles to exactly what jsonb will hold. Returning the caller's object
		// instead would mean the value we hand back differs from the value a reader
		// gets out of the table, which turns "the event I appended is not the event
		// I read" into a debugging session.
		return { payload: JSON.parse(original) as Record<string, unknown>, removedChars: 0 };
	}

	const clone = JSON.parse(original) as Record<string, unknown>;
	clone.harbor_truncated_chars = original.length;

	const leaves: StringLeaf[] = [];
	collectStringLeaves(clone, [], leaves);
	leaves.sort((a, b) => b.text.length - a.text.length);

	for (const leaf of leaves) {
		const current = safeStringify(clone).length;
		if (current <= limit) break;
		const excess = current - limit;
		// One character is kept for the ellipsis whenever anything is kept at all,
		// so a reader can see the cut rather than infer it.
		const keep = Math.max(0, leaf.text.length - excess - 1);
		setAtPath(clone, leaf.path, keep > 0 ? `${leaf.text.slice(0, keep)}…` : "");
	}

	if (safeStringify(clone).length <= limit) {
		return { payload: clone, removedChars: original.length - safeStringify(clone).length };
	}

	// Every string is gone and the structure alone still does not fit: hundreds of
	// keys, or an absurdly small configured limit. Ladder down to progressively
	// smaller honest payloads rather than storing something over budget, because
	// the budget is what stops one pathological event making every future snapshot
	// of this session too large to send.
	const dropped: Record<string, unknown> = {
		harbor_payload_dropped: true,
		harbor_truncated_chars: original.length,
	};
	if (safeStringify(dropped).length <= limit) {
		return { payload: dropped, removedChars: original.length - safeStringify(dropped).length };
	}
	const minimal = { harbor_truncated_chars: original.length };
	if (safeStringify(minimal).length <= limit) {
		return { payload: minimal, removedChars: original.length - safeStringify(minimal).length };
	}
	return { payload: null, removedChars: original.length };
}

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

export interface AppendEventInput {
	orgId: string;
	sessionId: string;
	type: SessionEventType;
	payload?: Record<string, unknown> | null;
	actor?: string | null;
}

export interface AppendEventsInput {
	orgId: string;
	sessionId: string;
	events: Array<{
		type: SessionEventType;
		payload?: Record<string, unknown> | null;
		actor?: string | null;
	}>;
}

/**
 * How an append participates in a caller's transaction.
 *
 * The rule this option exists to enforce: **a state change and the ledger event
 * that records it commit together or not at all.** Before it existed, every
 * sandbox transition committed first and appended its event in a second
 * transaction — a crash between the two produced a sandbox that stopped with no
 * record of why, which is precisely the kind of rare lost fact that is never
 * reproduced at a desk.
 *
 * When `executor` is a caller's transaction, two things change:
 *
 *  - the seq allocation and insert run on that transaction, so they commit and
 *    roll back with the caller's state change;
 *  - **no NOTIFY is sent.** The notify-after-commit invariant (see the comment
 *    at the bottom of `appendEvents`) cannot be honoured from inside somebody
 *    else's transaction, because only the caller knows when it commits. The
 *    caller MUST call `notifyChange(orgId, "session_event")` after its
 *    transaction returns, or every dashboard misses the event until the next
 *    unrelated wakeup.
 */
export interface AppendOptions {
	executor?: Executor;
}

function toWireEvent(row: typeof sessionEvents.$inferSelect): SessionEvent {
	return {
		id: row.id,
		session_id: row.sessionId,
		seq: row.seq,
		// The column is `text`, so this narrowing is a claim rather than a proof.
		// It is made here, once, at the edge where rows become wire objects —
		// scattering the cast through consumers is how three spellings of the same
		// type end up in three switches.
		type: row.type as SessionEventType,
		payload: (row.payload ?? null) as Record<string, unknown> | null,
		actor: row.actor,
		created_at: row.createdAt.toISOString(),
	};
}

/**
 * Append one event and return it in wire shape.
 *
 * A single append is a batch of one, deliberately. Two implementations of seq
 * allocation is two places for the counter discipline to drift, and the drift
 * would show up only under concurrency — the one condition nobody reproduces at a
 * desk.
 */
export async function appendEvent(
	input: AppendEventInput,
	options?: AppendOptions,
): Promise<SessionEvent> {
	const [event] = await appendEvents(
		{
			orgId: input.orgId,
			sessionId: input.sessionId,
			events: [{ type: input.type, payload: input.payload, actor: input.actor }],
		},
		options,
	);
	return event!;
}

/**
 * Append a run of events under a single seq allocation and a single transaction.
 *
 * **Why the counter, and not `max(seq) + 1`.** Under READ COMMITTED two
 * concurrent transactions cannot see each other's uncommitted rows, so both read
 * the same maximum, both compute the same next number, and the unique index on
 * `(session_id, seq)` rejects the loser. The visible symptom is an agent's
 * sentence silently missing from the transcript while two prompts run in one
 * room — exactly the situation multiplayer exists to support. `queuePrompt` in
 * `sessions.ts` allocates prompt numbers the same way for the same reason. An
 * `UPDATE ... RETURNING` on the session row takes a row lock, so the second
 * transaction waits and is handed the next number instead of colliding.
 *
 * That lock does more than hand out numbers: because it is held until commit,
 * events become visible in seq order, so a reader never sees seq 90 while 89 is
 * still in flight. `snapshotMeta` does not lean on that — a transaction that
 * allocates and then rolls back leaves a permanent hole, and a future append path
 * written by someone who has not read this comment might not take the lock at all
 * — but it is why holes are rare rather than routine.
 *
 * **Why a batch variant exists at all.** Token streaming produces hundreds of
 * events a second. One transaction each is a write storm on a single row: every
 * append takes the same lock, so the whole stream serialises through it, and each
 * one costs a round trip, a WAL flush and a NOTIFY. One transaction for the run
 * takes the lock once, allocates a contiguous range with one arithmetic
 * expression, and inserts in a single statement.
 */
export async function appendEvents(
	input: AppendEventsInput,
	options?: AppendOptions,
): Promise<SessionEvent[]> {
	if (input.events.length === 0) return [];

	const limit = setting("maxEventPayloadChars");
	const bounded = input.events.map((event) => ({
		type: event.type,
		actor: event.actor ?? null,
		payload: truncatePayload(event.payload, limit).payload,
	}));

	const run = async (tx: Executor) => {
		const [session] = await tx
			.update(sessions)
			.set({
				nextEventSeq: raw`${sessions.nextEventSeq} + ${bounded.length}`,
				lastActivityAt: new Date(),
			})
			// The org predicate is the authority check, and it FAILS CLOSED: a session
			// this org cannot see is indistinguishable here from a session that does
			// not exist, and both refuse. That asymmetry is deliberate and is the
			// opposite of the liveness decision in `pickSandbox` below — an unknown
			// authority must never be treated as permission, because the failure mode
			// is one tenant writing into another tenant's transcript, while an unknown
			// liveness treated as dead throws away a box that is still working.
			.where(and(eq(sessions.id, input.sessionId), eq(sessions.orgId, input.orgId)))
			.returning({ nextEventSeq: sessions.nextEventSeq });
		if (!session) throw new HarborError("No such session.");

		// `nextEventSeq` is post-increment: the range this batch owns ends one below
		// the value now on the row.
		const firstSeq = session.nextEventSeq - bounded.length;

		return tx
			.insert(sessionEvents)
			.values(
				bounded.map((event, index) => ({
					orgId: input.orgId,
					sessionId: input.sessionId,
					seq: firstSeq + index,
					type: event.type,
					payload: event.payload,
					actor: event.actor,
				})),
			)
			.returning();
	};

	// On a caller's executor the rows are not yet committed when this returns —
	// the caller owns the commit and the NOTIFY that must follow it (see
	// AppendOptions). A NOTIFY sent here would arrive before the rows are
	// visible, and a wakeup that arrives too early is worse than none.
	if (options?.executor) {
		const rows = await run(options.executor);
		return rows.map(toWireEvent);
	}

	const rows = await db.transaction(run);

	// After commit, never inside. A listener woken by a NOTIFY sent inside the
	// transaction reads the table before the rows are visible and concludes there
	// is nothing new — a wakeup that arrives too early is worse than none, because
	// the next one may be a minute away.
	await notifyChange(input.orgId, "session_event");

	return rows.map(toWireEvent);
}

// ---------------------------------------------------------------------------
// Retention boundary
// ---------------------------------------------------------------------------

/**
 * The oldest seq that is still individually replayable.
 *
 * Not the oldest surviving row. Compaction folds a run into its first event and
 * deletes the rest, so the summary sits at the *bottom* of a range that no longer
 * exists — the boundary is the seq after that range's end, which the summary
 * records as `to_seq`. Deriving it from `min(seq)` instead would report a
 * retention boundary of 1 for a session whose first four thousand events are
 * gone, and every client that trusted it would ask for events that will never
 * arrive.
 *
 * Takes no org id on purpose. It returns a single integer derived from rows the
 * caller already identified by primary key; there is nothing here to leak across
 * a tenant boundary, and the callers that do carry authority (`snapshotSession`,
 * `eventPage`) check it themselves before they get this far.
 */
export async function retainedFromSeq(sessionId: string): Promise<number> {
	return retainedFromSeqWith(db, sessionId);
}

async function retainedFromSeqWith(
	ex: Executor,
	sessionId: string,
	fallbackSeq?: number,
): Promise<number> {
	// `to_seq` is written by this module, but the regex guard stays: a malformed
	// value would otherwise make the cast throw and take out every snapshot of the
	// session, and a wrong-but-conservative boundary is a far cheaper failure than
	// a session nobody can open.
	const rows = (await ex.execute(raw`
		select
			max(
				case
					when ${sessionEvents.payload}->>'to_seq' ~ '^[0-9]+$'
						then greatest((${sessionEvents.payload}->>'to_seq')::int, ${sessionEvents.seq})
					else ${sessionEvents.seq}
				end
			) filter (where ${sessionEvents.compactedAt} is not null) as compacted_through,
			min(${sessionEvents.seq}) as min_seq
		from ${sessionEvents}
		where ${sessionEvents.sessionId} = ${sessionId}
	`)) as unknown as Array<{ compacted_through: number | null; min_seq: number | null }>;

	const compactedThrough = rows[0]?.compacted_through ?? null;
	if (compactedThrough !== null) return Number(compactedThrough) + 1;

	const minSeq = rows[0]?.min_seq ?? null;
	if (minSeq !== null) return Number(minSeq);

	// No events at all. The oldest replayable seq is the next one that will be
	// handed out, so a client that attaches to a brand-new session and is told
	// `retained_from_seq = 1` does not conclude that history was compacted.
	if (fallbackSeq !== undefined) return fallbackSeq;
	const [session] = await ex
		.select({ next: sessions.nextEventSeq })
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.limit(1);
	return session?.next ?? 1;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

interface SnapshotMeta {
	throughSeq: number;
	totalEvents: number;
}

/**
 * How far this snapshot honestly goes, and how much history exists.
 *
 * `snapshot_through_seq` is **the end of the contiguous run above the retention
 * boundary**, not `max(seq)`. The difference is the whole correctness of
 * reconnection. Suppose seq 87 is allocated by a transaction that has not
 * committed while 88, 89 and 90 have. `max(seq)` says 90, the client is told
 * everything up to 90 is reflected, 87 commits a millisecond later and is
 * broadcast — and the client, following the contract exactly, discards it as
 * already-seen. The event is gone from that client until it next reloads the
 * page, and nothing anywhere logs an error.
 *
 * Stopping at the gap has its own cost: a transaction that allocated a seq and
 * then rolled back leaves a hole that nothing will ever fill, and the cursor is
 * pinned below it forever, so every reconnect re-sends events the client already
 * has. That is the direction to fail in. Re-applying an event is defined to be a
 * no-op by point 3 of the snapshot contract; losing one is not defined at all.
 */
async function snapshotMeta(
	ex: Executor,
	sessionId: string,
	retainedFrom: number,
): Promise<SnapshotMeta> {
	const rows = (await ex.execute(raw`
		with retained as (
			select ${sessionEvents.seq} as seq
			from ${sessionEvents}
			where ${sessionEvents.sessionId} = ${sessionId} and ${sessionEvents.seq} >= ${retainedFrom}
		), ordered as (
			select seq, lead(seq) over (order by seq) as next_seq from retained
		)
		select
			(select min(seq) from ordered where next_seq is not null and next_seq <> seq + 1)
				as before_gap,
			(select max(seq) from retained) as max_seq,
			(select count(*) from ${sessionEvents} where ${sessionEvents.sessionId} = ${sessionId})
				as total
	`)) as unknown as Array<{
		before_gap: number | null;
		max_seq: number | null;
		total: number | string;
	}>;

	const row = rows[0];
	const beforeGap = row?.before_gap ?? null;
	const maxSeq = row?.max_seq ?? null;
	const throughSeq =
		beforeGap !== null
			? Number(beforeGap)
			: maxSeq !== null
				? Number(maxSeq)
				// Nothing retained yet: everything at or below the boundary minus one is
				// accounted for by the compacted summaries already in `events`.
				: retainedFrom - 1;

	return { throughSeq, totalEvents: Number(row?.total ?? 0) };
}

/**
 * Which sandbox the client is shown, and the fail-OPEN half of the asymmetry.
 *
 * A session accumulates one sandbox row per boot, and the client wants the one it
 * can talk to. Liveness is decided with a DENY-list — `DEAD_SANDBOX_STATUSES` —
 * so a status this build has never heard of counts as LIVE. Written as an
 * allow-list, a status added next year defaults to dead and the UI abandons a box
 * that is demonstrably running, with no error anywhere because every layer
 * believed it was behaving correctly. Compare the authority check in
 * `appendEvents`, which fails CLOSED for the opposite reason: an unknown
 * authority treated as permission is a tenant boundary hole, while an unknown
 * liveness treated as dead is only lost work.
 *
 * If every box is dead the newest one is still returned. "Stopped" is information
 * the client needs in order to offer a resume button; hiding it produces a
 * session that looks like it never had a sandbox at all.
 */
function pickSandbox<T extends { status: string }>(rows: T[]): T | null {
	const live = rows.find((row) => !DEAD_SANDBOX_STATUSES.includes(row.status as SandboxStatus));
	return live ?? rows[0] ?? null;
}

function asArtifactKind(kind: string): ArtifactKind {
	// An unrecognised kind is rendered as a generic file rather than dropped. The
	// dashboard renders nothing for a kind it does not know, so dropping the row
	// here would make a real artifact — a PR someone is looking for — invisible,
	// and invisible is harder to report than dull.
	return (ARTIFACT_KINDS as readonly string[]).includes(kind) ? (kind as ArtifactKind) : "file";
}

function asBootMode(mode: string | null): BootMode | null {
	return mode !== null && (BOOT_MODES as readonly string[]).includes(mode)
		? (mode as BootMode)
		: null;
}

/**
 * Everything a client needs the instant it attaches, and nothing it does not.
 *
 * Assembled inside one REPEATABLE READ, READ ONLY transaction. Under READ
 * COMMITTED each statement gets its own view of the database, so a snapshot built
 * from six statements can contain an artifact whose creating event is not in
 * `events` and a prompt that arrived after the events were read — and
 * `snapshot_through_seq`, computed from a seventh view, describes none of them.
 * The result is a client that is internally inconsistent in a way no amount of
 * live events will repair, because the live channel only carries what happens
 * *next*. One consistent read costs nothing here and makes the cursor true.
 *
 * Sandbox credentials are deliberately absent, as the contract says: a snapshot
 * can be logged, cached and replayed, so a bug in this function leaks state and
 * never secrets. Those are different severities and the difference is worth
 * preserving structurally rather than by remembering.
 */
export async function snapshotSession(
	orgId: string,
	sessionKey: string,
): Promise<SessionSnapshot | null> {
	const cap = setting("maxSnapshotEvents");

	return db.transaction(
		async (tx) => {
			const [session] = await tx
				.select()
				.from(sessions)
				.where(and(eq(sessions.orgId, orgId), eq(sessions.key, sessionKey)))
				.limit(1);
			// Null, not an error, and scoped by org so a key belonging to another
			// tenant is indistinguishable from a key that was never minted. A distinct
			// "wrong org" response would turn the session key space into an oracle
			// anyone could probe for valid keys.
			if (!session) return null;

			const retainedFrom = await retainedFromSeqWith(tx, session.id, session.nextEventSeq);
			const meta = await snapshotMeta(tx, session.id, retainedFrom);

			// The tail, not the head. A client attaching to a two-day-old session wants
			// what just happened; the beginning is reachable with `eventPage` and is
			// almost never looked at.
			const tail = await tx
				.select()
				.from(sessionEvents)
				.where(eq(sessionEvents.sessionId, session.id))
				.orderBy(desc(sessionEvents.seq))
				.limit(cap);
			tail.reverse();

			// Capped like every other list in the snapshot. This was the ONE query
			// here without a limit — the note below about a second uncapped list
			// defeating the event budget described participants exactly. Earliest
			// joiners kept: the creator and the room's regulars, which is who a
			// client rendering "who is here" actually shows.
			const participants = await tx
				.select()
				.from(sessionParticipants)
				.where(eq(sessionParticipants.sessionId, session.id))
				.orderBy(asc(sessionParticipants.joinedAt))
				.limit(cap);

			// Prompts and artifacts share the snapshot's event budget rather than
			// having caps of their own. The cap exists because of total payload size
			// on a reconnect storm, and a second uncapped list would defeat it.
			const prompts = await tx
				.select()
				.from(sessionPrompts)
				.where(eq(sessionPrompts.sessionId, session.id))
				.orderBy(desc(sessionPrompts.seq))
				.limit(cap);
			prompts.reverse();

			const boxes = await tx
				.select()
				.from(sandboxes)
				.where(eq(sandboxes.sessionId, session.id))
				.orderBy(desc(sandboxes.createdAt))
				.limit(cap);

			const producedArtifacts = await tx
				.select()
				.from(artifacts)
				.where(eq(artifacts.sessionId, session.id))
				.orderBy(desc(artifacts.createdAt))
				.limit(cap);
			producedArtifacts.reverse();

			const box = pickSandbox(boxes);

			return {
				session: {
					id: session.id,
					key: session.key,
					title: session.title,
					status: session.status,
					created_by: session.createdBy,
					created_at: session.createdAt.toISOString(),
					last_activity_at: session.lastActivityAt.toISOString(),
					repo_id: session.repoId,
					environment_id: session.environmentId,
					base_branch: session.baseBranch,
				},
				snapshot_through_seq: meta.throughSeq,
				retained_from_seq: retainedFrom,
				truncated: meta.totalEvents > tail.length,
				events: tail.map(toWireEvent),
				participants: participants.map((row) => ({
					participant: row.participant,
					kind: row.kind,
					last_seen_at: row.lastSeenAt.toISOString(),
				})),
				prompts: prompts.map((row) => ({
					seq: row.seq,
					author: row.author,
					author_kind: row.authorKind,
					body: row.body,
					status: row.status,
					created_at: row.createdAt.toISOString(),
				})),
				sandbox: box
					? {
							id: box.id,
							// Passed through even when this build does not recognise it. The
							// alternative — mapping an unknown status onto a known one — makes
							// the client act on a status the server never reported.
							status: box.status as SandboxStatus,
							provider: box.provider,
							boot_mode: asBootMode(box.bootMode),
						}
					: null,
				artifacts: producedArtifacts.map((row) => ({
					id: row.id,
					kind: asArtifactKind(row.kind),
					title: row.title,
					url: row.url,
					created_at: row.createdAt.toISOString(),
				})),
			} satisfies SessionSnapshot;
		},
		{ isolationLevel: "repeatable read", accessMode: "read only" },
	);
}

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

export interface EventPage {
	/** Ascending by seq, so a client can apply them in order without re-sorting. */
	events: SessionEvent[];
	/** More retained history exists below the first event returned. */
	has_more: boolean;
	/** Repeated on every page: below this, history was compacted and is gone. */
	retained_from_seq: number;
}

/**
 * Walk through retained history: backwards from `before`, or forwards from
 * `after`, for a client that got `truncated: true` or is filling a reconnect gap.
 *
 * Both cursors are exclusive and are seqs rather than offsets or timestamps. An
 * offset shifts under compaction — pages overlap or skip while the client is
 * paging — and two events can share a timestamp to the millisecond, which makes a
 * timestamp cursor either lossy or duplicating depending on which comparison you
 * pick. A seq is unique per session and stable for the life of the row.
 *
 * `before` and `after` together are refused: a range query answers a question
 * neither pager asks, and accepting both silently would leave the caller
 * guessing which one `has_more` refers to. `has_more` always points away from
 * the cursor — more history below the page for `before`, more above it for
 * `after`.
 *
 * The compacted summaries are returned like any other event, because they are
 * real rows and they are how a client learns what happened in the range it can no
 * longer fetch. Filtering them out would leave a client paging back through a
 * timeline that appears to have simply started later than it did.
 */
export async function eventPage(
	orgId: string,
	sessionId: string,
	options: { before?: number; after?: number; limit?: number } = {},
): Promise<EventPage> {
	if (options.before !== undefined && options.after !== undefined) {
		throw new HarborError("Pass either `before` or `after`, not both.");
	}
	const cap = setting("maxSnapshotEvents");
	const limit = Math.max(1, Math.min(options.limit ?? cap, cap));

	// Authority first and fails closed, exactly as in `appendEvents`: a session
	// this org cannot see is refused rather than answered with an empty page. An
	// empty page reads as "no history", which is a claim about another tenant's
	// session that this caller is not entitled to make or to hear.
	const [session] = await db
		.select({ id: sessions.id })
		.from(sessions)
		.where(and(eq(sessions.id, sessionId), eq(sessions.orgId, orgId)))
		.limit(1);
	if (!session) throw new HarborError("No such session.");

	const forward = options.after !== undefined;
	const conditions = [eq(sessionEvents.sessionId, sessionId)];
	if (options.before !== undefined) conditions.push(lt(sessionEvents.seq, options.before));
	if (options.after !== undefined) conditions.push(gt(sessionEvents.seq, options.after));

	// One extra row rather than a second count query: it answers "is there more"
	// exactly, including the case where the remaining history is precisely one
	// page, which a count-based guess gets wrong in whichever direction rounds.
	const rows = await db
		.select()
		.from(sessionEvents)
		.where(and(...conditions))
		.orderBy(forward ? asc(sessionEvents.seq) : desc(sessionEvents.seq))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const page = forward ? rows.slice(0, limit) : rows.slice(0, limit).reverse();

	return {
		events: page.map(toWireEvent),
		has_more: hasMore,
		retained_from_seq: await retainedFromSeq(sessionId),
	};
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

/**
 * What compaction is allowed to do with an event type.
 *
 * The switch has no `default`, so adding a member to `SESSION_EVENT_TYPES` is a
 * compile error right here — which is the point. The dangerous way to write this
 * is a list of foldable types and an `else` that folds everything not on it: a
 * new `budget_exhausted` event would then be silently swallowed into a summary,
 * and the record of *why a session stopped* would disappear from exactly the
 * sessions where someone is trying to work out why it stopped.
 *
 *  - `foldable`  — token-level chatter. Hundreds per turn, individually worthless
 *                  after the fact, collectively the reason the table grows.
 *  - `structural`— the spine of the timeline: what was asked, what was produced,
 *                  what was refused, how it ended. Never folded, at any age.
 */
export type CompactionRole = "foldable" | "structural";

export function compactionRole(type: SessionEventType): CompactionRole {
	switch (type) {
		case "agent_message":
		case "agent_tool_call":
			return "foldable";
		case "session_created":
		case "prompt_queued":
		case "prompt_delivered":
		case "prompt_finished":
		case "sandbox_requested":
		case "sandbox_spawning":
		case "sandbox_ready":
		case "sandbox_failed":
		case "sandbox_stopped":
		case "sandbox_snapshotted":
		case "agent_finished":
		case "artifact_created":
		case "policy_denied":
		case "budget_exhausted":
		case "session_error":
		case "participant_joined":
		// A gap marker folded into a summary is exactly the silent hole the marker
		// exists to prevent — the one event type whose entire value is being seen.
		case "transcript_gap":
			return "structural";
	}
	return unreachable(type, "compactionRole");
}

/**
 * Narrow a `text` column back to the closed set.
 *
 * Returns null rather than throwing for a type this build does not know, and the
 * caller treats null as structural — an event we cannot classify is never folded.
 * A deployment mid-rollout has a newer writer and an older compactor in the same
 * database for minutes at a time, and during those minutes the older compactor
 * must not delete rows whose meaning it does not understand.
 */
function asEventType(type: string): SessionEventType | null {
	return (SESSION_EVENT_TYPES as readonly string[]).includes(type)
		? (type as SessionEventType)
		: null;
}

export interface CompactionResult {
	/** Rows removed from the timeline. Zero means the session was already compact. */
	compacted: number;
	/** Rows the session has left, summaries included. */
	remaining: number;
}

function textOf(payload: unknown): string | null {
	if (typeof payload !== "object" || payload === null) return null;
	const record = payload as Record<string, unknown>;
	for (const key of ["text", "message", "content", "delta"]) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return null;
}

function toolOf(payload: unknown): string | null {
	if (typeof payload !== "object" || payload === null) return null;
	const record = payload as Record<string, unknown>;
	for (const key of ["tool", "tool_name", "name"]) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return null;
}

/**
 * Fold the oldest chatter into summarised turns and delete the originals.
 *
 * A session streaming tokens for two days accumulates events without bound, and
 * the snapshot — the single most-repeated payload in the system — has to read
 * past all of them. `eventRetentionCount` is where full fidelity stops: the
 * newest N events are kept as they are, everything older is eligible.
 *
 * Four properties this implementation has, each because the obvious alternative
 * breaks something:
 *
 *  1. **The summary keeps the run's lowest seq and is written in place.** A
 *     summary appended with a fresh seq would sort after live events, putting a
 *     two-day-old turn underneath what the agent said a second ago. Writing in
 *     place also means a client that already holds that seq sees an update to a
 *     row it knows rather than a hole plus a stranger.
 *
 *  2. **It is idempotent.** `compactedAt` marks the survivor, and a marked row is
 *     never folded again, so a second pass does not summarise a summary — which
 *     would multiply the counts and lose the original seq range with each run.
 *
 *  3. **Structural events are never folded**, so what was asked, what was
 *     produced, what policy refused and how the turn ended survive at any age.
 *     They also delimit runs, which is what makes a summary correspond to a turn
 *     rather than to an arbitrary window.
 *
 *  4. **One pass touches at most the eligible rows.** A run that reaches the edge
 *     of the eligible region is folded anyway rather than held back for a later
 *     pass; two adjacent summaries with adjacent, honestly-labelled ranges are a
 *     cosmetic wart, whereas waiting for a turn boundary means a session that
 *     never emits `agent_finished` — a crashed bridge, a hung tool — has one
 *     infinite turn and is never compacted at all. That session is precisely the
 *     one that needs compacting.
 */
export async function compactSession(orgId: string, sessionId: string): Promise<CompactionResult> {
	const retention = setting("eventRetentionCount");
	const payloadLimit = setting("maxEventPayloadChars");

	const result = await db.transaction(async (tx) => {
		const [session] = await tx
			.select({ id: sessions.id })
			.from(sessions)
			.where(and(eq(sessions.id, sessionId), eq(sessions.orgId, orgId)))
			.limit(1);
		// Fails closed for the same reason as every other authority check here.
		if (!session) throw new HarborError("No such session.");

		const [counted] = (await tx.execute(raw`
			select count(*) as total from ${sessionEvents}
			where ${sessionEvents.sessionId} = ${sessionId}
		`)) as unknown as Array<{ total: number | string }>;
		const total = Number(counted?.total ?? 0);
		if (total <= retention) return { compacted: 0, remaining: total };

		// `FOR UPDATE` so two compactors on the same session cannot both fold the
		// same run. The second blocks, and under READ COMMITTED it re-evaluates
		// after the first commits — so it sees the summary (marked, therefore
		// skipped) and not the rows that no longer exist. Without it both build a
		// summary, one deletes the rows the other is describing, and the survivor's
		// counts describe a range that is partly imaginary.
		const eligible = await tx
			.select()
			.from(sessionEvents)
			.where(eq(sessionEvents.sessionId, sessionId))
			.orderBy(asc(sessionEvents.seq))
			.limit(total - retention)
			.for("update");

		type Row = (typeof eligible)[number];
		const runs: Row[][] = [];
		let current: Row[] = [];
		for (const row of eligible) {
			const type = asEventType(row.type);
			const foldable =
				row.compactedAt === null && type !== null && compactionRole(type) === "foldable";
			if (foldable) {
				current.push(row);
				continue;
			}
			if (current.length > 0) runs.push(current);
			current = [];
		}
		if (current.length > 0) runs.push(current);

		let removed = 0;
		for (const run of runs) {
			// A run of one is already its own best summary. Rewriting it would burn a
			// write and replace real content with a description of that content.
			if (run.length < 2) continue;

			const head = run[0]!;
			const tail = run[run.length - 1]!;
			const messages = run.filter((row) => row.type === "agent_message");
			const toolCalls = run.filter((row) => row.type === "agent_tool_call");
			const tools = [...new Set(toolCalls.map((row) => toolOf(row.payload)).filter(Boolean))];
			const actors = new Set(run.map((row) => row.actor ?? "harbor"));
			const preview = messages.map((row) => textOf(row.payload)).find((text) => text !== null);

			const summary = truncatePayload(
				{
					compacted: true,
					from_seq: head.seq,
					to_seq: tail.seq,
					event_count: run.length,
					message_count: messages.length,
					tool_call_count: toolCalls.length,
					tools,
					replayable: false,
					note:
						"Harbor compacted this range. The individual events between from_seq and "
						+ "to_seq were deleted and cannot be replayed one by one.",
					preview: preview ?? null,
				},
				payloadLimit,
			).payload;

			await tx
				.update(sessionEvents)
				.set({
					// The run may have started with a tool call; the survivor is a message
					// either way, because a summary of a turn is prose and a client
					// switching on `agent_tool_call` would try to render it as a tool.
					type: "agent_message",
					payload: summary,
					actor: actors.size === 1 ? (head.actor ?? null) : "harbor",
					compactedAt: new Date(),
				})
				.where(eq(sessionEvents.id, head.id));

			const doomed = run.slice(1).map((row) => row.id);
			await tx.delete(sessionEvents).where(inArray(sessionEvents.id, doomed));
			removed += doomed.length;
		}

		return { compacted: removed, remaining: total - removed };
	});

	// A no-op compaction is not news. Waking every attached client to tell them
	// nothing changed is how a periodic sweep turns into a periodic thundering
	// herd of snapshot reads.
	if (result.compacted > 0) await notifyChange(orgId, "session_compacted");
	return result;
}

/**
 * The driver the compaction loop calls: find sessions over the retention count
 * and compact each.
 *
 * The candidate filter is `next_event_seq`, which over-approximates — it counts
 * events that were themselves already compacted away — but it is one indexed
 * column on the row the loop was going to read anyway, and `compactSession`
 * recounts precisely inside its own transaction. An exact candidate query would
 * be a `count(*)` per session per pass, which is the scan this bound exists to
 * avoid. A session that slips through does one cheap no-op compaction.
 *
 * One session's failure never stops the batch, for the same reason as
 * `tickSessions`: the alternative symptom is "compaction stopped everywhere"
 * caused by one wedged room.
 */
export async function compactEligibleSessions(now = new Date()): Promise<{
	examined: number;
	compacted: number;
}> {
	void now;
	const retention = setting("eventRetentionCount");
	// harbor-lint-allow-constant: a batch size, not a tunable — same reasoning as
	// sessionsPerTick in session-tick.ts. The remainder is picked up next pass.
	const BATCH = 20;

	const candidates = await db
		.select({ id: sessions.id, orgId: sessions.orgId })
		.from(sessions)
		.where(gt(sessions.nextEventSeq, retention + 1))
		.limit(BATCH);

	let compacted = 0;
	for (const candidate of candidates) {
		try {
			const result = await compactSession(candidate.orgId, candidate.id);
			compacted += result.compacted;
		} catch (error) {
			console.error(`[compaction] session ${candidate.id} failed:`, error);
		}
	}
	return { examined: candidates.length, compacted };
}
