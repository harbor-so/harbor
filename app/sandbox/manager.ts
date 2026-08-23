// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The sandbox lifecycle: the idempotent spawn saga, the fence, and the sweep.
 *
 * This file executes effects. Every *decision* it acts on comes from
 * `decisions.ts`, which is pure and knows nothing about Postgres or providers, and
 * the split is enforced by a boundary test rather than by discipline. What is left
 * here is ordering, persistence and failure handling — which is where the bugs
 * that matter actually live.
 *
 * ## "Exactly one sandbox" is not the property. Read this before changing anything.
 *
 * Taking a lease before calling a provider prevents *ordinary* concurrent
 * duplication, and that is worth having. It does not survive any of the four
 * ambiguous failures:
 *
 *   (a) we crash after acquiring the lease and before contacting the provider;
 *   (b) the provider creates the box and its response is lost in transit;
 *   (c) we retry after the box exists but before its id was persisted;
 *   (d) the lease expires while the holder is genuinely still running.
 *
 * (b) and (c) are indistinguishable from this side without asking the provider what
 * it actually has. So the property implemented and tested here is:
 *
 *   > **At most one ACTIVE sandbox per lease, including after ambiguous failures.**
 *
 * Three mechanisms, all required, none sufficient alone:
 *
 *  1. **The intent is persisted before the provider call.** A `sandboxes` row in
 *     status `requested` is written first, and its primary key IS the `attemptId`
 *     handed to the provider as a label. A box created by a call whose response we
 *     never saw is therefore *discoverable* rather than an invisible container
 *     billing until somebody reads an invoice.
 *
 *  2. **Reconciliation before a second spawn.** A resumable attempt is not
 *     re-created; `provider.findByAttemptId` is asked first, and a box we already
 *     made is ADOPTED (`SpawnOutcome.kind === "adopted"`, reason
 *     `reconciled_orphan`). `findByAttemptId` fails CLOSED by contract — a provider
 *     that cannot reach its backend throws instead of returning null — because a
 *     null on a lost connection turns one network blip into two agents on one
 *     branch.
 *
 *  3. **A fencing token**, monotonic per session, validated by every privileged
 *     side effect. Case (d) is the one nothing else touches: a box whose lease
 *     lapsed is still running, still holds credentials, and still believes it owns
 *     the work. The token is what makes it harmless — its writes are refused
 *     because a newer box holds the fence, not because anybody managed to kill it
 *     in time.
 *
 * ## Where the token lives, given the schema may not change
 *
 * There is no `fencing_token` column, and this module may not add one. The token is
 * therefore **derived from the creation ordering of `sandboxes` rows within a
 * session** — the ordinal of the row under `(created_at, id)` — and persisted in
 * two ways that already exist: the row itself (its position *is* the value) and the
 * `sandbox_requested` event payload, which is append-only and is what a human reads
 * during a post-mortem. To make that ordering a total order rather than an almost-
 * total one, `openAttempt` forces `created_at` to be strictly greater than the
 * newest existing row for the session; without that, two rows written in the same
 * millisecond would be ordered by uuid, and a uuid that happened to sort low would
 * make the *newer* attempt believe it had been superseded by the older one and
 * refuse its own writes forever. See the note in `openAttempt`.
 *
 * ## Lifecycle state is authoritative over transport
 *
 * Losing the bridge connection does NOT kill a sandbox, and a bridge that reappears
 * is not refused because a socket dropped. Only the explicit paths — inactivity and
 * a stale heartbeat — persist a dead status, and they persist it BEFORE closing
 * anything, because the persisted status is what blocks reconnection. Doing it the
 * other way round (close, then write) leaves a window in which a box reconnects
 * between the close and the write and is admitted as healthy, which is how a
 * reaped, fenced-out box gets back onto a session it no longer owns.
 */

import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNotNull, isNull, notInArray, sql as raw } from "drizzle-orm";
import { type RepoOverrides, setting } from "@core/kernel/config.js";
import {
	DEAD_SANDBOX_STATUSES,
	type ProviderErrorType,
	type SandboxStatus,
	type SessionEventType,
	type SpawnOutcome,
	type SpawnRefusal,
} from "../contracts/index.js";
import { db } from "@core/schema/index.js";
import { claims, events, repoImages, repos, sandboxes, sessionPrompts, sessions } from "@core/schema/schema.js";
import { evaluateImageFreshness } from "../images/decisions.js";
import { budgetStatus, finalizeReservation, recordCost, reserveBudget } from "../lib/cost.js";
import { type Executor, appendEvent } from "../lib/session-events.js";
import { PUBLIC_URL_MISSING_MESSAGE, agentMcpUrl, publicUrl } from "@core/kernel/urls.js";
import { HarborError, notifyChange } from "@core/kernel/work.js";
import { readCircuit, recordProviderFailure, recordProviderSuccess } from "./circuit.js";
import { buildSandboxEnv, resumeTokenForBoot } from "./env.js";
import {
	type DestructionAuthority,
	type LeaseState,
	type SandboxFailure,
	assertNever,
	classifyProviderError,
	evaluateConnectingTimeout,
	evaluateDestruction,
	evaluateExecutionTimeout,
	evaluateHeartbeatHealth,
	evaluateInactivityTimeout,
	evaluateSpawnDecision,
	isDeadSandboxStatus,
	isOpenAttemptStatus,
	isReconnectBlockedStatus,
	resolveBootMode,
} from "./decisions.js";
import {
	type SandboxProvider,
	type SnapshotProvider,
	type SnapshotRef,
	type StopOutcome,
	SandboxProviderError,
	isImageBuildingProvider,
	isLive,
	isSnapshotProvider,
} from "./provider.js";
import { defaultProvider } from "./registry.js";

/**
 * The digest stored on the sandbox row. Duplicated from `session-runner.ts`
 * rather than imported, because importing it here would make the lifecycle
 * manager depend on the request layer, and the boundary test that keeps
 * `decisions.ts` clean exists precisely because those dependencies are easy to
 * add and hard to remove.
 */
function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/**
 * Where a sandbox should call us back.
 *
 * Required, with no localhost default, and the absence is fatal at spawn rather
 * than at first callback. A box that boots pointing at `http://localhost:3000`
 * from inside its own container reaches *itself*, not Harbor — so every event it
 * emits is dropped, its heartbeat never arrives, and the connecting watchdog reaps
 * it. The symptom is "sandboxes always time out", which is a very long way from
 * "an environment variable is unset".
 *
 * Resolution and the wording both live in `src/lib/urls.ts`, which is the single
 * place that decides what any Harbor address is; only the error *type* is local,
 * because callers here catch `HarborError` specifically.
 */
function controlPlaneUrl(): string {
	const url = publicUrl();
	if (!url) throw new HarborError(PUBLIC_URL_MISSING_MESSAGE);
	return url;
}

type SandboxRow = typeof sandboxes.$inferSelect;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface EnsureSandboxInput {
	orgId: string;
	sessionId: string;
	/**
	 * The lease that authorises this spawn, when there is one.
	 *
	 * `null` is legal ONLY for a session with no task — a human opening a scratch
	 * room from the dashboard, where there is no lease to hold. For a session
	 * backed by a task, `null` means the claim was lost or never threaded and the
	 * spawn is REFUSED (`readLeaseState` answers `not_held`). And neither case is
	 * the same as a lease that could not be read, which is `unknown`; see
	 * `readLeaseState` for why the three must never be collapsed.
	 */
	claimId?: string | null;
	/** Who asked. Lands on the timeline events and on the cost rows. */
	actor?: string | null;
	/**
	 * The turn's correlation id, exported into the box as HARBOR_TRACE_ID. The
	 * environment contract in docs/sandbox-runtime.md always listed it and the
	 * supervisor always read it — but nothing ever set it, so the one greppable
	 * token the contracts file promises for a Slack→session→sandbox→PR chain
	 * was lost at exactly the container boundary.
	 */
	traceId?: string | null;
	/** Defaults to `defaultProvider()`. Injected by tests and by per-session routing. */
	provider?: SandboxProvider;
	image?: string;
	workspace?: string;
	env?: Record<string, string>;
	features?: Record<string, boolean>;
	command?: string[];
	/**
	 * Integer micro-USD reserved for this spawn, atomically with admission.
	 *
	 * Zero is the honest default: v1 has no price list for sandbox seconds, and an
	 * invented number would make a spend report confidently wrong. Reserving zero
	 * still takes the admission path, so an organisation already over its cap is
	 * still refused — that check is `spent >= cap`, not `spent + estimate > cap`.
	 */
	estimateMicroUsd?: number;
	now?: Date;
	/** Overrides beyond the repository's own, for tests and for per-session tuning. */
	repoOverrides?: RepoOverrides;
}

// ---------------------------------------------------------------------------
// Authority
// ---------------------------------------------------------------------------

/**
 * Is the lease behind this spawn held, not held, or unreadable?
 *
 * **AUTHORITY FAILS CLOSED.** An error reading the claim returns `unknown`, and
 * `evaluateSpawnDecision` refuses on `unknown` exactly as it refuses on `not_held`
 * — with a different reason, because a wall of `lease_state_unknown` is a database
 * problem and a wall of `lease_not_held` is a scheduler problem, and those page
 * different people. Guessing "held" because the database blipped is how two agents
 * end up pushing to one branch, and there is no cleanup for that: the damage is in
 * somebody's repository history.
 *
 * This is the exact mirror of `readCircuit`, which fails OPEN, and of
 * `classifyLiveness`, which fails open. The asymmetry is deliberate at all three
 * sites: being wrong about liveness wastes a probe, being wrong about authority is
 * unrecoverable.
 *
 * A missing `claimId` splits on whether the session has a task, and the split is
 * the fix for a real degradation. When `sessionTaskId` is null the session is
 * leaseless BY DESIGN — a human's scratch room from the dashboard — and there is
 * no lease to read, so `held` is honest: mutual exclusion for that case comes
 * from the session-scoped advisory lock in `openAttempt`. But a session WITH a
 * task and no presented claim means the claim was lost — released, expired, or
 * never threaded through — and the old behaviour of answering `held` for that
 * case collapsed "authority was lost" into "authority was never needed". The
 * lost lease is `not_held`: an agent whose claim lapsed must be refused, not
 * waved through because nobody handed the checker anything to check.
 */
export async function readLeaseState(
	claimId: string | null | undefined,
	sessionTaskId: string | null,
	now: Date,
): Promise<LeaseState> {
	if (claimId === null || claimId === undefined) {
		return sessionTaskId === null ? "held" : "not_held";
	}
	try {
		const [row] = await db
			.select({ releasedAt: claims.releasedAt, expiresAt: claims.expiresAt })
			.from(claims)
			.where(eq(claims.id, claimId))
			.limit(1);
		if (!row) return "not_held";
		if (row.releasedAt !== null) return "not_held";
		// An expired lease reads as not held even though the row survives. The holder
		// may still be running — that is case (d) — and the fence, not this check, is
		// what keeps it from doing damage.
		if (row.expiresAt.getTime() <= now.getTime()) return "not_held";
		return "held";
	} catch {
		return "unknown";
	}
}

// ---------------------------------------------------------------------------
// Fencing
// ---------------------------------------------------------------------------

/**
 * Why a fence check failed, or that it did not.
 *
 * `state_unknown` is separate from every other member for the usual reason, and it
 * refuses like the rest: this is an authority check, so an unreadable fence is
 * treated as a fence we do not hold.
 */
export type FenceVerdict =
	| { valid: true; token: number }
	| { valid: false; reason: "unknown_sandbox" }
	| { valid: false; reason: "token_mismatch"; expected: number }
	| { valid: false; reason: "superseded"; current: number }
	| { valid: false; reason: "lifecycle_closed"; status: string }
	| { valid: false; reason: "state_unknown"; detail: string };

/**
 * The ordinal of one sandbox row within its session, which is its fencing token.
 *
 * A tuple comparison rather than two predicates, because `(created_at, id)` is the
 * ordering `openAttempt` maintains and splitting it into `created_at < x or
 * (created_at = x and id <= y)` is the same thing written in a way that is easy to
 * get subtly wrong on the boundary.
 *
 * **The boundary is read back from Postgres rather than sent to it, and that is
 * not a stylistic preference.** `timestamptz` has microsecond resolution; a
 * JavaScript `Date` has millisecond resolution. A row whose `created_at` is
 * `…454123` comes back through the driver as `…454000`, and comparing the row
 * against its own round-tripped timestamp is therefore *false* — so a sandbox did
 * not count itself, every ordinal was one too low, and `validateFence` refused
 * every single call from every bridge with `token_mismatch, expected 0`. The
 * symptom is a product where no sandbox can write to a transcript, push a branch
 * or fetch a credential, and nothing in the logs points at a rounding error.
 * Comparing inside SQL means the value never leaves Postgres and cannot lose
 * precision on the way.
 */
async function fencingTokenOf(row: SandboxRow): Promise<number> {
	const result = (await db.execute(raw`
		select count(*)::int as ordinal
		from ${sandboxes} s
		where s.session_id = (select session_id from ${sandboxes} where id = ${row.id}::uuid)
			and (s.created_at, s.id)
				<= (select created_at, id from ${sandboxes} where id = ${row.id}::uuid)
	`)) as unknown as Array<{ ordinal: number }>;
	return Number(result[0]?.ordinal ?? 0);
}

/** The token the newest sandbox row for a session holds. Zero when there are none. */
export async function currentFencingToken(sessionId: string): Promise<number> {
	const result = (await db.execute(raw`
		select count(*)::int as total from ${sandboxes}
		where ${sandboxes.sessionId} = ${sessionId}::uuid
	`)) as unknown as Array<{ total: number }>;
	return Number(result[0]?.total ?? 0);
}

/**
 * May this sandbox still perform a privileged side effect?
 *
 * Called before writing to the transcript, pushing a branch, opening a pull request
 * or taking a snapshot. The check that matters is `superseded`: a box whose lease
 * lapsed while it was still working is refused **even though it is running, healthy
 * and convinced it owns the session**, because a newer box now holds the fence.
 * Nothing here tries to kill it; killing a remote container is best-effort and
 * asynchronous, and a guarantee that depends on a kill landing is not a guarantee.
 * Refusing its writes is synchronous and local, and it is what turns "two agents
 * pushed to one branch" into "one agent got a refusal in its log".
 *
 * `lifecycle_closed` uses `isReconnectBlockedStatus`, so `failed` is deliberately
 * still allowed: a slow boot can outlive the connecting watchdog that marked it
 * failed and then come up working, and refusing that box throws away a sandbox that
 * is demonstrably alive. `stopped` and `stale` are terminal by our own action, so
 * anything still talking from one is a zombie.
 */
export async function validateFence(sandboxId: string, token: number): Promise<FenceVerdict> {
	try {
		const [row] = await db.select().from(sandboxes).where(eq(sandboxes.id, sandboxId)).limit(1);
		if (!row) return { valid: false, reason: "unknown_sandbox" };
		if (isReconnectBlockedStatus(row.status)) {
			return { valid: false, reason: "lifecycle_closed", status: row.status };
		}

		const [ordinal, current] = await Promise.all([
			fencingTokenOf(row),
			currentFencingToken(row.sessionId),
		]);
		if (token !== ordinal) return { valid: false, reason: "token_mismatch", expected: ordinal };
		if (ordinal !== current) return { valid: false, reason: "superseded", current };
		return { valid: true, token: ordinal };
	} catch (error) {
		// AUTHORITY FAILS CLOSED, again, and for the third time in this file the
		// opposite of what `readCircuit` does. An unreadable fence is a fence we do
		// not hold.
		return { valid: false, reason: "state_unknown", detail: (error as Error).message };
	}
}

// ---------------------------------------------------------------------------
// Spawn saga
// ---------------------------------------------------------------------------

/**
 * What a `requested` row with no external id means right now.
 *
 * The distinction is the whole reason the saga terminates. A row that another
 * worker wrote seconds ago is an attempt *in flight*, and treating it as resumable
 * would have both workers call the provider — the duplication the lock exists to
 * prevent. The same row an hour later, or one carrying a `failureReason`, is the
 * residue of a worker that crashed or of a create whose response was lost, and
 * treating *that* as in-flight would wedge the session at `already_active` forever
 * with no box behind it.
 *
 * The boundary is `sandboxBootTimeoutMs`, which is the same number the connecting
 * watchdog uses, so the two cannot disagree about when an attempt has stopped being
 * plausible.
 */
type PendingAttempt =
	| { state: "none" }
	| { state: "in_flight"; row: SandboxRow }
	| { state: "resumable"; row: SandboxRow; reason: "ambiguous_failure" | "worker_crashed" };

function classifyPendingAttempt(
	rows: SandboxRow[],
	now: Date,
	overrides?: RepoOverrides,
): PendingAttempt {
	const row = rows.find(
		(candidate) => isOpenAttemptStatus(candidate.status) && candidate.externalId === null,
	);
	if (!row) return { state: "none" };
	// A recorded failure is proof the attempt concluded, so it is reconcilable
	// immediately rather than after the boot timeout. That is what makes the
	// lost-response retry fast instead of a three-minute wait for a box the caller
	// is standing there waiting for.
	if (row.failureReason !== null) return { state: "resumable", row, reason: "ambiguous_failure" };
	const elapsed = now.getTime() - row.createdAt.getTime();
	if (elapsed >= setting("sandboxBootTimeoutMs", overrides)) {
		return { state: "resumable", row, reason: "worker_crashed" };
	}
	return { state: "in_flight", row };
}

interface SpawnContext {
	orgId: string;
	sessionId: string;
	claimId: string | null;
	actor: string | null;
	traceId: string | null;
	provider: SandboxProvider;
	overrides: RepoOverrides;
	repoId: string | null;
	now: Date;
	lease: LeaseState;
	budgetRemainingMicroUsd: number;
	queueDepth: number;
	sessionPausedReason: string | null;
	circuit: Awaited<ReturnType<typeof readCircuit>>["decision"];
	estimateMicroUsd: number;
	image?: string;
	workspace?: string;
	env?: Record<string, string>;
	features?: Record<string, boolean>;
	command?: string[];
}

type OpenedAttempt =
	| { kind: "opened"; row: SandboxRow; token: number; resumed: boolean }
	| { kind: "refused"; reason: SpawnRefusal; detail: string };

/**
 * Take the admission decision and persist the intent, under one lock.
 *
 * The lock is a session-scoped **advisory** lock rather than `select … for update`
 * on the session row, and the difference is not stylistic. `appendEvents` updates
 * the session row to allocate a seq, so a saga holding that row lock and then
 * appending an event would block on a lock it holds itself, on a different
 * connection, forever. An advisory key nothing else takes cannot deadlock against
 * the event writer.
 *
 * Everything slow is outside: the provider call, the reservation, the events. What
 * is inside is read-decide-insert, which is exactly the sequence that has to be
 * atomic for two concurrent callers to produce one box.
 */
async function openAttempt(ctx: SpawnContext, allowResume: boolean): Promise<OpenedAttempt> {
	return db.transaction(async (tx) => {
		await tx.execute(raw`select pg_advisory_xact_lock(hashtextextended(${ctx.sessionId}::text, 0::bigint))`);

		const rows = await tx
			.select()
			.from(sandboxes)
			.where(eq(sandboxes.sessionId, ctx.sessionId))
			.orderBy(desc(sandboxes.createdAt), desc(sandboxes.id));

		const pending = allowResume
			? classifyPendingAttempt(rows, ctx.now, ctx.overrides)
			: { state: "none" as const };

		// Our own unfinished intent is excluded from the "already active" test, and
		// only ours. Left in, a create whose response was lost would make the session
		// permanently `already_active` behind a row that points at nothing — the exact
		// wedge that makes ambiguous failures unrecoverable without an operator.
		const excludedId = pending.state === "resumable" ? pending.row.id : null;
		const existing = rows.find((row) => row.id !== excludedId) ?? null;

		const decision = evaluateSpawnDecision({
			circuit: ctx.circuit,
			lease: ctx.lease,
			existingSandbox: existing ? { status: existing.status, externalId: existing.externalId } : null,
			orphan: null,
			budgetRemainingMicroUsd: ctx.budgetRemainingMicroUsd,
			sessionPausedReason: ctx.sessionPausedReason,
			queueDepth: ctx.queueDepth,
			overrides: ctx.overrides,
		});

		// No `default` branch, here or anywhere else in this file. A new member of
		// `SpawnDecision` is a compile error at this exact line rather than a silent
		// fall-through to whatever the last arm happened to do.
		switch (decision.decision) {
			case "refuse":
				return { kind: "refused" as const, reason: decision.reason, detail: decision.detail };
			case "adopt":
				// Unreachable: no orphan is supplied on this pass, and adoption is the
				// only branch that needs one. Stated rather than defaulted, so adding a
				// path that reaches it is a visible change here instead of a silent one.
				throw new HarborError("openAttempt: adoption decided without a reconciliation result");
			case "spawn":
				return persistIntent(tx, ctx, pending, rows);
		}
		return assertNever(decision, "spawn decision");
	});
}

/**
 * Reuse the resumable attempt, or write a new intent row. Called under the lock.
 *
 * The `sandbox_requested` event is appended HERE, on this transaction, so the
 * intent row and the ledger entry that records it commit together or not at
 * all. Before this, the event was appended by `ensureSandbox` after the
 * transaction returned, and a crash in between produced an attempt with no
 * record — an attempt id a post-mortem could never find, on the one payload
 * (this event's) that persists the fencing token for humans. The caller fires
 * `notifyChange` after commit; see `AppendOptions` in session-events.ts.
 */
async function persistIntent(
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	ctx: SpawnContext,
	pending: PendingAttempt,
	rows: SandboxRow[],
): Promise<OpenedAttempt> {
	if (pending.state === "resumable") {
		const token = await tokenWithin(tx, pending.row);
		await appendRequestedEvent(tx, ctx, pending.row, token, true);
		return { kind: "opened", row: pending.row, token, resumed: true };
	}

	// `created_at` is forced strictly upwards, and this line is load-bearing for the
	// fence. `defaultNow()` is the transaction timestamp, so two attempts a
	// millisecond apart can share one — and the tie would then be broken by uuid,
	// which is random. A newer row whose uuid sorted low would compute a lower
	// ordinal than the row it superseded, decide it had been superseded itself, and
	// refuse every one of its own privileged writes with `superseded` while the box
	// ran happily and produced nothing. Monotonic creation instants make the
	// ordering total and the token unambiguous.
	const newest = rows[0]?.createdAt ?? null;
	const createdAt =
		newest !== null && newest.getTime() >= ctx.now.getTime()
			? new Date(newest.getTime() + 1)
			: ctx.now;

	const [row] = await tx
		.insert(sandboxes)
		.values({
			orgId: ctx.orgId,
			sessionId: ctx.sessionId,
			provider: ctx.provider.name,
			status: "requested",
			createdAt,
		})
		.returning();

	const token = await tokenWithin(tx, row!);
	await appendRequestedEvent(tx, ctx, row!, token, false);
	return { kind: "opened", row: row!, token, resumed: false };
}

/** The ledger half of `persistIntent`, on the same transaction. */
async function appendRequestedEvent(
	tx: Executor,
	ctx: SpawnContext,
	row: SandboxRow,
	token: number,
	resumed: boolean,
): Promise<void> {
	await appendEvent(
		{
			orgId: ctx.orgId,
			sessionId: ctx.sessionId,
			type: "sandbox_requested",
			actor: ctx.actor,
			payload: {
				sandbox_id: row.id,
				// The attempt id IS the row id. One identifier means there is no second
				// thing to keep in sync, and no way for a label on a container to point at
				// a row that does not exist.
				attempt_id: row.id,
				fencing_token: token,
				provider: ctx.provider.name,
				resumed,
			},
		},
		{ executor: tx },
	);
}

/** `fencingTokenOf` against a transaction, so the token is read under the lock. */
async function tokenWithin(
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	row: SandboxRow,
): Promise<number> {
	const result = (await tx.execute(raw`
		select count(*)::int as ordinal
		from ${sandboxes}
		where ${sandboxes.sessionId} = ${row.sessionId}::uuid
			and (${sandboxes.createdAt}, ${sandboxes.id}) <= (${row.createdAt.toISOString()}::timestamptz, ${row.id}::uuid)
	`)) as unknown as Array<{ ordinal: number }>;
	return Number(result[0]?.ordinal ?? 0);
}

/**
 * Which timeline event a refusal produces — and the one that produces none.
 *
 * Exhaustive with no `default`, so a new `SpawnRefusal` forces a decision here
 * rather than inheriting whatever the last branch happened to be.
 *
 * `already_active` is silent on purpose. It is the normal outcome of two clients
 * asking for a sandbox at once, and writing `policy_denied` for it would put an
 * alarming red line on the timeline of a session where nothing whatsoever went
 * wrong — several times, on every page load, in a busy room.
 */
function refusalEventType(reason: SpawnRefusal): SessionEventType | null {
	switch (reason) {
		case "already_active":
			return null;
		case "budget_exhausted":
			return "budget_exhausted";
		case "circuit_open":
		case "policy_denied":
		case "queue_full":
		case "lease_not_held":
		case "lease_state_unknown":
		case "session_paused":
			return "policy_denied";
	}
	return assertNever(reason, "spawn refusal");
}

/** Per-repository overrides, merged under the caller's own. */
async function overridesFor(
	repoId: string | null,
	extra: RepoOverrides | undefined,
): Promise<RepoOverrides> {
	if (repoId === null) return extra ?? {};
	const [row] = await db
		.select({ config: repos.config })
		.from(repos)
		.where(eq(repos.id, repoId))
		.limit(1);
	const config = (row?.config ?? {}) as RepoOverrides;
	return { ...config, ...(extra ?? {}) };
}

/**
 * Ensure this session has a sandbox, exactly once, whatever happened last time.
 *
 * The saga, in order, and every step is where it is for a reason stated at the step:
 * read state → decide → open (or resume) the intent under the lock → reconcile →
 * reserve → create → persist → account.
 */
export async function ensureSandbox(input: EnsureSandboxInput): Promise<SpawnOutcome> {
	const now = input.now ?? new Date();
	const provider = input.provider ?? defaultProvider();
	const actor = input.actor ?? "harbor";

	const [session] = await db
		.select()
		.from(sessions)
		.where(and(eq(sessions.id, input.sessionId), eq(sessions.orgId, input.orgId)))
		.limit(1);
	// Fails closed, and scoped by org: a session another tenant owns is
	// indistinguishable here from one that does not exist, and both refuse.
	if (!session) throw new HarborError("No such session.");

	const overrides = await overridesFor(session.repoId, input.repoOverrides);

	// The execution glue: the repositories to clone, the agent runtime, and the
	// session's secrets, built from its snapshot and injected into whichever
	// provider boots the box. `input.env` wins on conflict so a test or a per-session
	// override can still set a variable explicitly; the four control-plane variables
	// injected at `create` win over both, so nothing here can redirect the box.
	const sessionEnv = await buildSandboxEnv(session);
	const mergedEnv = { ...sessionEnv, ...(input.env ?? {}) };

	// The reads that do not need the lock happen before it, so the critical section
	// is three statements long. Each of these can go stale between here and the
	// insert; none of them can go stale in a way that duplicates a box, which is the
	// only thing the lock is protecting.
	const [lease, circuit, budget, queueDepth] = await Promise.all([
		readLeaseState(input.claimId ?? null, session.taskId, now),
		readCircuit(input.orgId, provider.name, now, overrides).then((reading) => reading.decision),
		budgetStatus(input.orgId, { repoOverrides: overrides }),
		countQueuedPrompts(input.sessionId),
	]);

	const ctx: SpawnContext = {
		orgId: input.orgId,
		sessionId: input.sessionId,
		claimId: input.claimId ?? null,
		actor,
		traceId: input.traceId ?? null,
		provider,
		overrides,
		repoId: session.repoId,
		now,
		lease,
		budgetRemainingMicroUsd: budget.remainingMicroUsd,
		queueDepth,
		sessionPausedReason: session.pausedReason,
		circuit,
		// The operator's per-spawn estimate, so the daily cap can gate spawns and
		// not only the token spend recorded after the fact. Zero by default — an
		// honest zero; see the setting's derivation.
		estimateMicroUsd: input.estimateMicroUsd ?? setting("sandboxSpawnEstimateMicroUsd", overrides),
		image: input.image,
		workspace: input.workspace,
		env: mergedEnv,
		features: input.features,
		command: input.command,
	};

	const opened = await openAttempt(ctx, true);
	if (opened.kind === "refused") return refuse(ctx, opened.reason, opened.detail);
	// The `sandbox_requested` event committed with the intent row inside
	// `openAttempt`; the NOTIFY the executor-mode append skipped is fired here,
	// after that commit, per the AppendOptions contract.
	await notifyChange(ctx.orgId, "session_event");

	if (opened.resumed) {
		const reconciled = await reconcile(ctx, opened.row, opened.token);
		if (reconciled.kind !== "no_orphan") return reconciled.outcome;

		// The previous attempt left nothing usable. Its attempt id is burned — a dead
		// box may still carry that label, and reusing it would make the next
		// reconciliation adopt a corpse — so the row is retired and a fresh attempt is
		// opened. `allowResume: false` makes a loop structurally impossible rather
		// than merely unlikely.
		await retireAttempt(opened.row, "provider_error", ctx.now);
		const reopened = await openAttempt(ctx, false);
		if (reopened.kind === "refused") return refuse(ctx, reopened.reason, reopened.detail);
		await notifyChange(ctx.orgId, "session_event");
		return spawn(ctx, reopened.row, reopened.token);
	}

	return spawn(ctx, opened.row, opened.token);
}

async function countQueuedPrompts(sessionId: string): Promise<number> {
	const result = (await db.execute(raw`
		select count(*)::int as depth from ${sessionPrompts}
		where ${sessionPrompts.sessionId} = ${sessionId}::uuid and ${sessionPrompts.status} = 'queued'
	`)) as unknown as Array<{ depth: number }>;
	return Number(result[0]?.depth ?? 0);
}

async function refuse(
	ctx: SpawnContext,
	reason: SpawnRefusal,
	detail: string,
): Promise<SpawnOutcome> {
	const type = refusalEventType(reason);
	if (type !== null) {
		await appendEvent({
			orgId: ctx.orgId,
			sessionId: ctx.sessionId,
			type,
			actor: ctx.actor,
			payload: { reason, detail, provider: ctx.provider.name },
		});
	}
	return { kind: "refused", reason };
}

type Reconciliation =
	| { kind: "resolved"; outcome: SpawnOutcome }
	| { kind: "no_orphan" };

/**
 * Ask the provider whether the box we may have created exists.
 *
 * This is the step that makes ambiguous failures survivable, and it is also the one
 * that costs a round trip on every retry — an accepted price, written down in
 * docs/adr/0002. The alternative is to assume, and both assumptions are wrong in an
 * expensive direction: assume it exists and the session never gets a box, assume it
 * does not and the org pays for two.
 *
 * A box that is found but not live is *not* adopted. `isLive` is a deny-list, so
 * only `exited` and `gone` reach that branch — an unrecognised provider state reads
 * as live and is adopted, which is the fail-open direction: adopting a box that is
 * actually dead costs one boot timeout, while abandoning one that is actually alive
 * strands a running container with no row pointing at it and nothing that will ever
 * stop it.
 */
async function reconcile(ctx: SpawnContext, row: SandboxRow, token: number): Promise<Reconciliation> {
	let found: Awaited<ReturnType<SandboxProvider["findByAttemptId"]>>;
	try {
		found = await ctx.provider.findByAttemptId(row.id);
	} catch (error) {
		// `findByAttemptId` throws rather than returning null when it cannot reach the
		// backend, precisely so this branch exists. Returning "no orphan" here would
		// spawn a second box on a network blip.
		const outcome = await recordSpawnFailure(ctx, row, error);
		return { kind: "resolved", outcome };
	}

	if (found === null || !isLive(found.state)) return { kind: "no_orphan" };

	const decision = evaluateSpawnDecision({
		circuit: ctx.circuit,
		lease: ctx.lease,
		existingSandbox: null,
		orphan: { externalId: found.externalId },
		budgetRemainingMicroUsd: ctx.budgetRemainingMicroUsd,
		sessionPausedReason: ctx.sessionPausedReason,
		queueDepth: ctx.queueDepth,
		overrides: ctx.overrides,
	});

	switch (decision.decision) {
		case "refuse":
			// Authority changed under us between the two passes — the lease lapsed, or
			// the session was paused. The orphan is left alone deliberately: the row
			// still points at it, so the connecting watchdog will find and stop it.
			return { kind: "resolved", outcome: await refuse(ctx, decision.reason, decision.detail) };
		case "spawn":
			// Cannot happen with an orphan present. Treated as "do not adopt" rather
			// than as an error, because the safe reading of an unexpected answer here
			// is to leave the box for the watchdog rather than to attach to it.
			return { kind: "no_orphan" };
		case "adopt": {
			// Adoption and its ledger event commit together, same as the created
			// path: an adopted box must never exist without the `sandbox_spawning`
			// event that says which attempt owns it.
			const claimed = await db.transaction(async (tx) => {
				const attached = await claimAttempt(tx, row.id, {
					externalId: decision.externalId,
					status: "spawning",
					failureReason: null,
				});
				if (!attached) return false;
				await appendEvent(
					{
						orgId: ctx.orgId,
						sessionId: ctx.sessionId,
						type: "sandbox_spawning",
						actor: ctx.actor,
						payload: {
							sandbox_id: row.id,
							attempt_id: row.id,
							external_id: decision.externalId,
							fencing_token: token,
							adopted: true,
							reason: decision.reason,
						},
					},
					{ executor: tx },
				);
				return true;
			});
			if (!claimed) {
				// The attempt was closed while we were asking the provider about it — the
				// connecting watchdog reached it, or somebody stopped the session. The row
				// is no longer ours to attach a box to, and adopting anyway would put a
				// live container behind a row that a reaper has already accounted for. The
				// orphan is stopped here rather than left for a sweep, because a sweep only
				// examines rows that are not on the dead deny-list and this row now is:
				// nothing would ever look at it again, and the container would keep
				// running until somebody read an invoice.
				await stopOrphan(ctx, decision.externalId);
				return {
					kind: "resolved",
					outcome: {
						kind: "failed",
						error_type: "unknown",
						message:
							"This spawn attempt was closed while its orphan was being reconciled, so the "
							+ "orphan was stopped rather than adopted onto a row that no longer owns the "
							+ "session.",
					},
				};
			}
			await notifyChange(ctx.orgId, "session_event");
			// The org-ledger counterpart, for the orphan-rate metric: adoption is
			// reconciliation SUCCEEDING, and a rate nobody can read is a rate that
			// silently climbs. Best-effort — telemetry never fails an adoption.
			await recordOrphanReconciled(ctx.orgId, row.id, decision.externalId, "adopted");
			return {
				kind: "resolved",
				outcome: {
					kind: "adopted",
					sandbox_id: row.id,
					external_id: decision.externalId,
					reason: "reconciled_orphan",
				},
			};
		}
	}
	return assertNever(decision, "reconciliation decision");
}

/**
 * Reserve, call the provider, persist, account.
 *
 * The reservation sits between the intent and the provider call rather than before
 * the intent, and the ordering is forced: the reservation is keyed on the attempt
 * id so that a retry of the same attempt is absorbed instead of charged twice, and
 * the attempt id does not exist until the intent is persisted. A refused
 * reservation retires the intent immediately, because a `requested` row left behind
 * would read as an attempt in flight and block the session for a boot timeout over
 * a spend cap that will still be reached a second later.
 */
/**
 * `HARBOR_RESUME_TOKEN`, or nothing, plus the timeline note when it is nothing.
 *
 * The decision is `resumeTokenForBoot`; this is the query and the effects. The
 * notice is emitted as a `log`-shaped session event rather than being swallowed,
 * because a sandbox replacement that quietly resets the agent's memory is
 * indistinguishable, from the room, from a model that has started ignoring the
 * conversation.
 */
async function resumeEnvFor(sessionId: string, bootMode: string): Promise<Record<string, string>> {
	const [session] = await db
		.select({
			orgId: sessions.orgId,
			runtime: sessions.runtime,
			token: sessions.agentResumeToken,
			mintedBy: sessions.agentResumeRuntime,
		})
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.limit(1);
	if (!session) return {};

	const verdict = resumeTokenForBoot({
		storedToken: session.token,
		storedRuntime: session.mintedBy,
		sessionRuntime: session.runtime,
		bootMode,
	});
	if (verdict.resume) return { HARBOR_RESUME_TOKEN: verdict.token };

	if (verdict.notice !== null) {
		await appendEvent({
			orgId: session.orgId,
			sessionId,
			type: "session_error",
			actor: "harbor",
			payload: {
				kind: "agent_context_lost",
				reason: verdict.reason,
				boot_mode: bootMode,
				message: verdict.notice,
			},
		});
	}
	return {};
}

async function spawn(ctx: SpawnContext, row: SandboxRow, token: number): Promise<SpawnOutcome> {
	// Integer micro-USD, never a float. A fractional estimate would make `spent +
	// estimate > cap` true for a rounding artefact, and worse, would accumulate
	// error across a million rows in the direction of a spend report nobody can
	// reconcile.
	const estimate = Math.max(0, Math.round(ctx.estimateMicroUsd));
	const costRef = {
		orgId: ctx.orgId,
		claimId: ctx.claimId,
		sessionId: ctx.sessionId,
		key: row.id,
	};

	const reservation = await reserveBudget(ctx.orgId, estimate, {
		...costRef,
		kind: "sandbox_spawn",
		repoId: ctx.repoId,
		actor: ctx.actor,
		provider: ctx.provider.name,
		repoOverrides: ctx.overrides,
		now: ctx.now,
	});
	if (!reservation.ok) {
		await retireAttempt(row, null, ctx.now);
		// `state_unavailable` is reported as `budget_exhausted` because `SpawnRefusal`
		// has no member for "spend could not be determined". The refusal is right —
		// budget is authority and authority fails closed — but the wire vocabulary is
		// coarser than the decision, so the true reason survives only in the event
		// payload. Noted in the module report as a contract gap.
		return refuse(ctx, "budget_exhausted", reservation.message);
	}

	const boot = await resolveBoot(ctx);

	// Mint the box's own credential, and store only its digest.
	//
	// This is the enrolment step, and without it the whole execution plane is
	// inert: the supervisor exits 78 for want of `HARBOR_SANDBOX_TOKEN`, and a box
	// that somehow started anyway would be told `sandbox_unenrolled` by
	// `authenticateSandbox` because the row carries a null digest. Every other part
	// of the saga can be correct and nothing works.
	//
	// The plaintext exists in exactly two places and never a third: this local, and
	// the environment of the box it belongs to. The row keeps a SHA-256 digest, for
	// the same reason `api_keys` does and a stronger one — this credential lets a
	// box write into a session's transcript and fetch git credentials, so a database
	// dump containing it would hand over both. Unsalted because the search space is
	// CSPRNG output, and because a salted column cannot be indexed and this is read
	// on the hot path of every event batch.
	//
	// Minted per attempt rather than per session, so a superseded box's token dies
	// with its row. That is belt to the fencing token's braces: the fence stops a
	// stale box acting, and a per-attempt token means a leaked one from a box that
	// has been reaped is worthless rather than merely fenced.
	const sandboxToken = randomBytes(32).toString("base64url");
	await db
		.update(sandboxes)
		.set({ authTokenHash: sha256Hex(sandboxToken) })
		.where(eq(sandboxes.id, row.id));

	try {
		const created = await boot.create({
			sessionId: ctx.sessionId,
			sandboxId: row.id,
			attemptId: row.id,
			// A repo_image boot swaps in the published per-repo image; otherwise the
			// caller's explicit image, otherwise the global default. `boot.image` is only
			// set when resolveBoot chose repo_image, so this never shadows a snapshot.
			image: boot.image ?? ctx.image ?? setting("sandboxImage", ctx.overrides),
			workspace: ctx.workspace ?? "/workspace",
			// Caller-supplied secrets first, so nothing a repository configures can
			// shadow the four variables the supervisor needs to reach us. A repo
			// secret named HARBOR_CONTROL_URL would otherwise point a sandbox at an
			// attacker's control plane, which it would then hand its token to.
			env: {
				...(ctx.env ?? {}),
				// The agent's own conversation id from the box this one replaces, and
				// ONLY when this boot restored the filesystem its transcript lives on.
				// Inside the Harbor-controlled spread rather than in `buildSandboxEnv`
				// because the boot mode is not known until here — and a repository
				// secret must not be able to hand the agent an arbitrary session id.
				...(await resumeEnvFor(ctx.sessionId, boot.mode)),
				HARBOR_CONTROL_URL: controlPlaneUrl(),
				HARBOR_SANDBOX_ID: row.id,
				HARBOR_SESSION_ID: ctx.sessionId,
				HARBOR_SANDBOX_TOKEN: sandboxToken,
				HARBOR_FENCING_TOKEN: String(await currentFencingToken(ctx.sessionId)),
				HARBOR_BOOT_MODE: boot.mode,
				// Inside the Harbor-controlled spread, so a repo secret named
				// HARBOR_TRACE_ID cannot shadow the correlation chain.
				...(ctx.traceId ? { HARBOR_TRACE_ID: ctx.traceId } : {}),
				// Where `harbor-agent` is served, if this deployment serves it. Also
				// inside the spread, and for a sharper reason than the others: the
				// sandbox sends its token and its fence to this URL on every tool call,
				// so a repository secret able to set it would be a credential
				// exfiltration primitive granted by merge access.
				//
				// Omitted rather than defaulted when unset. A deployment that runs only
				// the dashboard has no MCP server, and a guessed URL would cost every
				// turn a connection timeout while the transcript fills with errors about
				// a server nobody deployed.
				...(agentMcpUrl() ? { HARBOR_AGENT_MCP_URL: agentMcpUrl()! } : {}),
			},
			timeoutMs: setting("sandboxBootTimeoutMs", ctx.overrides),
			features: ctx.features ?? {},
			command: ctx.command,
		});

		// The attach and its ledger event commit together: a crash after this
		// transaction leaves either a `requested` row (reconcilable) or a
		// `spawning` row WITH its `sandbox_spawning` event — never a box attached
		// to a row the timeline knows nothing about.
		const claimed = await db.transaction(async (tx) => {
			const attached = await claimAttempt(tx, row.id, {
				externalId: created.externalId,
				status: "spawning",
				bootMode: boot.mode,
				restoredFrom: boot.restoredFrom,
				failureReason: null,
			});
			if (!attached) return false;
			await appendEvent(
				{
					orgId: ctx.orgId,
					sessionId: ctx.sessionId,
					type: "sandbox_spawning",
					actor: ctx.actor,
					payload: {
						sandbox_id: row.id,
						attempt_id: row.id,
						external_id: created.externalId,
						fencing_token: token,
						boot_mode: boot.mode,
						provider: ctx.provider.name,
					},
				},
				{ executor: tx },
			);
			return true;
		});
		if (!claimed) {
			// The lifecycle moved on while the provider was creating the box, and this is
			// not exotic: `provider.create` is handed `sandboxBootTimeoutMs` and the
			// connecting watchdog fires on exactly that number, so a create that runs to
			// its limit races the reaper by construction — and a human cancelling the
			// session hits the same window. An unconditional write here resurrects the
			// row from `stopped` to `spawning`, which also un-blocks reconnection: the
			// box somebody just cancelled comes up, holds the session's newest fence, and
			// is handed the next prompt. So the box that was created is stopped instead
			// of persisted, and the failure is reported rather than hidden.
			await stopOrphan(ctx, created.externalId);
			return {
				kind: "failed",
				error_type: "unknown",
				message:
					"This sandbox was created, but its attempt had already been closed — reaped or "
					+ "stopped — by the time the provider answered, so the box was stopped rather than "
					+ "attached to a row that no longer owns the session.",
			};
		}
		await notifyChange(ctx.orgId, "session_event");

		// The breaker is cleared by the thing that proves the provider works, not by a
		// timer. Left uncleared, a successful half-open probe leaves the row open and
		// every other session keeps being refused until the window ages out.
		await recordProviderSuccess(ctx.orgId, ctx.provider.name);

		// Recorded AFTER the provider call and keyed on the attempt, so it is
		// idempotent: a retry of this exact attempt collides on the derived primary
		// key and is absorbed. Recording before would invent charges for boxes that
		// were never created. The final supersedes the reservation, so the estimate
		// stops counting against the cap.
		await finalizeReservation({
			...costRef,
			kind: "sandbox_spawn",
			repoId: ctx.repoId,
			actor: ctx.actor,
			provider: ctx.provider.name,
			microUsd: estimate,
			quantity: 1,
			createdAt: ctx.now,
		});

		return { kind: "created", sandbox_id: row.id, external_id: created.externalId };
	} catch (error) {
		return recordSpawnFailure(ctx, row, error);
	}
}

/**
 * How this box comes up, with the capability checked by the TYPE rather than by a
 * boolean.
 *
 * `capabilities.supportsRestore` is a description written by the provider, and
 * descriptions can be wrong; `isSnapshotProvider` is checked by the compiler. So the
 * boolean may only *suggest* a restore and the narrowing decides, and a provider
 * whose description lies falls back to a fresh boot and records `fresh` — the
 * recorded mode always matches what actually happened. A recorded mode that lies is
 * worse than a slow boot: `HARBOR_BOOT_MODE` tells `setup.sh` whether to run, so the
 * symptom of getting it wrong is dependencies silently missing.
 */
async function resolveBoot(ctx: SpawnContext): Promise<{
	mode: "fresh" | "snapshot_restore" | "repo_image";
	restoredFrom: string | null;
	/** An image reference to boot from, overriding the global default. Only set for repo_image. */
	image: string | null;
	create: (config: Parameters<SandboxProvider["create"]>[0]) => Promise<{ externalId: string }>;
}> {
	const previous = await db
		.select({ snapshotRef: sandboxes.snapshotRef })
		.from(sandboxes)
		.where(and(eq(sandboxes.sessionId, ctx.sessionId), isNotNull(sandboxes.snapshotRef)))
		.orderBy(desc(sandboxes.createdAt))
		.limit(1);

	const stored = previous[0]?.snapshotRef ?? null;
	const repoImageRef = await resolveRepoImageRef(ctx);

	const resolution = resolveBootMode({
		snapshotRef: stored,
		repoImageRef,
		capabilities: ctx.provider.capabilities,
		overrides: ctx.overrides,
	});

	const ref = stored === null ? null : parseSnapshotRef(stored);
	if (resolution.mode === "snapshot_restore" && ref !== null && isSnapshotProvider(ctx.provider)) {
		const snapshotProvider: SnapshotProvider = ctx.provider;
		return {
			mode: "snapshot_restore",
			restoredFrom: ref.handle,
			image: null,
			create: (config) => snapshotProvider.restoreFromSnapshot(ref, config),
		};
	}

	const provider = ctx.provider;
	if (resolution.mode === "repo_image" && repoImageRef !== null) {
		// The provider boots the image the same way it boots any other — the image is
		// swapped in at the spawn's `create` config below. `restoredFrom` records the
		// image ref for provenance, mirroring what a snapshot restore records.
		return {
			mode: "repo_image",
			restoredFrom: repoImageRef,
			image: repoImageRef,
			create: (config) => provider.create(config),
		};
	}

	return { mode: "fresh", restoredFrom: null, image: null, create: (config) => provider.create(config) };
}

/**
 * The published prebuilt image to boot this session from, or null.
 *
 * Two gates, and both are type/decision gates rather than capability booleans. The
 * provider must be an `ImageBuildingProvider` — the capability to boot a per-repo
 * image is co-located with the capability to build one, so a provider that cannot
 * build them (the `local` provider, whose `create` image is a runtime id, not an
 * image reference) is never handed one to boot. And the pointer must be fresh by
 * `evaluateImageFreshness`, so a stalled pipeline degrades to a cold boot rather than
 * booting an ever-staler image. Everything time- and config-dependent is in that pure
 * decision; this function only reads the row and applies it.
 */
async function resolveRepoImageRef(ctx: SpawnContext): Promise<string | null> {
	if (ctx.repoId === null || !isImageBuildingProvider(ctx.provider)) return null;

	const [pointer] = await db
		.select({ imageRef: repoImages.imageRef, builtAt: repoImages.builtAt })
		.from(repoImages)
		.where(eq(repoImages.repoId, ctx.repoId))
		.limit(1);
	if (!pointer) return null;

	const freshness = evaluateImageFreshness(
		{
			imageRef: pointer.imageRef,
			builtFromSha: null,
			builtAt: pointer.builtAt,
			nextBuildAt: null,
			consecutiveFailures: 0,
			pausedReason: null,
		},
		ctx.now,
		ctx.overrides,
	);
	return freshness.bootable ? pointer.imageRef : null;
}

/** A `SnapshotRef` stored as JSON in a `text` column, or null if it is not one. */
function parseSnapshotRef(stored: string): SnapshotRef | null {
	try {
		const parsed = JSON.parse(stored) as Partial<SnapshotRef>;
		if (typeof parsed.handle !== "string" || typeof parsed.provider !== "string") return null;
		return {
			provider: parsed.provider,
			handle: parsed.handle,
			sourceExternalId: parsed.sourceExternalId ?? "",
			takenAt: parsed.takenAt ?? new Date(0).toISOString(),
		};
	} catch {
		return null;
	}
}

/**
 * Account for a failed provider call without destroying the evidence.
 *
 * The row stays in `requested` and gains a `failureReason`, which is what makes the
 * next `ensureSandbox` reconcile instead of spawn. Marking it `failed` here would be
 * tidier and would lose the attempt id — and with it the only handle on a container
 * that may well be running and billing. That is the failure this whole file exists
 * to prevent, so the untidy row is the correct one.
 *
 * If no retry ever comes, `onConnectingTimeout` reaps it: the same attempt id is
 * reconciled there and any orphan is stopped.
 */
async function recordSpawnFailure(
	ctx: SpawnContext,
	row: SandboxRow,
	error: unknown,
): Promise<SpawnOutcome> {
	const errorType: ProviderErrorType =
		error instanceof SandboxProviderError ? error.errorType : classifyProviderError(error);
	const message = error instanceof Error ? error.message : String(error);

	// The failure mark and its event commit together. Separately, a crash between
	// them left a row that reconciles as `ambiguous_failure` with a timeline that
	// never says a provider call failed — the row's behaviour was right and the
	// record was wrong, which is the combination a post-mortem cannot survive.
	//
	// The reservation is deliberately NOT released. The box may exist — that is
	// what "ambiguous" means — and releasing it would under-count spend for
	// exactly the containers nobody can see. Reservations age out on their own.
	await db.transaction(async (tx) => {
		await tx
			.update(sandboxes)
			.set({ failureReason: "provider_error" })
			.where(and(eq(sandboxes.id, row.id), eq(sandboxes.status, "requested")));
		await appendEvent(
			{
				orgId: ctx.orgId,
				sessionId: ctx.sessionId,
				type: "sandbox_failed",
				actor: ctx.actor,
				payload: {
					sandbox_id: row.id,
					attempt_id: row.id,
					error_type: errorType,
					message,
					provider: ctx.provider.name,
					reconcilable: true,
				},
			},
			{ executor: tx },
		);
	});
	await notifyChange(ctx.orgId, "session_event");

	await recordProviderFailure(ctx.orgId, ctx.provider.name, errorType, ctx.now, ctx.overrides);

	return { kind: "failed", error_type: errorType, message };
}

/**
 * Attach a created or adopted box to its attempt row, and only while that row is
 * still the open attempt.
 *
 * The predicate is `status = 'requested'`, which is the status `openAttempt`
 * writes and the only one meaning "nobody has concluded this attempt". Everything
 * that concludes one — `onConnectingTimeout`, `stopSandbox`, `retireAttempt` —
 * moves the row off `requested` first, so a zero-row result here is exactly
 * "somebody closed this attempt while the provider was still thinking", which is
 * the one state the callers must not write over.
 */
async function claimAttempt(
	tx: Executor,
	sandboxId: string,
	next: {
		externalId: string;
		status: SandboxStatus;
		failureReason: SandboxFailure | null;
		bootMode?: string;
		restoredFrom?: string | null;
	},
): Promise<boolean> {
	const updated = await tx
		.update(sandboxes)
		.set({
			externalId: next.externalId,
			status: next.status,
			failureReason: next.failureReason,
			...(next.bootMode !== undefined ? { bootMode: next.bootMode } : {}),
			...(next.restoredFrom !== undefined ? { restoredFrom: next.restoredFrom } : {}),
		})
		.where(and(eq(sandboxes.id, sandboxId), eq(sandboxes.status, "requested")))
		.returning({ id: sandboxes.id });
	return updated.length > 0;
}

/**
 * Stop a container that no row will ever point at again, without letting the stop
 * become the failure that is reported.
 *
 * Only reached when `claimAttempt` lost the race, so by definition nothing in the
 * database will find this box again and nothing else will ever stop it. A throw
 * here would replace an honest reported failure with an unreported one and still
 * leak the container.
 */
async function stopOrphan(ctx: SpawnContext, externalId: string): Promise<void> {
	try {
		await ctx.provider.stop(externalId);
	} catch (error) {
		console.error(`[sandbox] orphan stop failed for ${externalId}:`, (error as Error).message);
	}
}

/** Close out an attempt that will never produce a box. */
async function retireAttempt(
	row: SandboxRow,
	failureReason: SandboxFailure | null,
	now: Date,
): Promise<void> {
	await db
		.update(sandboxes)
		.set({
			// `failed` rather than `stopped`, because `failed` stays reconnectable: if
			// this attempt's box does turn up late with a working bridge, we would
			// rather adopt it than refuse a sandbox that is demonstrably alive.
			status: failureReason === null ? "stopped" : "failed",
			failureReason,
			stoppedAt: now,
		})
		.where(and(eq(sandboxes.id, row.id), eq(sandboxes.status, "requested")));
}

// ---------------------------------------------------------------------------
// Transport-facing transitions
// ---------------------------------------------------------------------------

/**
 * What a transport-level report did, in words.
 *
 * `lifecycle_closed` is the whole point of the type. A bridge whose box we already
 * reaped will keep talking — it does not know it is dead — and the answer it gets is
 * a refusal derived from the persisted status, not from whether a socket happens to
 * be open.
 */
export type TransportOutcome =
	| { accepted: true }
	| { accepted: false; reason: "unknown_sandbox" }
	| { accepted: false; reason: "lifecycle_closed"; status: string };

/**
 * The bridge says it is alive.
 *
 * Note what this does NOT touch: `sessions.lastActivityAt`. A heartbeat is proof the
 * box is running, never proof anybody is using it, and counting it as activity would
 * make `onInactivity` unreachable — every abandoned sandbox would refresh its own
 * idle clock fifteen seconds at a time and bill until somebody noticed. That is the
 * single largest cost lever in the product, disabled by one convenient-looking line.
 */
export async function heartbeat(sandboxId: string, now: Date = new Date()): Promise<TransportOutcome> {
	const [row] = await db
		.select({ status: sandboxes.status })
		.from(sandboxes)
		.where(eq(sandboxes.id, sandboxId))
		.limit(1);
	if (!row) return { accepted: false, reason: "unknown_sandbox" };
	// LIFECYCLE STATE IS AUTHORITATIVE OVER TRANSPORT. The persisted status is what
	// blocks reconnection, which is why the reapers write it before they close
	// anything.
	if (isReconnectBlockedStatus(row.status)) {
		return { accepted: false, reason: "lifecycle_closed", status: row.status };
	}
	await db.update(sandboxes).set({ lastHeartbeatAt: now }).where(eq(sandboxes.id, sandboxId));
	return { accepted: true };
}

/**
 * The bridge reports the box is up and serving.
 *
 * Idempotent: `readyAt` is written only once, because it is the number
 * time-to-ready is computed from and a bridge that reports ready twice after a
 * reconnect would otherwise make every boot look instantaneous.
 */
export async function markSandboxReady(
	sandboxId: string,
	options: {
		now?: Date;
		bootMode?: string | null;
		actor?: string | null;
		/**
		 * Whether this call is responsible for the `sandbox_ready` timeline event.
		 *
		 * The ingest route already writes one carrying the bridge's own boot payload —
		 * the mode, the warning count, the workspace — so it passes `false` and the
		 * timeline gets one event with the richer body instead of two events with the
		 * same meaning a millisecond apart, which reads to a user as the box having
		 * booted twice.
		 */
		announce?: boolean;
	} = {},
): Promise<TransportOutcome> {
	const now = options.now ?? new Date();
	const [row] = await db.select().from(sandboxes).where(eq(sandboxes.id, sandboxId)).limit(1);
	if (!row) return { accepted: false, reason: "unknown_sandbox" };
	if (isReconnectBlockedStatus(row.status)) {
		return { accepted: false, reason: "lifecycle_closed", status: row.status };
	}

	// COMPARE-AND-SET on the status this call observed, for the same reason
	// `transition` does it below. The read above and the write here are two
	// statements, and a reaper lands between them: `onInactivity` sees an idle box,
	// moves it to `stopped` and asks the provider to destroy it, and an
	// unconditional UPDATE then writes `ready` back over that decision. The row
	// would claim a healthy box while its container is being killed — `heartbeat`
	// accepts it, every sweep keeps examining it, and the client is shown a sandbox
	// to talk to that no longer exists. Zero rows updated means somebody else moved
	// the lifecycle on, and the honest answer is the one a blocked status gets.
	//
	// The CAS and the `sandbox_ready` event share one transaction, so time-to-ready
	// (computed from `readyAt`) can never exist without the event a human reads to
	// learn the box came up — or vice versa.
	const announce = row.status !== "ready" && options.announce !== false;
	const applied = await db.transaction(async (tx) => {
		const updated = await tx
			.update(sandboxes)
			.set({
				status: "ready",
				readyAt: row.readyAt ?? now,
				lastHeartbeatAt: now,
				failureReason: null,
				bootMode: options.bootMode ?? row.bootMode,
			})
			.where(and(eq(sandboxes.id, sandboxId), eq(sandboxes.status, row.status)))
			.returning({ id: sandboxes.id });
		if (updated.length > 0 && announce) {
			await appendEvent(
				{
					orgId: row.orgId,
					sessionId: row.sessionId,
					type: "sandbox_ready",
					actor: options.actor ?? "harbor",
					payload: {
						sandbox_id: row.id,
						external_id: row.externalId,
						boot_mode: options.bootMode ?? row.bootMode,
						// A box that reported ready after being written off is the case
						// `isReconnectBlockedStatus` deliberately allows. Recording it makes that
						// self-healing visible instead of mysterious.
						recovered_from: row.status === "failed" ? "failed" : null,
					},
				},
				{ executor: tx },
			);
		}
		return updated;
	});

	if (applied.length === 0) {
		const [current] = await db
			.select({ status: sandboxes.status })
			.from(sandboxes)
			.where(eq(sandboxes.id, sandboxId))
			.limit(1);
		if (!current) return { accepted: false, reason: "unknown_sandbox" };
		if (isReconnectBlockedStatus(current.status)) {
			return { accepted: false, reason: "lifecycle_closed", status: current.status };
		}
		// Another live transition won the race — a second `boot_ready` from the same
		// bridge, most likely. The box is up either way and whoever won has already
		// written the event, so this is accepted and silent.
		return { accepted: true };
	}

	if (announce) await notifyChange(row.orgId, "session_event");
	return { accepted: true };
}

// ---------------------------------------------------------------------------
// Stopping and snapshotting
// ---------------------------------------------------------------------------

export type StopSandboxResult =
	| { kind: "stopped"; outcome: StopOutcome }
	| { kind: "already_terminal"; status: string }
	| { kind: "unknown_sandbox" }
	| { kind: "unconfirmed"; errorType: ProviderErrorType; message: string };

/**
 * Stop a box, writing the dead status BEFORE asking the provider.
 *
 * The order is the rule stated in the file header. Ask first and write second, and a
 * box that reconnects in between is admitted as healthy — by a control plane that
 * has already decided to kill it — onto a session whose fence it no longer holds.
 * Writing first costs nothing and makes the refusal immediate.
 *
 * A provider error is reported as `unconfirmed` rather than swallowed or retried,
 * and it deliberately does NOT count towards the circuit breaker. The breaker exists
 * to protect the *spawn* path; a wave of failing stops during a provider incident
 * would open it for every session in the org at the moment they are all trying to
 * clean up, which is the opposite of helpful.
 *
 * Deliberately NOT behind the destruction lease gate the reapers use. This is an
 * explicit command with a named actor and a typed reason — an operator pressing
 * stop, a session being completed — not an *inference* of abandonment, and
 * refusing the operator because a claim row was slow to read would make the
 * emergency path depend on the database being healthy.
 */
export async function stopSandbox(
	sandboxId: string,
	reason: SandboxFailure,
	options: { provider?: SandboxProvider; now?: Date; actor?: string | null; graceMs?: number } = {},
): Promise<StopSandboxResult> {
	const now = options.now ?? new Date();
	const [row] = await db.select().from(sandboxes).where(eq(sandboxes.id, sandboxId)).limit(1);
	if (!row) return { kind: "unknown_sandbox" };
	if (isDeadSandboxStatus(row.status)) return { kind: "already_terminal", status: row.status };

	// The dead status and the `sandbox_stopped` event commit together, BEFORE the
	// provider is asked to do anything — the decision is the fact the ledger
	// records, and it is a fact whether or not the container obeys. A crash after
	// this transaction leaves a stopped row with its event and, at worst, a
	// container the orphan sweep will find; the old shape (event after the stop)
	// could leave a stopped row whose timeline never says so.
	const claimed = await transitionWithEvent(
		row,
		{ status: "stopped", failureReason: reason, stoppedAt: now },
		{
			type: "sandbox_stopped",
			actor: options.actor ?? "harbor",
			payload: { sandbox_id: row.id, external_id: row.externalId, reason },
		},
	);
	if (!claimed) {
		const [current] = await db
			.select({ status: sandboxes.status })
			.from(sandboxes)
			.where(eq(sandboxes.id, sandboxId))
			.limit(1);
		return { kind: "already_terminal", status: current?.status ?? "stopped" };
	}

	const provider = options.provider ?? defaultProvider();
	let outcome: StopOutcome = "absent";
	if (row.externalId !== null) {
		try {
			outcome = await provider.stop(row.externalId, { graceMs: options.graceMs });
		} catch (error) {
			const errorType: ProviderErrorType =
				error instanceof SandboxProviderError ? error.errorType : classifyProviderError(error);
			// A second event, not a replacement: the decision above is already on
			// the record, and this one says the container may still be running.
			await appendEvent({
				orgId: row.orgId,
				sessionId: row.sessionId,
				type: "sandbox_stopped",
				actor: options.actor ?? "harbor",
				payload: {
					sandbox_id: row.id,
					external_id: row.externalId,
					reason,
					confirmed: false,
					error_type: errorType,
				},
			});
			return { kind: "unconfirmed", errorType, message: (error as Error).message };
		}
	}

	return { kind: "stopped", outcome };
}

/**
 * Capture filesystem state — and note the parameter type.
 *
 * The provider is a `SnapshotProvider`, not a `SandboxProvider`. Passing the
 * configured provider without narrowing it through `isSnapshotProvider` is a
 * **compile error**, and that is the entire point: the alternative shape, an
 * optional method plus a `capabilities.supportsSnapshots` boolean, makes
 * `provider.snapshot?.(id)` on a backend that cannot snapshot evaluate to
 * `undefined` — silently, with no exception — and the resume path then continues as
 * though state had been captured. The session appears to resume onto an empty
 * workspace and the agent looks like it forgot an hour of work.
 */
export async function snapshotSandbox(
	provider: SnapshotProvider,
	sandboxId: string,
	options: { now?: Date; actor?: string | null } = {},
): Promise<
	| { kind: "captured"; ref: SnapshotRef }
	| { kind: "unknown_sandbox" }
	| { kind: "no_external_id" }
	| { kind: "failed"; errorType: ProviderErrorType; message: string }
> {
	const [row] = await db.select().from(sandboxes).where(eq(sandboxes.id, sandboxId)).limit(1);
	if (!row) return { kind: "unknown_sandbox" };
	if (row.externalId === null) return { kind: "no_external_id" };

	// Snapshotting is a privileged side effect, so it is fenced like the others. A
	// superseded box taking a snapshot would overwrite the state the *current* box
	// will restore from, which is data loss with no error attached to it.
	//
	// AUTHORITY FAILS CLOSED here too, which is why `state_unknown` refuses
	// alongside `superseded` rather than falling through. Testing only for
	// `superseded` reads as "refuse once we have proved it is stale" and therefore
	// permits the snapshot in the one case where nothing was proved: the fence query
	// failed while a newer box did in fact exist. `resolveBoot` restores from the
	// newest row *carrying* a `snapshotRef`, so a stale box that writes one beats a
	// current box that has not taken one yet, and the next boot silently restores
	// hours-old state with no error anywhere. `lifecycle_closed` still proceeds on
	// purpose — capturing state on the way down is what this is for, and
	// `stopSandbox` persists the dead status before it asks the provider to stop.
	const fence = await validateFence(row.id, await fencingTokenOf(row));
	if (!fence.valid && (fence.reason === "superseded" || fence.reason === "state_unknown")) {
		return {
			kind: "failed",
			errorType: "invalid_config",
			message:
				fence.reason === "superseded"
					? "sandbox is superseded"
					: `the sandbox's fencing position could not be determined: ${fence.detail}`,
		};
	}

	try {
		const ref = await provider.snapshot(row.externalId);
		// The ref, its `sandbox_snapshotted` event AND its cost row commit
		// together. A snapshot used to be invisible twice over: nothing on the
		// timeline said state was captured, and nothing in cost_events said the
		// provider did storage work — a spend path with no accounting. The row is
		// zero-priced for the same reason the spawn estimate defaults to zero
		// (Harbor cannot know what a snapshot costs on this backend), but it
		// EXISTS, keyed on the handle so a retried capture is absorbed, which is
		// what lets an operator attribute provider bills to sessions after the
		// fact.
		await db.transaction(async (tx) => {
			await tx
				.update(sandboxes)
				// Stored as JSON rather than as a bare handle: a restore needs the
				// originating provider too, and a handle alone is silently restorable on the
				// wrong backend.
				.set({ snapshotRef: JSON.stringify(ref) })
				.where(eq(sandboxes.id, row.id));
			await appendEvent(
				{
					orgId: row.orgId,
					sessionId: row.sessionId,
					type: "sandbox_snapshotted",
					actor: options.actor ?? "harbor",
					payload: {
						sandbox_id: row.id,
						external_id: row.externalId,
						snapshot_handle: ref.handle,
						provider: ref.provider,
					},
				},
				{ executor: tx },
			);
			await recordCost(
				{
					orgId: row.orgId,
					sessionId: row.sessionId,
					claimId: null,
					key: `snapshot:${ref.handle}`,
					kind: "provider_call",
					actor: options.actor ?? "harbor",
					provider: ref.provider,
					microUsd: 0,
					quantity: 1,
					createdAt: options.now ?? new Date(),
				},
				{ executor: tx },
			);
		});
		await notifyChange(row.orgId, "session_event");
		return { kind: "captured", ref };
	} catch (error) {
		const errorType: ProviderErrorType =
			error instanceof SandboxProviderError ? error.errorType : classifyProviderError(error);
		return { kind: "failed", errorType, message: (error as Error).message };
	}
}

/**
 * Compare-and-set on the status, which is what makes every sweep handler idempotent.
 *
 * The predicate carries the status the caller observed, so a second sweep — or a
 * second replica sweeping concurrently — updates zero rows and takes the "somebody
 * else already handled this" path instead of writing a second event and issuing a
 * second stop.
 */
async function transition(
	tx: Executor,
	row: SandboxRow,
	next: { status: SandboxStatus; failureReason: SandboxFailure | null; stoppedAt?: Date | null },
): Promise<boolean> {
	const updated = await tx
		.update(sandboxes)
		.set({
			status: next.status,
			failureReason: next.failureReason,
			stoppedAt: next.stoppedAt ?? null,
		})
		.where(and(eq(sandboxes.id, row.id), eq(sandboxes.status, row.status)))
		.returning({ id: sandboxes.id });
	return updated.length > 0;
}

/**
 * A dead-status transition and the event that records it, in one transaction.
 *
 * This is the shape every reaper and `stopSandbox` share: the CAS that claims
 * the row and the ledger entry that explains it commit together, and the NOTIFY
 * fires after the commit. A `false` return means the CAS lost — somebody else
 * moved the lifecycle on — and nothing was written, including the event.
 */
async function transitionWithEvent(
	row: SandboxRow,
	next: { status: SandboxStatus; failureReason: SandboxFailure | null; stoppedAt?: Date | null },
	event: { type: SessionEventType; actor: string | null; payload: Record<string, unknown> },
): Promise<boolean> {
	const claimed = await db.transaction(async (tx) => {
		const moved = await transition(tx, row, next);
		if (!moved) return false;
		await appendEvent(
			{
				orgId: row.orgId,
				sessionId: row.sessionId,
				type: event.type,
				actor: event.actor,
				payload: event.payload,
			},
			{ executor: tx },
		);
		return true;
	});
	if (claimed) await notifyChange(row.orgId, "session_event");
	return claimed;
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

export interface SweepOptions {
	/** Scope to one organisation. Absent means every org, which is the deployment default. */
	orgId?: string;
	provider?: SandboxProvider;
	repoOverrides?: RepoOverrides;
	/**
	 * How a reaper learns the lease state behind a task. A seam for tests — the
	 * fail-closed cases below need a claims table that cannot be read, which is
	 * not something a test can arrange against a healthy Postgres. Defaults to
	 * reading the `claims` table.
	 */
	readLease?: (taskId: string, now: Date) => Promise<LeaseState>;
}

/**
 * The authority behind a session, for a destruction decision.
 *
 * A read failure returns `unknown`, never a guess — `evaluateDestruction`
 * defers on `unknown`, which is the fail-closed direction for destruction. See
 * the long comment on `evaluateDestruction` for why this deliberately differs
 * from both the liveness rule and the spawn rule.
 */
export async function readDestructionAuthority(
	taskId: string | null,
	now: Date,
	readLease?: SweepOptions["readLease"],
): Promise<DestructionAuthority> {
	if (taskId === null) return "no_task";
	const read =
		readLease
		?? (async (id: string, at: Date): Promise<LeaseState> => {
			const [row] = await db
				.select({ expiresAt: claims.expiresAt })
				.from(claims)
				.where(and(eq(claims.taskId, id), isNull(claims.releasedAt)))
				.limit(1);
			if (!row) return "not_held";
			if (row.expiresAt.getTime() <= at.getTime()) return "not_held";
			return "held";
		});
	try {
		return await read(taskId, now);
	} catch {
		return "unknown";
	}
}

/**
 * What one handler did. Ids rather than counts, because the assertion a test wants
 * to make — "the second run acted on nothing" — is about identity, and because an
 * operator reading a log line wants to know *which* box was reaped.
 */
export interface DeadlineReport {
	examined: number;
	acted: string[];
	/** Rows another sweep or another replica had already transitioned. */
	raced: string[];
	/**
	 * Rows the handler chose NOT to conclude this pass — the provider could not
	 * be asked about a possible orphan, or the lease behind the session was
	 * unreadable. Deferral is the fail-closed direction for destruction: an
	 * unreadable answer is never treated as permission to destroy, and the row
	 * stays in a status the next sweep will revisit.
	 */
	deferred: string[];
}

const emptyReport = (): DeadlineReport => ({ examined: 0, acted: [], raced: [], deferred: [] });

export interface SweepReport {
	inactivity: DeadlineReport;
	staleHeartbeat: DeadlineReport;
	connecting: DeadlineReport;
	execution: DeadlineReport;
}

/**
 * The router, and it is deliberately this thin.
 *
 * In the implementation this replaces, the timer sweep was one ~195-line function,
 * and it was the single place where four independently clean policies re-tangled:
 * the inactivity threshold read the heartbeat's rows, the boot watchdog shared the
 * inactivity reaper's transaction, and no case could be tested without constructing
 * a world in which the other three were inert. Four functions with four reports can
 * each be run alone, run twice, and asserted on.
 *
 * Sequential rather than parallel on purpose. The handlers overlap on the same rows
 * — a box can be both idle and unheartbeating — and the compare-and-set in
 * `transition` means the first one to act wins and the rest report a race. Running
 * them concurrently produces the same outcome with the reports shuffled, which makes
 * a flaky test look like a correctness bug.
 */
export async function sweepDeadlines(now: Date, options: SweepOptions = {}): Promise<SweepReport> {
	return {
		inactivity: await onInactivity(now, options),
		staleHeartbeat: await onStaleHeartbeat(now, options),
		connecting: await onConnectingTimeout(now, options),
		execution: await onExecutionTimeout(now, options),
	};
}

/**
 * Candidate rows for the liveness handlers: everything not on the dead deny-list.
 *
 * A deny-list, not an allow-list of live statuses, for the reason stated in
 * `DEAD_SANDBOX_STATUSES`: a status added next year would otherwise be excluded
 * from every watchdog, and the box sitting in it would run forever with nothing
 * looking at it. Included-and-not-applicable is a wasted row; excluded-and-alive is
 * an unbounded bill.
 */
async function liveCandidates(options: SweepOptions) {
	const conditions = [notInArray(sandboxes.status, [...DEAD_SANDBOX_STATUSES])];
	if (options.orgId !== undefined) conditions.push(eq(sandboxes.orgId, options.orgId));
	return db
		.select({
			sandbox: sandboxes,
			lastActivityAt: sessions.lastActivityAt,
			taskId: sessions.taskId,
		})
		.from(sandboxes)
		.innerJoin(sessions, eq(sandboxes.sessionId, sessions.id))
		.where(and(...conditions))
		.orderBy(sandboxes.createdAt);
}

/**
 * Reap boxes nobody is using.
 *
 * The idle clock is `sessions.lastActivityAt` — prompts, agent events, participants
 * arriving — and explicitly not the heartbeat, which measures whether the box is
 * running rather than whether anyone wants it. See `heartbeat`.
 *
 * The dead status is persisted BEFORE the provider is asked to stop anything, so a
 * box that reconnects during the stop is refused by `heartbeat` rather than admitted
 * onto a session that has moved on.
 */
export async function onInactivity(now: Date, options: SweepOptions = {}): Promise<DeadlineReport> {
	const report = emptyReport();
	const provider = options.provider ?? defaultProvider();

	for (const candidate of await liveCandidates(options)) {
		const row = candidate.sandbox;
		report.examined += 1;
		const verdict = evaluateInactivityTimeout(
			{ status: row.status, lastActivityAt: candidate.lastActivityAt, createdAt: row.createdAt },
			now,
			options.repoOverrides,
		);
		if (verdict.verdict !== "expired") continue;

		// THE LEASE GATE, before the CAS — deferring after persisting a dead
		// status would park the box behind a status no sweep revisits. An idle
		// clock says nobody is *using* the box; the lease says whether anybody is
		// *authorised* to be mid-flight on its task, and destruction defers to
		// authority it cannot read. Leaseless dashboard sessions are `no_task`
		// and reap exactly as before.
		const authority = await readDestructionAuthority(candidate.taskId, now, options.readLease);
		const decision = evaluateDestruction(authority);
		if (decision.verdict === "defer") {
			report.deferred.push(row.id);
			continue;
		}

		// Status and event commit together; the provider stop follows the commit,
		// preserving the persist-before-close rule from the file header.
		const claimed = await transitionWithEvent(
			row,
			{ status: "stopped", failureReason: "inactivity_timeout", stoppedAt: now },
			{
				type: "sandbox_stopped",
				actor: "harbor",
				payload: {
					sandbox_id: row.id,
					reason: "inactivity_timeout",
					idle_ms: verdict.idleMs,
					threshold_ms: verdict.thresholdMs,
				},
			},
		);
		if (!claimed) {
			report.raced.push(row.id);
			continue;
		}
		report.acted.push(row.id);
		await bestEffortStop(provider, row);
	}
	return report;
}

/**
 * Reap boxes that stopped talking.
 *
 * `stale`, not `stopped`, and the difference is not cosmetic: `stopped` is a box we
 * shut down deliberately, `stale` is one that vanished. Both are dead and both block
 * reconnection; only one of them means "look at the provider, something ate a
 * container".
 *
 * A box that has not reached ready yet is not this handler's problem — the evaluator
 * returns `unknown` for it, because it is not supposed to be heartbeating during a
 * four-minute `npm ci`. That box belongs to `onConnectingTimeout`, and two watchdogs
 * with disjoint jurisdictions is what stops a slow boot being killed by the wrong
 * one for the wrong reason.
 */
export async function onStaleHeartbeat(
	now: Date,
	options: SweepOptions = {},
): Promise<DeadlineReport> {
	const report = emptyReport();
	const provider = options.provider ?? defaultProvider();

	for (const candidate of await liveCandidates(options)) {
		const row = candidate.sandbox;
		report.examined += 1;
		const verdict = evaluateHeartbeatHealth(
			{ status: row.status, lastHeartbeatAt: row.lastHeartbeatAt, readyAt: row.readyAt },
			now,
			options.repoOverrides,
		);
		if (verdict.verdict !== "stale") continue;

		// The lease gate, same as `onInactivity`: a vanished heartbeat plus an
		// unreadable lease is two unknowns, and destruction waits one sweep
		// rather than compounding them.
		const authority = await readDestructionAuthority(candidate.taskId, now, options.readLease);
		const decision = evaluateDestruction(authority);
		if (decision.verdict === "defer") {
			report.deferred.push(row.id);
			continue;
		}

		const claimed = await transitionWithEvent(
			row,
			{ status: "stale", failureReason: "heartbeat_lost", stoppedAt: now },
			{
				type: "sandbox_failed",
				actor: "harbor",
				payload: {
					sandbox_id: row.id,
					reason: "heartbeat_lost",
					age_ms: verdict.ageMs,
					threshold_ms: verdict.thresholdMs,
				},
			},
		);
		if (!claimed) {
			report.raced.push(row.id);
			continue;
		}
		report.acted.push(row.id);
		await bestEffortStop(provider, row);
	}
	return report;
}

/**
 * Reap boots that never said hello — and reconcile the orphans they may have left.
 *
 * This is the handler that closes the ambiguous-failure loop for a caller that never
 * came back. A row still in `requested` with no external id is an attempt whose
 * provider call failed or whose worker died, and the container it may have created
 * is discoverable only through its attempt id. Marking the row failed without asking
 * is what strands a running box with nothing pointing at it, which is the accepted-
 * but-mitigated cost written down in docs/adr/0002.
 *
 * The status written is `failed`, which stays reconnectable on purpose: a slow boot
 * can outrun this watchdog and then come up working, and refusing it would make the
 * user pay for a second cold start while the first box keeps billing.
 */
export async function onConnectingTimeout(
	now: Date,
	options: SweepOptions = {},
): Promise<DeadlineReport> {
	const report = emptyReport();
	const provider = options.provider ?? defaultProvider();

	for (const candidate of await liveCandidates(options)) {
		const row = candidate.sandbox;
		report.examined += 1;
		const verdict = evaluateConnectingTimeout(
			{ status: row.status, createdAt: row.createdAt, readyAt: row.readyAt },
			now,
			options.repoOverrides,
		);
		if (verdict.verdict !== "timed_out") continue;

		// The lease gate first — it is a local read, cheaper than the provider
		// round trip below, and a deferred row must not be reconciled either: the
		// lease holder's own retry path owns reconciliation while the lease lives.
		const authority = await readDestructionAuthority(candidate.taskId, now, options.readLease);
		const decision = evaluateDestruction(authority);
		if (decision.verdict === "defer") {
			report.deferred.push(row.id);
			continue;
		}

		// RECONCILE BEFORE CONCLUDING, and the order is load-bearing. `failed` is
		// on the dead deny-list: once a row is written there, no sweep ever looks
		// at it again. The old shape transitioned first and asked the provider
		// second, swallowing the provider's error — so one transient backend
		// failure at exactly this moment stranded a running container behind a row
		// nothing would revisit, forever. Asking first means an unanswerable
		// provider DEFERS the row: it stays `requested`, `classifyPendingAttempt`
		// still reads it as resumable, and both a retrying caller and the next
		// sweep get another chance at it.
		let orphan: string | null = null;
		if (row.externalId === null) {
			try {
				const found = await provider.findByAttemptId(row.id);
				if (found !== null && isLive(found.state)) orphan = found.externalId;
			} catch {
				report.deferred.push(row.id);
				continue;
			}
		}

		// The CAS is what serialises this handler against a concurrent adoption:
		// `ensureSandbox` may be reconciling the same attempt right now, and its
		// `claimAttempt` moves the row off `requested`. Whoever writes first wins;
		// the loser here reports a race and — critically — does NOT stop the box,
		// because the box may now be somebody's adopted sandbox.
		const claimed = await transitionWithEvent(
			row,
			{ status: "failed", failureReason: "boot_timeout", stoppedAt: now },
			{
				type: "sandbox_failed",
				actor: "harbor",
				payload: {
					sandbox_id: row.id,
					attempt_id: row.id,
					reason: "boot_timeout",
					elapsed_ms: verdict.elapsedMs,
					threshold_ms: verdict.thresholdMs,
					reconciled_orphan: orphan,
				},
			},
		);
		if (!claimed) {
			report.raced.push(row.id);
			continue;
		}
		report.acted.push(row.id);

		if (orphan !== null) {
			// Best-effort: the row is concluded and carries the orphan's id in its
			// event, so a failed stop here leaves a container the provider-orphan
			// sweep can still find by its attempt label.
			try {
				await provider.stop(orphan);
				await recordOrphanReconciled(row.orgId, row.id, orphan, "stopped");
			} catch (error) {
				console.error(`[sandbox] orphan stop failed for ${orphan}:`, (error as Error).message);
			}
		} else if (row.externalId !== null) {
			await bestEffortStop(provider, row);
		}
	}
	return report;
}

/**
 * End turns that ran past their limit.
 *
 * A turn, not a box. The prompt is marked finished and the sandbox is left alone,
 * because a long turn is not evidence of a broken container — the box may have three
 * more prompts queued behind this one, and killing it would throw away work nobody
 * asked to lose. If it really is idle afterwards, `onInactivity` owns that decision
 * and applies its own threshold.
 *
 * `agentTurnTimeoutMs` is validated at startup against the lease duration, so a turn
 * cannot legitimately outlive the lease that authorises it. When one does anyway,
 * the fence is what stops it writing; this only stops it waiting.
 *
 * Not behind the destruction lease gate, because it destroys nothing: it closes a
 * prompt, and the timeout it enforces is itself derived from the lease.
 */
export async function onExecutionTimeout(
	now: Date,
	options: SweepOptions = {},
): Promise<DeadlineReport> {
	const report = emptyReport();
	const conditions = [eq(sessionPrompts.status, "delivered"), isNotNull(sessionPrompts.deliveredAt)];
	if (options.orgId !== undefined) conditions.push(eq(sessionPrompts.orgId, options.orgId));

	const rows = await db
		.select()
		.from(sessionPrompts)
		.where(and(...conditions))
		.orderBy(sessionPrompts.deliveredAt);

	for (const prompt of rows) {
		report.examined += 1;
		const verdict = evaluateExecutionTimeout(prompt.deliveredAt, now, options.repoOverrides);
		if (verdict.verdict !== "timed_out") continue;

		// Compare-and-set on the status, exactly as `transition` does for sandboxes:
		// the second sweep matches nothing and reports a race rather than appending a
		// second `prompt_finished` to the timeline. The CAS and the event share one
		// transaction — a prompt must never be `timed_out` with a timeline that says
		// it is still running.
		const claimed = await db.transaction(async (tx) => {
			const updated = await tx
				.update(sessionPrompts)
				.set({ status: "timed_out" })
				.where(and(eq(sessionPrompts.id, prompt.id), eq(sessionPrompts.status, "delivered")))
				.returning({ id: sessionPrompts.id });
			if (updated.length === 0) return false;
			await appendEvent(
				{
					orgId: prompt.orgId,
					sessionId: prompt.sessionId,
					type: "prompt_finished",
					actor: "harbor",
					payload: {
						prompt_id: prompt.id,
						seq: prompt.seq,
						reason: "execution_timeout",
						elapsed_ms: verdict.elapsedMs,
						threshold_ms: verdict.thresholdMs,
					},
				},
				{ executor: tx },
			);
			return true;
		});
		if (!claimed) {
			report.raced.push(prompt.id);
			continue;
		}
		report.acted.push(prompt.id);
		await notifyChange(prompt.orgId, "session_event");
	}
	return report;
}

/**
 * Ask the provider to stop a box, and never let the answer break the sweep.
 *
 * The row is already marked dead by the time this runs, so a failure here leaks a
 * container rather than corrupting state — and a throw would abandon every remaining
 * candidate in the pass, turning one unreachable backend into a sweep that stops
 * reaping anything at all.
 */
async function bestEffortStop(provider: SandboxProvider, row: SandboxRow): Promise<void> {
	if (row.externalId === null) return;
	try {
		await provider.stop(row.externalId);
	} catch (error) {
		console.error(`[sandbox] stop failed for ${row.id}:`, (error as Error).message);
	}
}

/**
 * The org-ledger record behind `harbor_orphans_reconciled_total`.
 *
 * An orphan handled — adopted back onto its attempt, or stopped by a reaper —
 * used to exist only as a field inside a session event's payload, which no
 * metric can aggregate. The rate matters because every reconciled orphan is an
 * ambiguous failure that actually happened: a rising rate is a provider or a
 * network getting worse, visible before the bill is. Best-effort by contract.
 */
export async function recordOrphanReconciled(
	orgId: string,
	sandboxId: string,
	externalId: string,
	outcome: "adopted" | "stopped",
): Promise<void> {
	try {
		await db.insert(events).values({
			orgId,
			type: "orphan_reconciled",
			payload: { sandbox_id: sandboxId, external_id: externalId, outcome },
		});
	} catch (error) {
		console.error("[sandbox] orphan event failed:", (error as Error).message);
	}
}
