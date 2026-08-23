// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The loop that drives one session, and the authority checks that guard the
 * sandbox's edge of the wire.
 *
 * Harbor has no per-session actor process and no leader election service. The
 * single-writer property that a session needs — exactly one runner deciding what
 * happens next — is bought with one Postgres call:
 * `pg_try_advisory_lock`. A second runner that cannot take the lock returns
 * immediately with a typed "somebody else has it" rather than blocking, because a
 * blocked runner is a held connection and a queue of them is an outage that
 * presents as the whole product being slow.
 *
 * The order inside the loop is the design, and every step is there because
 * reversing it costs something specific:
 *
 *   1. **Take the lock.** Everything below assumes it is the only writer.
 *   2. **Promptability.** An archived room must not spend money, and the check is
 *      a total function so a new session status cannot skip it (`promptability.ts`).
 *   3. **Budget.** Read before anything is charged, and refused if the state
 *      cannot be determined — authority fails closed.
 *   4. **Peek the queue, by PRIORITY then seq.**
 *   5. **CLAIM — before the sandbox exists.** This is the whole admission control
 *      mechanism, and it is only affordable because coordination is a row write:
 *      a duplicate unit of work costs one INSERT that fails, instead of a
 *      container and a bag of tokens.
 *   6. **Dequeue**, then ensure a sandbox, then deliver.
 *
 * ---------------------------------------------------------------------------
 * WHY THE QUEUE IS NOT STRICT FIFO
 * ---------------------------------------------------------------------------
 *
 * A human waiting on a one-word correction must not queue behind an automation's
 * forty-minute job. That is not a nicety; at fleet scale strict FIFO is a
 * usability defect that makes the product feel broken precisely when somebody is
 * paying attention to it. So there are two priority classes, derived from the
 * prompt's `authorKind`: a human's prompt is admitted ahead of an agent's
 * regardless of arrival order, and ties are broken by `seq` so ordering within a
 * class is still exactly what the room saw.
 *
 * Derived rather than stored, because this file may not change the schema. What
 * belongs there instead is written down in the note on `promptPriority`.
 *
 * ---------------------------------------------------------------------------
 * WHAT HAPPENS WHEN A LEASE LAPSES MID-FLIGHT — decided, not left open
 * ---------------------------------------------------------------------------
 *
 * A runner's lease can expire while its session is still in flight: the process
 * was paused, the box was slow, the operator's laptop slept. Another runner then
 * legitimately claims the same task. **Harbor reuses the same session** and
 * records the handoff as an event naming the previous holder.
 *
 * That is cheap here for one structural reason: the transcript lives in Postgres,
 * in `session_events`, not in a per-session in-memory store owned by whoever was
 * driving. There is nothing to migrate, nothing to replay into a new room, and no
 * window in which half the history is in one place and half in another. The new
 * runner reads the same rows the old one wrote.
 *
 * The two alternatives were considered and are strictly worse *given that fact*:
 *
 *   - **A child session with a `predecessor_id`.** Correct in a design where the
 *     transcript is per-runner state, because then continuing in the old room is
 *     impossible. Here it buys nothing and costs the user their room: the link
 *     they shared, the thread a connector posted into, and the URL in somebody's
 *     bookmark all now point at a session that stopped moving.
 *   - **Ledger-based discovery**, where a new runner reconstructs state by
 *     replaying a log of intents. That is what you build when there is no single
 *     consistent store to read. There is one; it is the same Postgres that just
 *     handed out the lease.
 *
 * The handoff is recorded rather than silent because the one question worth
 * answering after a confusing session is "who was driving when this happened",
 * and an unlogged change of driver makes that unanswerable.
 */

import { and, asc, eq, isNull, sql as raw } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import type { RepoOverrides } from "@core/kernel/config.js";
import { setting } from "@core/kernel/config.js";
import type { SpawnOutcome, SpawnRefusal } from "../contracts/index.js";
import { db, sql } from "@core/schema/index.js";
import { claims, sandboxes, sessionPrompts, sessions } from "@core/schema/schema.js";
import { assertNever } from "../sandbox/decisions.js";
import type { EnsureSandboxInput, FenceVerdict } from "../sandbox/manager.js";
import { ensureSandbox } from "../sandbox/manager.js";
import { budgetStatus } from "./cost.js";
import { secretEquals } from "./crypto.js";
import type { LockOutcome } from "@core/kernel/locks.js";
import { sessionLock, withLock } from "@core/kernel/locks.js";
import { promptabilityOf } from "./promptability.js";
import { appendEvent } from "./session-events.js";
import { queuePrompt } from "./sessions.js";
import { claim, HarborError, notifyChange, release } from "@core/kernel/work.js";

// ---------------------------------------------------------------------------
// Single writer
// ---------------------------------------------------------------------------

/**
 * The per-session single-writer property, which now lives in `src/lib/locks.ts`.
 *
 * The namespacing rationale moved there with it: advisory locks are global to the
 * database and keyed only by integers, so two unrelated features that both hash an
 * id into a lock key silently serialise against each other — and can deadlock if
 * either ever takes the other's lock second. `cost.ts` reserves `HBUD` for budget
 * admission; sessions are `HSES`, and the value is findable as ASCII in `pg_locks`
 * when somebody is staring at a stuck query.
 */
export type SessionLockOutcome<T> = LockOutcome<T>;

/**
 * Run `body` as the only writer for this session, or return without running it.
 *
 * A thin name over `withLock(sessionLock(id), body)`. It stays because the call
 * sites read better for it and because "the session's single writer" is a concept
 * worth having a name for even when its implementation is one line — the reasoning
 * that makes it correct (reserved connection, session-scoped rather than
 * transaction-scoped, no re-entrancy) is in `src/lib/locks.ts`.
 */
export async function withSessionLock<T>(
	sessionId: string,
	body: () => Promise<T>,
): Promise<SessionLockOutcome<T>> {
	return withLock(sessionLock(sessionId), body);
}

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

/**
 * Who wrote a prompt, as a closed set.
 *
 * `session_prompts.author_kind` is a `text` column defaulting to `human`, so this
 * is a claim about our own writers. `priorityOfAuthorKind` guards the boundary.
 */
export const PROMPT_AUTHOR_KINDS = ["human", "agent"] as const;
export type PromptAuthorKind = (typeof PROMPT_AUTHOR_KINDS)[number];

/**
 * The two priority classes. Lower sorts first, like every other priority queue
 * anybody has ever read, so nobody has to check.
 *
 * Two classes is the *minimum* and is what this build ships. It is enough to fix
 * the defect that matters — a person waiting behind a batch job — and it is small
 * enough to reason about: within a class, order is arrival order, so the room
 * still behaves the way the people in it watched it behave.
 *
 * **What I would add given a schema change.** `session_prompts.priority smallint
 * not null default 100`, written at enqueue from the author kind and from the
 * caller's own intent, plus an index on `(session_id, status, priority, seq)` so
 * the dequeue below is one index scan instead of a sort. A column beats this
 * derivation for three concrete reasons: an operator could bump one stuck prompt
 * without impersonating a human; an interrupt ("stop, you're editing the wrong
 * file") could sort above an ordinary human prompt instead of tying with it; and
 * the ordering would survive somebody adding a third author kind, which today
 * silently lands in the agent class. Until then, `authorKind` plus this
 * convention is the honest approximation, and it is expressed in one place so the
 * migration is a one-line change here.
 */
export const PROMPT_PRIORITY_HUMAN = 0;
export const PROMPT_PRIORITY_AGENT = 1;

/** Exhaustive over the closed set: a third author kind is a compile error here. */
export function promptPriority(kind: PromptAuthorKind): number {
	switch (kind) {
		case "human":
			return PROMPT_PRIORITY_HUMAN;
		case "agent":
			return PROMPT_PRIORITY_AGENT;
	}
	return assertNever(kind, "promptPriority");
}

/**
 * The same question about a raw column value.
 *
 * An unrecognised kind lands in the *agent* class, and the direction is chosen
 * rather than defaulted: a string nobody planned for must not be able to jump
 * ahead of a person who is sitting there waiting. The cost of being wrong this way
 * is that a future "reviewer" kind waits its turn; the cost of being wrong the
 * other way is that anything can starve a human by inventing an author kind.
 */
export function priorityOfAuthorKind(rawKind: string): number {
	const kind = rawKind.trim().toLowerCase();
	return (PROMPT_AUTHOR_KINDS as readonly string[]).includes(kind)
		? promptPriority(kind as PromptAuthorKind)
		: PROMPT_PRIORITY_AGENT;
}

/**
 * The ORDER BY that implements the two classes, as one SQL fragment.
 *
 * Written once and shared by the peek and the take so they cannot disagree. If
 * they did, the runner would peek at a human's prompt, claim a lease for it, and
 * then dequeue an automation's — and the trace would name the wrong prompt as the
 * reason a container was booted.
 */
function priorityExpression() {
	return raw`case when lower(${sessionPrompts.authorKind}) = 'human'
		then ${PROMPT_PRIORITY_HUMAN} else ${PROMPT_PRIORITY_AGENT} end`;
}

// ---------------------------------------------------------------------------
// Enqueue, with a cap
// ---------------------------------------------------------------------------

export const ENQUEUE_REFUSAL_REASONS = [
	"queue_full",
	"session_unknown",
	"session_not_promptable",
	"prompt_rejected",
] as const;
export type EnqueueRefusalReason = (typeof ENQUEUE_REFUSAL_REASONS)[number];

export type EnqueueOutcome =
	| { ok: true; promptId: string; seq: number; priority: number }
	| {
			ok: false;
			reason: EnqueueRefusalReason;
			message: string;
			/** Present for `queue_full`, so a caller can say how far over it is. */
			depth?: number;
			cap?: number;
	  };

/**
 * Add a prompt to a session's queue, refusing past the depth cap.
 *
 * The cap exists because two of Harbor's callers enqueue without a human in the
 * loop — automations firing on a schedule and sessions that spawn siblings — and
 * both are genuine amplification paths. A misconfigured hourly automation with a
 * retry inside it enqueues without bound, and the failure presents as a session
 * that will not stop working days after anybody asked it to, having spent money
 * the entire time. Refusing with a typed reason lets the automation's own
 * consecutive-failure counter see the refusal and pause itself, which is the
 * mechanism that actually stops the loop; a silently dropped prompt would leave
 * the automation believing it was working.
 *
 * **The cap is approximate under concurrency, and that is a deliberate trade.**
 * The count and the insert are two statements, so N simultaneous enqueuers can
 * overshoot by up to N-1. Making it exact requires holding the session row lock
 * across both, and the insert lives in `queuePrompt` in `sessions.ts` — which
 * takes that same lock in its own transaction, so grabbing it here first would
 * deadlock the two against each other on different pooled connections. An
 * overshoot of a handful is irrelevant to what the cap is for: it bounds
 * unbounded growth, it does not enforce the number 50.
 */
export async function enqueueSessionPrompt(input: {
	orgId: string;
	sessionId: string;
	author: string;
	authorKind?: PromptAuthorKind;
	/** Forwarded to the stored prompt; see `queuePrompt`. */
	authorEmail?: string | null;
	/** Forwarded likewise. The PR for this work is opened with this user's token. */
	authorUserId?: string | null;
	body: string;
	repoOverrides?: RepoOverrides;
}): Promise<EnqueueOutcome> {
	const [session] = await db
		.select({ status: sessions.status })
		.from(sessions)
		.where(and(eq(sessions.id, input.sessionId), eq(sessions.orgId, input.orgId)))
		.limit(1);

	// Fails closed, and scoped by org: a session another tenant owns is
	// indistinguishable here from one that does not exist, which is the only
	// answer that does not turn this endpoint into an existence oracle.
	if (!session) {
		return {
			ok: false,
			reason: "session_unknown",
			message: "No such session.",
		};
	}

	const verdict = promptabilityOf(session.status);
	if (!verdict.promptable) {
		return { ok: false, reason: "session_not_promptable", message: verdict.message };
	}

	const cap = setting("maxQueueDepth", input.repoOverrides);
	const [counted] = (await db.execute(raw`
		select count(*)::int as depth
		from ${sessionPrompts}
		where ${sessionPrompts.sessionId} = ${input.sessionId}
			and ${sessionPrompts.status} = 'queued'
	`)) as unknown as Array<{ depth: number }>;
	const depth = Number(counted?.depth ?? 0);

	if (depth >= cap) {
		return {
			ok: false,
			reason: "queue_full",
			message:
				`This session already has ${depth} prompts waiting, which is its cap of ${cap}. `
				+ "Harbor refuses rather than growing the queue: an automation that enqueues "
				+ "faster than the agent drains is a loop with no human in it, and the symptom "
				+ "is a session still working days after anybody wanted it to.",
			depth,
			cap,
		};
	}

	try {
		const prompt = await queuePrompt({
			orgId: input.orgId,
			sessionId: input.sessionId,
			author: input.author,
			authorKind: input.authorKind ?? "human",
			authorEmail: input.authorEmail ?? null,
			authorUserId: input.authorUserId ?? null,
			body: input.body,
		});
		return {
			ok: true,
			promptId: prompt.id,
			seq: prompt.seq,
			priority: priorityOfAuthorKind(prompt.authorKind),
		};
	} catch (error) {
		// `queuePrompt` throws HarborError for an empty or over-long body. That is a
		// refusal about the prompt, not about the session, and it keeps its own
		// reason so a caller can tell "you sent nothing" from "the room is closed".
		if (error instanceof HarborError) {
			return { ok: false, reason: "prompt_rejected", message: error.message };
		}
		throw error;
	}
}

// ---------------------------------------------------------------------------
// The queue, by priority then seq
// ---------------------------------------------------------------------------

export interface QueuedPrompt {
	id: string;
	seq: number;
	author: string;
	authorKind: string;
	body: string;
	priority: number;
}

/** Read the next prompt without consuming it. Used before a lease is taken. */
export async function peekNextPrompt(
	orgId: string,
	sessionId: string,
): Promise<QueuedPrompt | null> {
	const [next] = await db
		.select()
		.from(sessionPrompts)
		.where(
			and(
				eq(sessionPrompts.sessionId, sessionId),
				eq(sessionPrompts.orgId, orgId),
				eq(sessionPrompts.status, "queued"),
			),
		)
		.orderBy(priorityExpression(), asc(sessionPrompts.seq))
		.limit(1);

	if (!next) return null;
	return {
		id: next.id,
		seq: next.seq,
		author: next.author,
		authorKind: next.authorKind,
		body: next.body,
		priority: priorityOfAuthorKind(next.authorKind),
	};
}

/**
 * Take the next prompt for delivery: highest priority class, then lowest seq.
 *
 * `FOR UPDATE SKIP LOCKED` for the same reason `dequeuePrompt` in `sessions.ts`
 * has it — two workers polling one session must not both take the same row, and
 * the second skipping is better than the second blocking. It is belt and braces
 * here, because the advisory lock above already makes this the only runner; the
 * belt exists because this function is exported and somebody will eventually call
 * it without the lock, and the failure that would cause — one prompt delivered to
 * two sandboxes, two agents editing the same branch — is the one Harbor exists to
 * prevent.
 *
 * This supersedes `dequeuePrompt` for the runner's path, which is strictly FIFO.
 * Both are kept: FIFO is right for a single-participant session and is what the
 * older tests assert, and deleting a working function to make a point is not a
 * migration strategy.
 */
export async function takeNextPrompt(
	orgId: string,
	sessionId: string,
	now = new Date(),
	options: {
		/**
		 * The turn's correlation id, persisted on the delivered prompt so the
		 * commands route — which sends prompts from persisted state, with no
		 * runner in its call stack — can carry it into the sandbox. Cleared on
		 * requeue: a retried delivery is a new turn with a new trace.
		 */
		traceId?: string;
	} = {},
): Promise<QueuedPrompt | null> {
	return db.transaction(async (tx) => {
		const [next] = await tx
			.select()
			.from(sessionPrompts)
			.where(
				and(
					eq(sessionPrompts.sessionId, sessionId),
					eq(sessionPrompts.orgId, orgId),
					eq(sessionPrompts.status, "queued"),
				),
			)
			.orderBy(priorityExpression(), asc(sessionPrompts.seq))
			.for("update", { skipLocked: true })
			.limit(1);

		if (!next) return null;

		await tx
			.update(sessionPrompts)
			.set({ status: "delivered", deliveredAt: now, traceId: options.traceId ?? null })
			// The status predicate is repeated even though the row is locked. If this
			// is ever refactored into a read outside the transaction, the zero-row
			// result turns a double delivery into a visible no-op instead of a second
			// agent starting on somebody else's prompt.
			.where(and(eq(sessionPrompts.id, next.id), eq(sessionPrompts.status, "queued")));

		return {
			id: next.id,
			seq: next.seq,
			author: next.author,
			authorKind: next.authorKind,
			body: next.body,
			priority: priorityOfAuthorKind(next.authorKind),
		};
	});
}

/**
 * Put a taken prompt back at the front of its class.
 *
 * Called when everything after the dequeue refused — the sandbox would not boot,
 * the provider's circuit is open. Without it, a prompt taken and then not
 * delivered is simply gone: marked `delivered`, never sent anywhere, and the
 * person who typed it watches a session do nothing forever.
 *
 * The prompt keeps its original `seq`, so it returns to exactly the position it
 * held rather than to the back of the queue. Being retried after a boot failure
 * should not cost somebody their place.
 */
export async function requeuePrompt(orgId: string, promptId: string): Promise<void> {
	await db
		.update(sessionPrompts)
		// The trace is cleared with the delivery: a retried delivery is a new
		// turn, and a stale trace id would stitch two attempts into one story.
		.set({ status: "queued", deliveredAt: null, traceId: null })
		.where(
			and(
				eq(sessionPrompts.id, promptId),
				eq(sessionPrompts.orgId, orgId),
				eq(sessionPrompts.status, "delivered"),
			),
		);
}

// ---------------------------------------------------------------------------
// The lease
// ---------------------------------------------------------------------------

/**
 * The prefix on every agent id the loop claims with.
 *
 * It exists so that `completeTurn`, which runs from the bridge's ingest path and
 * does not know which process delivered the prompt, can tell a lease Harbor's own
 * loop took from a lease a human's agent took through MCP against the same task.
 * Releasing the second would hand somebody else's in-flight work back to the pool,
 * which is the exact collision the claims table exists to prevent.
 */
export const RUNNER_AGENT_PREFIX = "runner/";

export function runnerAgentId(label: string): string {
	return label.startsWith(RUNNER_AGENT_PREFIX) ? label : `${RUNNER_AGENT_PREFIX}${label}`;
}

export function isRunnerAgentId(agentId: string): boolean {
	return agentId.startsWith(RUNNER_AGENT_PREFIX);
}

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

/**
 * What the runner needs from the sandbox lifecycle, and nothing else.
 *
 * The gateway is a parameter rather than a direct call into
 * `src/sandbox/manager.ts`. That is not ceremony: it is what keeps this file's
 * tests — the ones that assert two runners deliver a prompt once, and that a
 * human's prompt overtakes an automation's — running against real Postgres with no
 * container, no provider credentials and no network. A loop whose concurrency
 * properties can only be exercised by booting Docker is a loop whose concurrency
 * properties are exercised rarely, and those are the properties that break.
 *
 * The input type is the manager's own, imported rather than restated, so the two
 * cannot drift into a shape that compiles and means different things.
 */
export interface SandboxGateway {
	ensureSandbox(input: EnsureSandboxInput): Promise<SpawnOutcome>;
}

/** The production wiring: one object, so the seam costs nothing at the call site. */
export function defaultSandboxGateway(): SandboxGateway {
	return { ensureSandbox };
}

export const TURN_IDLE_REASONS = ["lock_not_acquired", "queue_empty"] as const;
export type TurnIdleReason = (typeof TURN_IDLE_REASONS)[number];

/**
 * Every way a turn can be refused, and note the pairs.
 *
 * `budget_exhausted` and `budget_state_unknown` are different facts:
 * the first is a decision read off the ledger, the second is the ledger being
 * unreachable. `lease_not_held` and `lease_state_unknown` are the same split for
 * authority. Collapsing either pair gives a system that either spends money when
 * its accounting is down or stops working entirely when a query times out, and
 * which of the two you get is decided by an accident of how somebody wrote an
 * `if`. Both members here fail closed, because both questions are authority
 * questions — compare the liveness checks in `src/sandbox/decisions.ts`, where the
 * unknown case deliberately reads as alive.
 */
export const TURN_REFUSAL_REASONS = [
	"session_unknown",
	"session_not_promptable",
	"session_paused",
	"budget_exhausted",
	"budget_state_unknown",
	"lease_not_held",
	"lease_state_unknown",
	"sandbox_refused",
	"sandbox_failed",
] as const;
export type TurnRefusalReason = (typeof TURN_REFUSAL_REASONS)[number];

export type TurnOutcome =
	| {
			kind: "delivered";
			promptId: string;
			promptSeq: number;
			author: string;
			priority: number;
			sandboxId: string;
			claimId: string | null;
			traceId: string;
	  }
	| { kind: "idle"; reason: TurnIdleReason }
	| {
			kind: "refused";
			reason: TurnRefusalReason;
			message: string;
			/** The provider's own refusal, when the sandbox layer produced one. */
			spawnRefusal?: SpawnRefusal;
	  };

export interface RunSessionTurnInput {
	orgId: string;
	sessionId: string;
	/** Identifies this runner process. Prefixed if it is not already. */
	agentId: string;
	gateway: SandboxGateway;
	traceId?: string;
	leaseMinutes?: number;
	repoOverrides?: RepoOverrides;
	now?: Date;
}

/**
 * Drive one session forward by at most one prompt.
 *
 * Returns rather than looping, so the caller decides the cadence — a cron tick, a
 * NOTIFY wakeup, a test. A function that loops internally cannot be tested for the
 * property that matters most here, which is what two of them do to each other.
 */
export async function runSessionTurn(input: RunSessionTurnInput): Promise<TurnOutcome> {
	const traceId = input.traceId ?? randomUUID();
	const agentId = runnerAgentId(input.agentId);
	const now = input.now ?? new Date();

	const locked = await withSessionLock(input.sessionId, () =>
		driveOneTurn({ ...input, traceId, agentId, now }),
	);

	// Not an error and not worth a retry: another runner holds this session and is
	// about to do exactly what this call would have done.
	if (!locked.acquired) return { kind: "idle", reason: "lock_not_acquired" };
	return locked.result;
}

async function driveOneTurn(
	input: RunSessionTurnInput & { traceId: string; agentId: string; now: Date },
): Promise<TurnOutcome> {
	const { orgId, sessionId, agentId, traceId, now } = input;

	const [session] = await db
		.select()
		.from(sessions)
		.where(and(eq(sessions.id, sessionId), eq(sessions.orgId, orgId)))
		.limit(1);

	// Fail CLOSED on authority. A row this org cannot see is indistinguishable
	// from one that does not exist, and neither is permission to spend.
	if (!session) {
		return { kind: "refused", reason: "session_unknown", message: "No such session." };
	}

	const verdict = promptabilityOf(session.status);
	if (!verdict.promptable) {
		return { kind: "refused", reason: "session_not_promptable", message: verdict.message };
	}

	if (session.pausedReason) {
		return {
			kind: "refused",
			reason: "session_paused",
			message:
				`This session is paused (${session.pausedReason}). A paused session stops `
				+ "consuming its queue; the prompts stay where they are until it resumes.",
		};
	}

	// Budget is read before anything is dequeued, so a session over its cap never
	// consumes a prompt it cannot act on. The event is emitted further down, only
	// once there is genuinely work waiting — an idle session polled every second
	// would otherwise write a `budget_exhausted` event every second and bury the
	// timeline under the report of a condition nobody can currently fix.
	let overBudget: boolean;
	try {
		const budget = await budgetStatus(orgId, { repoOverrides: input.repoOverrides });
		overBudget = budget.exhausted;
	} catch (error) {
		// We did not learn that the org is over budget; we failed to learn anything.
		// Authority fails closed. The opposite choice — admit on a failed read — makes
		// a database blip into unlimited spending, and the blip is over long before
		// anybody sees the invoice.
		console.error("[runner] budget state unavailable:", error);
		return {
			kind: "refused",
			reason: "budget_state_unknown",
			message:
				"Spend could not be determined, so this turn was refused rather than assumed "
				+ "affordable. New work is not admitted while the ledger is unreadable; work "
				+ "already running is untouched.",
		};
	}

	const next = await peekNextPrompt(orgId, sessionId);
	if (!next) return { kind: "idle", reason: "queue_empty" };

	if (overBudget) {
		await appendEvent({
			orgId,
			sessionId,
			type: "budget_exhausted",
			actor: "harbor",
			payload: { trace_id: traceId, prompt_seq: next.seq },
		});
		return {
			kind: "refused",
			reason: "budget_exhausted",
			message:
				"The organisation's daily spend cap is reached. Work already running continues "
				+ "— killing a turn at 90% spends the tokens and produces nothing — but no new "
				+ "prompt is admitted until the cap resets or is raised.",
		};
	}

	// ------------------------------------------------------------------
	// CLAIM BEFORE SPAWN
	// ------------------------------------------------------------------
	//
	// The lease is taken here, in Postgres, *before* anything touches a provider.
	// A duplicate unit of work must never cost a container or a token, and this
	// ordering is the entire admission control mechanism: the loser of a race
	// discovers it lost by reading back a row, at the price of one INSERT that
	// violated a unique index. That is only affordable because coordination is a
	// cheap row write; if losing a race cost a boot, every runner would have to
	// guess conservatively and the fleet would under-utilise on purpose.
	//
	// It sits after the peek rather than before it because a lease taken with an
	// empty queue is a lease held for nothing — it would lock a task out of the
	// pool for the rest of the lease window while this runner has literally no work
	// to do with it.
	let claimId: string | null = null;
	let previousHolder: string | null = null;

	if (session.taskId) {
		previousHolder = await lastClaimHolder(session.taskId);

		let claimed;
		try {
			claimed = await claim(orgId, session.taskId, agentId, {
				leaseMinutes: input.leaseMinutes,
				intent: `Driving session ${session.key}`,
			});
		} catch (error) {
			// Same split as the budget above: a failed claim *call* is not a claim
			// that was refused. Fail closed and say which one it was, so an operator
			// reading the log is not told a lease is held by somebody it never asked.
			console.error("[runner] lease state unavailable:", error);
			return {
				kind: "refused",
				reason: "lease_state_unknown",
				message:
					"Whether this task's lease is held could not be determined, so no sandbox was "
					+ "booted. Harbor refuses rather than assuming it is free: assuming would put "
					+ "two agents on one task, which is the single failure this product exists to "
					+ "prevent.",
			};
		}

		if (!claimed.ok) {
			return {
				kind: "refused",
				reason: "lease_not_held",
				message:
					`This task is held by ${claimed.conflict.agentId} until `
					+ `${claimed.conflict.expiresAt.toISOString()}. Nothing was booted.`,
			};
		}
		// The id of the claim THIS call inserted, straight from the insert. The old
		// shape re-read `activeClaimId(session.taskId)` here, and the re-read races
		// everything: the claim released or expired between the insert and the read
		// came back as null, which `readLeaseState` used to treat as "no lease
		// asserted" — authorised — so a runner whose lease had just lapsed spawned
		// with no lease at all. The value from the insert cannot lie about whose
		// claim it is, and `readLeaseState` re-verifies the row is still live.
		claimId = claimed.claimId;

		// The handoff, recorded. See the file header for why the session is reused
		// rather than superseded by a child: the transcript is in Postgres, so there
		// is nothing to migrate and the room's link keeps working.
		//
		// `participant_joined` is the closest variant the contract has, and inventing
		// a `lease_handoff` type in this file would break the rule that a new event
		// variant lands in `src/contracts` first. The payload says exactly what
		// happened so a reader is not left inferring it from a type name.
		if (previousHolder && previousHolder !== agentId) {
			await appendEvent({
				orgId,
				sessionId,
				type: "participant_joined",
				actor: agentId,
				payload: {
					kind: "lease_handoff",
					previous_holder: previousHolder,
					new_holder: agentId,
					task_id: session.taskId,
					trace_id: traceId,
					note:
						"The previous holder's lease lapsed. This session continues in place — the "
						+ "transcript lives in Postgres, so there was nothing to migrate.",
				},
			});
		}
	}

	const taken = await takeNextPrompt(orgId, sessionId, now, { traceId });
	if (!taken) {
		// The peek saw a prompt and the take did not. Under the advisory lock this
		// is nearly impossible — it needs somebody calling the queue functions
		// without the lock — so give the lease straight back rather than sitting on
		// it for the rest of its window.
		await releaseSessionLease(orgId, session.taskId, agentId);
		return { kind: "idle", reason: "queue_empty" };
	}

	let outcome: SpawnOutcome;
	try {
		outcome = await input.gateway.ensureSandbox({
			orgId,
			sessionId,
			claimId,
			actor: taken.author,
			traceId,
			repoOverrides: input.repoOverrides,
			now,
		});
	} catch (error) {
		// A throw is not one of the four spawn outcomes and must not become one by
		// accident. It is treated exactly as `failed` — prompt back on the queue,
		// lease back in the pool — because the alternative is a prompt marked
		// delivered that no sandbox ever received, which reads to the person who
		// typed it as a session that silently ignored them.
		outcome = {
			kind: "failed",
			error_type: "unknown",
			message: error instanceof Error ? error.message : String(error),
		};
	}

	// Exhaustive, no `default`: a fifth spawn outcome is a compile error here
	// rather than a prompt that is silently swallowed by a fall-through.
	switch (outcome.kind) {
		case "created":
		case "adopted": {
			await appendEvent({
				orgId,
				sessionId,
				type: "prompt_delivered",
				actor: taken.author,
				payload: {
					prompt_id: taken.id,
					prompt_seq: taken.seq,
					author: taken.author,
					author_kind: taken.authorKind,
					priority: taken.priority,
					sandbox_id: outcome.sandbox_id,
					spawn: outcome.kind,
					trace_id: traceId,
				},
			});
			return {
				kind: "delivered",
				promptId: taken.id,
				promptSeq: taken.seq,
				author: taken.author,
				priority: taken.priority,
				sandboxId: outcome.sandbox_id,
				claimId,
				traceId,
			};
		}

		case "refused": {
			// The prompt goes back at its own seq, the lease goes back to the pool.
			// A refusal is a statement about right now — a circuit that is open, a
			// budget that is spent — and holding a lease through it would stop the
			// runner that retries after the cooldown from taking the task at all.
			await requeuePrompt(orgId, taken.id);
			await releaseSessionLease(orgId, session.taskId, agentId);
			await appendEvent({
				orgId,
				sessionId,
				type: "policy_denied",
				actor: "harbor",
				payload: {
					decision: "sandbox_refused",
					reason: outcome.reason,
					prompt_id: taken.id,
					prompt_seq: taken.seq,
					trace_id: traceId,
				},
			});
			return {
				kind: "refused",
				reason: "sandbox_refused",
				message: `No sandbox was started: ${outcome.reason}. The prompt is still queued.`,
				spawnRefusal: outcome.reason,
			};
		}

		case "failed": {
			await requeuePrompt(orgId, taken.id);
			await releaseSessionLease(orgId, session.taskId, agentId);
			await appendEvent({
				orgId,
				sessionId,
				// `session_error`, not `agent_finished`: Harbor's own machinery failed
				// to produce a box. The agent never ran and did not fail at anything,
				// and conflating the two makes "how often do agents fail" unanswerable.
				type: "session_error",
				actor: "harbor",
				payload: {
					stage: "ensure_sandbox",
					error_type: outcome.error_type,
					message: outcome.message,
					prompt_id: taken.id,
					prompt_seq: taken.seq,
					trace_id: traceId,
				},
			});
			return {
				kind: "refused",
				reason: "sandbox_failed",
				message: `Could not start a sandbox (${outcome.error_type}): ${outcome.message}`,
			};
		}
	}
	return assertNever(outcome, "ensureSandbox outcome");
}

/**
 * Who held this task most recently, active or released.
 *
 * Read *before* `claim()` runs, because `claim()` expires a lapsed holder as part
 * of taking the lease — afterwards the row it superseded looks exactly like one
 * that was released cleanly a week ago, and the handoff event would name nobody.
 */
async function lastClaimHolder(taskId: string): Promise<string | null> {
	const [row] = await db
		.select({ agentId: claims.agentId })
		.from(claims)
		.where(eq(claims.taskId, taskId))
		.orderBy(raw`${claims.claimedAt} desc`)
		.limit(1);
	return row?.agentId ?? null;
}

/**
 * Give back a lease this runner holds, and only one it holds.
 *
 * `release()` refuses to free somebody else's claim and throws when it does. That
 * throw is swallowed here on purpose: by the time a turn is unwinding, the lease
 * may already have lapsed and been taken by another runner, and fighting over it
 * is exactly the behaviour the handoff design exists to avoid. Nothing is lost —
 * the new holder is already driving the same session.
 */
export async function releaseSessionLease(
	orgId: string,
	taskId: string | null,
	agentId: string,
): Promise<void> {
	if (!taskId) return;
	try {
		await release(orgId, taskId, agentId);
	} catch (error) {
		if (error instanceof HarborError) return;
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Finishing a turn
// ---------------------------------------------------------------------------

export type TurnCompletion = "completed" | "failed";

/**
 * Close out the prompt a sandbox just finished.
 *
 * Called from the bridge's ingest path rather than from the loop, because the
 * loop's turn ended the moment the prompt was handed over — the agent's work
 * happens in another process and finishes minutes later. Keeping the two apart is
 * what lets a runner tick be short; a runner that waits for the agent holds a
 * lock, a connection and a process for the length of the turn.
 *
 * The lease is given back only when the queue has drained. Releasing after every
 * prompt would mean re-claiming for the next one, and in the window between the
 * two another runner can legitimately take the task — so a session with three
 * queued prompts could be driven by three different runners against three
 * different sandboxes, which is not wrong exactly, but it throws away a warm box
 * three times and bills for three cold boots.
 */
export async function completeTurn(input: {
	orgId: string;
	sessionId: string;
	outcome: TurnCompletion;
	/** The specific prompt, when the sandbox named one. Otherwise the oldest in flight. */
	promptId?: string;
	detail?: Record<string, unknown> | null;
	now?: Date;
}): Promise<{ finished: string[]; leaseReleased: boolean }> {
	const now = input.now ?? new Date();

	const conditions = [
		eq(sessionPrompts.sessionId, input.sessionId),
		eq(sessionPrompts.orgId, input.orgId),
		eq(sessionPrompts.status, "delivered"),
	];
	if (input.promptId) conditions.push(eq(sessionPrompts.id, input.promptId));

	const inFlight = await db
		.select()
		.from(sessionPrompts)
		.where(and(...conditions))
		.orderBy(asc(sessionPrompts.deliveredAt), asc(sessionPrompts.seq))
		.limit(1);

	const prompt = inFlight[0];
	if (!prompt) return { finished: [], leaseReleased: false };

	// The compare-and-set decides whether this call closed the prompt, and nothing
	// below runs unless it did. The read and the write are two statements, so two
	// callers — the bridge retrying an ingest whose response was lost, and the
	// execution-timeout sweep — both select the same `delivered` row and both reach
	// here. Only one UPDATE matches. Writing `prompt_finished` regardless puts the
	// same turn on the timeline twice, and worse, the loser then goes on to read the
	// queue and hand the lease back on the strength of work it did not finish.
	//
	// The CAS and its `prompt_finished` event share one transaction: a prompt in a
	// terminal status whose timeline still says "running" is the exact lost fact
	// this ledger exists to rule out. The NOTIFY fires after the commit, per
	// AppendOptions in session-events.ts.
	const claimed = await db.transaction(async (tx) => {
		const updated = await tx
			.update(sessionPrompts)
			.set({ status: input.outcome })
			.where(and(eq(sessionPrompts.id, prompt.id), eq(sessionPrompts.status, "delivered")))
			.returning({ id: sessionPrompts.id });
		if (updated.length === 0) return false;
		await appendEvent(
			{
				orgId: input.orgId,
				sessionId: input.sessionId,
				type: "prompt_finished",
				actor: prompt.author,
				payload: {
					prompt_id: prompt.id,
					prompt_seq: prompt.seq,
					outcome: input.outcome,
					finished_at: now.toISOString(),
					...(input.detail ?? {}),
				},
			},
			{ executor: tx },
		);
		return true;
	});
	if (!claimed) return { finished: [], leaseReleased: false };
	await notifyChange(input.orgId, "session_event");

	const remaining = await peekNextPrompt(input.orgId, input.sessionId);
	if (remaining) return { finished: [prompt.id], leaseReleased: false };

	const [session] = await db
		.select({ taskId: sessions.taskId })
		.from(sessions)
		.where(and(eq(sessions.id, input.sessionId), eq(sessions.orgId, input.orgId)))
		.limit(1);
	if (!session?.taskId) return { finished: [prompt.id], leaseReleased: false };

	// Release only a lease Harbor's own loop took. A human's agent may hold this
	// same task through MCP — that is a supported thing to do — and handing their
	// in-flight work back to the pool because a session finished is the collision
	// the claims table exists to prevent.
	const [holder] = await db
		.select({ agentId: claims.agentId })
		.from(claims)
		.where(and(eq(claims.taskId, session.taskId), isNull(claims.releasedAt)))
		.limit(1);
	if (!holder || !isRunnerAgentId(holder.agentId)) {
		return { finished: [prompt.id], leaseReleased: false };
	}

	await releaseSessionLease(input.orgId, session.taskId, holder.agentId);
	return { finished: [prompt.id], leaseReleased: true };
}

// ---------------------------------------------------------------------------
// The sandbox edge: authentication
// ---------------------------------------------------------------------------

/**
 * Why a sandbox request was not accepted. Every member fails closed.
 *
 * `token_absent` is separated from `token_mismatch` because the two mean different
 * things to whoever is reading the log: the first is a bridge that was started
 * without its credential — a deployment bug, fixable — and the second is somebody
 * presenting a credential that is not the one on file, which is either a stale box
 * or an attack. A single "unauthorised" makes those indistinguishable in exactly
 * the incident where telling them apart is the whole job.
 *
 * `sandbox_unenrolled` is the third: a sandbox row that never had a token hash
 * written to it. That is not a wrong token, it is a box nothing ever authorised,
 * and it must never authenticate — an empty hash compared against an empty token
 * would otherwise succeed.
 */
export const SANDBOX_AUTH_REFUSALS = [
	"token_absent",
	"sandbox_id_malformed",
	"sandbox_unknown",
	"sandbox_unenrolled",
	"token_mismatch",
] as const;
export type SandboxAuthRefusal = (typeof SANDBOX_AUTH_REFUSALS)[number];

export type SandboxRow = typeof sandboxes.$inferSelect;

export type SandboxAuthOutcome =
	| { ok: true; sandbox: SandboxRow }
	| { ok: false; reason: SandboxAuthRefusal; message: string };

const SANDBOX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `Authorization: Bearer <token>`, or the explicit header the bridge prefers. */
export function sandboxTokenFrom(headers: Headers): string | null {
	const explicit = headers.get("x-harbor-sandbox-token")?.trim();
	if (explicit) return explicit;
	const authorization = headers.get("authorization")?.trim();
	if (!authorization) return null;
	const bearer = /^Bearer\s+(.+)$/i.exec(authorization);
	return bearer?.[1]?.trim() ?? null;
}

/**
 * Authenticate a request as coming from one specific sandbox.
 *
 * The token is compared as a SHA-256 digest, in constant time, against
 * `sandboxes.auth_token_hash` — the same discipline as `api_keys`, and for a
 * stronger reason: this credential lets a box write into a session's transcript
 * and fetch git credentials, so a database dump that contained it would hand over
 * both. Unsalted because the search space is CSPRNG output, and because a salted
 * column cannot be indexed and this is on the hot path of every event batch.
 *
 * The request does not get to say which sandbox it is *and* be believed: the id
 * comes from the URL, the row is loaded by primary key, and the token only ever
 * proves that the caller holds the credential for that row.
 */
export async function authenticateSandbox(
	sandboxId: string,
	headers: Headers,
): Promise<SandboxAuthOutcome> {
	const token = sandboxTokenFrom(headers);
	if (!token) {
		return {
			ok: false,
			reason: "token_absent",
			message:
				"No sandbox token was presented. The bridge sends it as `Authorization: Bearer` "
				+ "or `x-harbor-sandbox-token`; a box started without one is a deployment fault, "
				+ "not an authorisation failure, and this reason says so.",
		};
	}

	// Refused before it reaches Postgres. A malformed id would raise `invalid input
	// syntax for type uuid` and surface as a 500, which lets an unauthenticated
	// caller turn a typo into a stack trace.
	if (!SANDBOX_UUID.test(sandboxId)) {
		return { ok: false, reason: "sandbox_id_malformed", message: "That is not a sandbox id." };
	}

	const [sandbox] = await db
		.select()
		.from(sandboxes)
		.where(eq(sandboxes.id, sandboxId))
		.limit(1);
	if (!sandbox) {
		return {
			ok: false,
			reason: "sandbox_unknown",
			message: "No sandbox with that id.",
		};
	}
	if (!sandbox.authTokenHash) {
		return {
			ok: false,
			reason: "sandbox_unenrolled",
			message:
				"That sandbox has no credential on file, so nothing can authenticate as it. "
				+ "Refusing rather than comparing against an empty hash, which any empty token "
				+ "would match.",
		};
	}

	if (!secretEquals(sha256Hex(token), sandbox.authTokenHash)) {
		return {
			ok: false,
			reason: "token_mismatch",
			message: "That token is not this sandbox's token.",
		};
	}

	return { ok: true, sandbox };
}

export function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

// ---------------------------------------------------------------------------
// The sandbox edge: fencing
// ---------------------------------------------------------------------------

/**
 * How a fencing token arrives on the wire, and what a missing one means.
 *
 * The check itself is `validateFence` in `src/sandbox/manager.ts` — one
 * implementation, because two would eventually disagree about what "superseded"
 * means and the disagreement would be invisible until two agents were pushing to
 * one branch. What lives here is the HTTP edge: parsing the header, and the two
 * refusals that happen before the manager is ever asked.
 *
 * A missing header is a refusal, not a default. Treating "no fence supplied" as
 * "fence fine" makes the entire mechanism opt-in for the caller it is defending
 * against — a stale box that simply omits the header would sail through, and case
 * 4 of the four ambiguous failures on `SpawnIntent` would be wide open.
 */
export const FENCE_HEADER_REFUSALS = ["fence_absent", "fence_malformed"] as const;
export type FenceHeaderRefusal = (typeof FENCE_HEADER_REFUSALS)[number];

export type FenceHeader =
	| { ok: true; token: number }
	| { ok: false; reason: FenceHeaderRefusal; message: string };

/** `x-harbor-fencing-token`, the header every privileged bridge call carries. */
export function fencingTokenFrom(headers: Headers): FenceHeader {
	const presented = headers.get("x-harbor-fencing-token")?.trim();
	if (!presented) {
		return {
			ok: false,
			reason: "fence_absent",
			message:
				"No fencing token was presented. Every privileged call from a sandbox carries "
				+ "one; without it Harbor cannot tell a current box from one whose lease lapsed "
				+ "while it kept running, and it will not guess.",
		};
	}
	// Bounded digits, so a caller cannot hand Postgres a number that overflows the
	// comparison and cannot make the parse itself the expensive part of the request.
	if (!/^\d{1,9}$/.test(presented)) {
		return {
			ok: false,
			reason: "fence_malformed",
			message: "A fencing token is a positive integer.",
		};
	}
	return { ok: true, token: Number(presented) };
}

/**
 * Turn the manager's verdict into something a bridge author can act on.
 *
 * Exhaustive with no `default`, so a sixth fence refusal is a compile error here
 * rather than an HTTP 409 with an empty body. The two rejections are deliberately
 * worded differently: `token_mismatch` is a caller asserting a number that was
 * never its own — forged or replayed — while `superseded` is an honest box that
 * outlived its lease, which is the ordinary operational case. If both read as
 * "unauthorised", every routine stale box gets investigated as an intrusion.
 */
export function describeFenceRefusal(verdict: Extract<FenceVerdict, { valid: false }>): string {
	switch (verdict.reason) {
		case "unknown_sandbox":
			return "No sandbox with that id, so there is no fence to check against.";
		case "token_mismatch":
			return `That fencing token is not this sandbox's (expected ${verdict.expected}).`;
		case "superseded":
			return (
				`This sandbox has been superseded; the session's current fence is ${verdict.current}. `
				+ "A superseded box may still be running and may still believe it holds the work; "
				+ "it may not write to the transcript, push a branch or fetch a credential."
			);
		case "lifecycle_closed":
			return (
				`This sandbox is ${verdict.status}. Lifecycle state is authoritative over `
				+ "transport: a box Harbor has already reaped does not get to keep talking "
				+ "merely because its socket is open."
			);
		case "state_unknown":
			return (
				"This sandbox's fencing position could not be determined, so the call was "
				+ "refused rather than admitted. A side effect allowed on an unreadable fence is "
				+ `the same as having no fence at all. (${verdict.detail})`
			);
	}
	return assertNever(verdict, "describeFenceRefusal");
}
