// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Every decision the sandbox lifecycle makes, and not one line of I/O.
 *
 * The manager talks to Postgres and to a provider API. This file decides. The
 * split is not tidiness — it is the only way the interesting cases are testable
 * at all. "Does the circuit open on the third failure but not the second" and
 * "is a sandbox whose heartbeat is exactly 45,000ms old stale" are one-line
 * assertions against a pure function and an afternoon of fixture surgery against
 * a function that reads a database and a clock. The bugs that reach production in
 * lifecycle code are always off-by-one on a boundary or a missing branch on a
 * status nobody thought about, and both are exactly what a pure module makes
 * cheap to cover.
 *
 * Three rules hold throughout, each enforced by a test:
 *
 *  - **No clock reads.** Every time-based evaluator takes `now: Date`. A function
 *    that calls `Date.now()` internally cannot be tested at its own boundary —
 *    the best anyone can do is sleep and hope — so the boundary goes untested and
 *    the off-by-one ships.
 *  - **No module-level thresholds.** Everything comes from `setting()`, with the
 *    repository's overrides threaded through, so a monorepo that legitimately
 *    takes four minutes to boot is a config change rather than a fork.
 *  - **Typed reasons, never bare booleans, on anything a human will later have to
 *    explain.** "Refused" is useless in a support conversation; "refused:
 *    budget_exhausted" ends it. And crucially, *denied* and *could not determine*
 *    are separate values everywhere they occur, because collapsing them forces a
 *    single global choice between failing open (a security hole) and failing
 *    closed (a total outage on any upstream blip). Kept apart, each caller picks,
 *    and the two callers here deliberately pick differently:
 *
 *        liveness fails OPEN  — an unrecognised sandbox status reads as alive
 *        authority fails CLOSED — an unrecognised lease state reads as not held
 *
 *    Both sites carry a comment on the asymmetry, because reading either one in
 *    isolation it looks like an inconsistency to be "fixed".
 */

import { type RepoOverrides, setting } from "@core/kernel/config.js";
import {
	CIRCUIT_TRIPPING_ERROR_TYPES,
	DEAD_SANDBOX_STATUSES,
	PROVIDER_ERROR_TYPES,
	SANDBOX_STATUSES,
	type BootMode,
	type ProviderErrorType,
	type SandboxCapabilities,
	type SandboxStatus,
	type SpawnRefusal,
} from "../contracts/index.js";

// ---------------------------------------------------------------------------
// Exhaustiveness
// ---------------------------------------------------------------------------

/**
 * The compile-time half of "handle every status".
 *
 * Every switch over a closed union in this file ends with a call to this and has
 * **no `default` branch**. That combination is what makes adding a member to
 * `SANDBOX_STATUSES` a compile error at each place that decides something about a
 * status, instead of a silent fall-through to whatever the `default` happened to
 * do. A `default` branch on a status enum is indistinguishable from a considered
 * decision until the day someone adds `suspended` and every sandbox in it is
 * treated as healthy forever.
 *
 * It throws rather than returning, and that is safe here only because every call
 * site guards the runtime case first — see `isKnownSandboxStatus`. A `text`
 * column can hold a string this union does not have (an older deployment reading
 * rows written by a newer one), and a decision module that throws on unfamiliar
 * data takes the sweeper down with it.
 */
export function assertNever(value: never, context: string): never {
	throw new Error(`unreachable: unhandled ${context}: ${JSON.stringify(value)}`);
}

/**
 * Is this string one of the statuses this build knows about?
 *
 * The database column is `text`. `SandboxStatus` is therefore a claim the
 * compiler makes about our own code, not a guarantee about the bytes in the row —
 * during a rolling deploy, or after a rollback, an older process reads statuses a
 * newer one wrote. Every exhaustive switch below is guarded by this so an
 * unfamiliar value takes the explicit "we do not recognise this" path rather than
 * reaching `assertNever` and throwing inside a background sweep.
 */
export function isKnownSandboxStatus(status: string): status is SandboxStatus {
	return (SANDBOX_STATUSES as readonly string[]).includes(status);
}

// ---------------------------------------------------------------------------
// Failure vocabulary
// ---------------------------------------------------------------------------

/**
 * Why a sandbox died, as a closed set — this is what `sandboxes.failure_reason`
 * holds.
 *
 * Prose in that column is a dead end. The moment somebody wants "how often do
 * boots time out on this repo", a free-text column means grepping for six
 * spellings of the same sentence and finding five of them. A closed set is a
 * `group by`, and it is also what lets the dashboard render a different
 * suggestion for `image_missing` (fix your config) than for `out_of_capacity`
 * (try again, or another region).
 */
export const SANDBOX_FAILURE_REASONS = [
	"boot_timeout",
	"setup_failed",
	"start_failed",
	"heartbeat_lost",
	"provider_error",
	"image_missing",
	"unauthorized",
	"out_of_capacity",
	"inactivity_timeout",
	"execution_timeout",
	"stopped_by_operator",
] as const;
export type SandboxFailure = (typeof SANDBOX_FAILURE_REASONS)[number];

// ---------------------------------------------------------------------------
// Liveness — the deny-list, and why it points this way
// ---------------------------------------------------------------------------

/**
 * Whether a status means the box is gone, with the reason kept distinct.
 *
 * `not_deny_listed` and `unrecognised_status` both mean "treat it as alive", and
 * they are separate members on purpose: the first is a status we understand and
 * have decided is live, the second is one we have never heard of. They lead to
 * the same action and to completely different log lines, and the second one
 * appearing in production is the signal that a deploy is half-rolled-out.
 */
export type LivenessVerdict =
	| { liveness: "dead"; reason: "deny_listed" }
	| { liveness: "live"; reason: "not_deny_listed" | "unrecognised_status" };

/**
 * A DENY-list, and the direction is the entire point.
 *
 * Written the other way — an allow-list of live statuses — a status added in six
 * months defaults to *dead*. Every sandbox sitting in it is abandoned: its
 * session stops receiving events, its work is discarded, its container keeps
 * billing, and **nothing anywhere logs an error**, because every caller believes
 * it correctly detected a dead box. That failure is invisible until a customer
 * asks why their agent stopped, and it is introduced by a one-line change in an
 * unrelated file.
 *
 * As a deny-list, the same change makes an unknown status read as *live*, and
 * callers fall through to their own liveness checks — heartbeat age, a provider
 * probe — which either confirm it is fine or reap it for a reason that is
 * actually true. Wrongly alive is recoverable and noisy; wrongly dead is silent
 * and lossy. This is the liveness side of the asymmetry: **liveness fails open.**
 * The authority side, which fails closed, is `evaluateSpawnDecision`'s handling
 * of `lease === "unknown"` — read them together.
 */
export function classifyLiveness(status: string): LivenessVerdict {
	if ((DEAD_SANDBOX_STATUSES as readonly string[]).includes(status)) {
		return { liveness: "dead", reason: "deny_listed" };
	}
	if (!isKnownSandboxStatus(status)) {
		return { liveness: "live", reason: "unrecognised_status" };
	}
	return { liveness: "live", reason: "not_deny_listed" };
}

/** The predicate form of `classifyLiveness`, for call sites that only branch. */
export function isDeadSandboxStatus(status: string): boolean {
	return classifyLiveness(status).liveness === "dead";
}

/**
 * Whether a client attaching to this session should be refused a reconnect.
 *
 * Note what is **not** here: `failed`. A sandbox marked failed is deliberately
 * still reconnectable, and it is not an oversight. The connecting watchdog marks
 * a box failed when it has not reported ready inside `sandboxBootTimeoutMs`, but
 * a slow provider, a cold image pull and a monorepo `npm ci` can genuinely
 * outrun that timeout — and when that box finally comes up, its bridge connects
 * and starts sending events for a session we have already written off. Refusing
 * it throws away a sandbox that is demonstrably alive and makes the user pay for
 * a second cold boot, while the first one keeps running and billing until its own
 * idle timeout. Accepting it is self-healing: the box that proves it works wins.
 *
 * `stopped` and `stale` are blocked because both are terminal by our own action —
 * we asked the provider to stop it, or we reaped it — so anything still talking
 * from that box is a zombie holding a stale fencing token, and admitting it is
 * how two agents end up pushing the same branch.
 *
 * An exhaustive switch rather than the string comparison it used to be, because
 * this predicate gates `validateFence`, `heartbeat` and `markSandboxReady` — the
 * entire "lifecycle is authoritative over transport" rule. As a comparison,
 * adding a terminal status to `SANDBOX_STATUSES` silently admitted zombies in
 * the new status everywhere at once; as a switch, the new member is a compile
 * error at this exact line demanding a decision. A status this build does not
 * recognise fails OPEN (reconnect allowed) — the same direction as
 * `classifyLiveness`, and for the same reason: this is a transport question,
 * not an authority one, and the fence still gates every privileged write.
 */
export function isReconnectBlockedStatus(status: string): boolean {
	if (!isKnownSandboxStatus(status)) return false;
	switch (status) {
		case "stopped":
		case "stale":
			return true;
		case "requested":
		case "spawning":
		case "ready":
		case "busy":
		case "idle":
		case "stopping":
		case "failed":
			return false;
	}
	return assertNever(status, "isReconnectBlockedStatus");
}

/**
 * Is this row an attempt nobody has concluded — the one `classifyPendingAttempt`
 * may resume?
 *
 * Same shape and same reasoning as `isReconnectBlockedStatus`: the predicate
 * used to be an inline `status === "requested"` in the manager, so a new
 * pre-attach status would silently fall out of reconciliation and its attempts
 * would wedge as "existing" forever. The exhaustive switch turns that into a
 * compile error. Unknown statuses are NOT open attempts — resuming a row whose
 * meaning this build does not know would attach a provider call to it.
 */
export function isOpenAttemptStatus(status: string): boolean {
	if (!isKnownSandboxStatus(status)) return false;
	switch (status) {
		case "requested":
			return true;
		case "spawning":
		case "ready":
		case "busy":
		case "idle":
		case "stopping":
		case "stopped":
		case "stale":
		case "failed":
			return false;
	}
	return assertNever(status, "isOpenAttemptStatus");
}

// ---------------------------------------------------------------------------
// Destruction authority
// ---------------------------------------------------------------------------

/**
 * What the reapers know about the authority behind a session when they decide
 * whether to destroy its sandbox. `no_task` is a first-class member rather than
 * a null: a leaseless dashboard session has NO lease to consult, which is a
 * different fact from a lease that answered `not_held`, even though both
 * permit destruction.
 */
export type DestructionAuthority = "no_task" | LeaseState;

export type DestructionDecision =
	| { verdict: "destroy" }
	| { verdict: "defer"; reason: "lease_unknown" | "lease_held" };

/**
 * May a reaper destroy this sandbox, given the lease behind its session?
 *
 * **DESTRUCTION FAILS CLOSED, and this is the direction a tidy-minded reader
 * will want to "fix". Do not.** The three authority rules look inconsistent and
 * are not:
 *
 *  - an unknown sandbox status is LIVE (liveness fails open — wrongly alive
 *    wastes a probe);
 *  - an unknown lease refuses a SPAWN (granting fails closed — wrongly granting
 *    puts two agents on one branch);
 *  - an unknown lease DEFERS a destruction (destroying fails closed — wrongly
 *    destroying kills a box whose lease holder is mid-flight, and unlike the
 *    other two there is no retry that undoes it).
 *
 * `unknown` defers: an unreadable claims table is not evidence of abandonment,
 * and the sweep runs again in seconds — the cost of deferring is one interval
 * of idle billing, the cost of guessing is a working agent's sandbox killed
 * under it. `held` defers too: somebody authorised is mid-flight, and
 * `validateConfig` guarantees the inactivity timeout exceeds a turn, so a held
 * lease plus an expired idle clock resolves within one lease window either
 * way. `not_held` and `no_task` destroy — the first is a lapsed or released
 * authority, the second never had one and is governed by its idle clock alone.
 */
export function evaluateDestruction(authority: DestructionAuthority): DestructionDecision {
	switch (authority) {
		case "unknown":
			return { verdict: "defer", reason: "lease_unknown" };
		case "held":
			return { verdict: "defer", reason: "lease_held" };
		case "not_held":
		case "no_task":
			return { verdict: "destroy" };
	}
	return assertNever(authority, "evaluateDestruction");
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

/**
 * The persisted breaker, one row per provider per org. Field names match
 * `circuit_breakers` exactly so the manager passes the row straight in and there
 * is no rename to get wrong.
 *
 * `lastErrorType` is `string | null` rather than `ProviderErrorType | null`
 * because the column is `text`. Forcing a cast at the call site would be the
 * manager asserting something about data it did not write, which is precisely the
 * assertion that stops being true after a rollback.
 */
export interface CircuitBreakerState {
	consecutiveFailures: number;
	firstFailureAt: Date | null;
	lastFailureAt: Date | null;
	openedAt: Date | null;
	lastErrorType: string | null;
}

export type CircuitOpenReason = "failure_threshold";

export type CircuitDecision =
	| { state: "closed" }
	| {
			state: "open";
			reason: CircuitOpenReason;
			/** Milliseconds until a probe is allowed. Never negative, never > cooldown. */
			retryAfterMs: number;
			failures: number;
			lastErrorType: string | null;
	  }
	| { state: "half_open" };

/**
 * Whether one provider failure counts towards opening the breaker.
 *
 * A closed set of two words rather than a boolean, because this value ends up in
 * a log line next to the error, and `counts=false` next to a 500 is a mystery
 * while `ignored` next to `invalid_config` is an explanation.
 *
 * The rule is a deny-list of *known permanent* errors, not an allow-list of known
 * transient ones. An error shape we have never classified before arrives as
 * `unknown` — which counts — because a storm of errors we cannot name is exactly
 * when a breaker earns its keep. The opposite default means the first provider to
 * invent a new error format silently disables the breaker.
 */
export function classifyCircuitContribution(errorType: string): "counts" | "ignored" {
	const known = (PROVIDER_ERROR_TYPES as readonly string[]).includes(errorType);
	const tripping = (CIRCUIT_TRIPPING_ERROR_TYPES as readonly string[]).includes(errorType);
	return known && !tripping ? "ignored" : "counts";
}

/**
 * Read the breaker.
 *
 * Four things happen here and each prevents a specific, observed failure:
 *
 *  1. **A window.** Failures older than `circuitWindowMs` stop counting. Without
 *     one the counter is cumulative, so a provider that failed twice in March and
 *     once in June opens the circuit in June — for an outage that never happened.
 *     The boundary is `>=`: a streak whose last failure is *exactly* one window
 *     old has aged out.
 *  2. **A threshold.** `circuitFailureThreshold` consecutive counted failures
 *     open it. Below the threshold the circuit is closed and the next spawn is
 *     allowed, because one failure is noise and two is a coincidence often enough
 *     to matter.
 *  3. **A cooldown, then exactly one probe.** After `circuitCooldownMs` the
 *     breaker reports `half_open` and the caller may attempt a single spawn. This
 *     function does not and cannot enforce the "single" part — it has no state and
 *     no locks. The lease does: only the holder attempts a spawn, so one probe per
 *     lease per cooldown is the natural consequence of the admission path rather
 *     than something this needs to police.
 *  4. **A permanent error suppresses the open.** If the most recent recorded
 *     failure was `invalid_config` or `not_found`, the breaker stays closed no
 *     matter how high the counter climbed. Retrying a missing image across a
 *     hundred sessions helps nobody, and opening the circuit for it hides any
 *     real outage behind a configuration mistake — every session gets told
 *     "provider unavailable, retry in 60s" when the truth is "your image name has
 *     a typo", which is the difference between a five-minute fix and a day.
 *
 * `openedAt` is authoritative when present, so whoever writes the row must clear
 * it on a success. If it is absent but the counter is over the threshold — a
 * writer that bumped the count and crashed — the last failure is used as the
 * moment of opening, so a partially-written row still cools down and recovers
 * instead of pinning the circuit open until a human notices.
 */
export function evaluateCircuitBreaker(
	state: CircuitBreakerState,
	now: Date,
	overrides?: RepoOverrides,
): CircuitDecision {
	const threshold = setting("circuitFailureThreshold", overrides);
	const windowMs = setting("circuitWindowMs", overrides);
	const cooldownMs = setting("circuitCooldownMs", overrides);

	// The streak's clock. `lastFailureAt` normally, `openedAt` for a row that was
	// opened by something other than a counted failure.
	const reference = state.lastFailureAt ?? state.openedAt;
	if (reference === null) return { state: "closed" };

	// Aged out, and this is checked before `openedAt` on purpose. A breaker whose
	// last failure is older than the whole window describes a provider nobody has
	// touched in five minutes; reporting `half_open` for it would throttle a
	// recovered provider to one spawn at a time for no reason, and the throttle
	// would persist until someone happened to fail again.
	if (now.getTime() - reference.getTime() >= windowMs) return { state: "closed" };

	if (state.openedAt === null && state.consecutiveFailures < threshold) {
		return { state: "closed" };
	}

	if (state.lastErrorType !== null && classifyCircuitContribution(state.lastErrorType) === "ignored") {
		return { state: "closed" };
	}

	const openedAt = state.openedAt ?? reference;
	const elapsed = now.getTime() - openedAt.getTime();
	if (elapsed >= cooldownMs) return { state: "half_open" };

	// Clamped at both ends. A negative elapsed — the row was written by a machine
	// whose clock is ahead of ours, which happens on every fleet eventually —
	// would otherwise produce a `retryAfterMs` larger than the cooldown itself,
	// and a caller scheduling a retry from it would sit out the skew as well as
	// the cooldown.
	const retryAfterMs = Math.max(0, Math.min(cooldownMs, cooldownMs - elapsed));
	return {
		state: "open",
		reason: "failure_threshold",
		retryAfterMs,
		failures: state.consecutiveFailures,
		lastErrorType: state.lastErrorType,
	};
}

// ---------------------------------------------------------------------------
// Spawn admission
// ---------------------------------------------------------------------------

/**
 * Whether this caller holds the lease that authorises a spawn — in three states,
 * not two.
 *
 * `unknown` is what a lease read returns when the database was unreachable, the
 * query timed out, or the row was locked past our patience. It is emphatically
 * not `not_held`: one means "somebody else has it", the other means "we do not
 * know who has it". Both refuse here, so it may look like a distinction without a
 * difference — it is not, because the refusal *reasons* differ (`lease_not_held`
 * versus `lease_state_unknown`) and those two page different people. A wall of
 * `lease_state_unknown` is a database problem; a wall of `lease_not_held` is a
 * scheduler problem.
 */
export type LeaseState = "held" | "not_held" | "unknown";

/**
 * The policy engine's answer, with `undetermined` as a first-class member for the
 * same reason `LeaseState` has `unknown`.
 */
export type PolicyOutcome =
	| { outcome: "allowed" }
	| { outcome: "denied"; detail: string }
	| { outcome: "undetermined"; detail: string };

export interface SpawnDecisionInput {
	/** Already evaluated, so this stays a pure composition of pure functions. */
	circuit: CircuitDecision;
	lease: LeaseState;
	/** The newest sandbox row for this session, if there is one. */
	existingSandbox: { status: string; externalId: string | null } | null;
	/**
	 * A box the provider says exists for this attempt id, found by reconciliation
	 * after an ambiguous failure. Present means we already made one and lost the
	 * response.
	 */
	orphan?: { externalId: string } | null;
	/** Integer micro-USD. Never a float — see the note at the check itself. */
	budgetRemainingMicroUsd: number;
	/** `sessions.paused_reason`. Null means not paused. */
	sessionPausedReason: string | null;
	/** Prompts currently waiting on this session. */
	queueDepth: number;
	policy?: PolicyOutcome;
	overrides?: RepoOverrides;
}

export type SpawnDecision =
	| { decision: "spawn" }
	| { decision: "adopt"; externalId: string; reason: "reconciled_orphan" }
	| {
			decision: "refuse";
			reason: SpawnRefusal;
			/** Human-readable, for the `policy_denied` event. Never parsed. */
			detail: string;
			/** When a retry could plausibly succeed. Null when it never will. */
			retryAfterMs: number | null;
	  };

/**
 * Should we ask the provider for a box?
 *
 * **Order is part of the contract**, not an artefact of how it was written. Two
 * principles fix it:
 *
 *  - *Authority first.* Nothing else can be evaluated meaningfully by a caller
 *    that may not be entitled to act at all.
 *  - *Then the most durable reason.* A user whose organisation is out of budget
 *    and whose provider circuit happens to be open must be told about the budget.
 *    Told "circuit open, retry in 60s" they will retry in 60 seconds, be refused
 *    again for the real reason, and reasonably conclude the platform is broken.
 *    So the checks that will still be true tomorrow are reported before the ones
 *    that resolve themselves.
 *
 * The one deliberate exception to "durable first" is adoption, which runs before
 * every refusal except the authority checks. An orphan is a container that
 * *already exists and is already being billed*. Refusing to adopt it because the
 * circuit is open does not save anything — it strands a running box with no row
 * pointing at it, so nothing will ever stop it and it bills until its own idle
 * timeout, if it has one. Adopting it is how we acquire the handle needed to shut
 * it down. The one thing that must not happen is adopting a box for a caller with
 * no authority over the session, which is why the lease checks come first.
 */
export function evaluateSpawnDecision(input: SpawnDecisionInput): SpawnDecision {
	// AUTHORITY FAILS CLOSED. The mirror of `classifyLiveness`, which fails open,
	// and the asymmetry is deliberate at both sites. Getting liveness wrong in the
	// permissive direction leaves a box running that we can still find and reap.
	// Getting authority wrong in the permissive direction puts two agents on one
	// task, both pushing to the same branch, and there is no cleanup for that —
	// the damage is in someone's repository history. So an unreadable lease is
	// treated exactly as a lease held by somebody else.
	if (input.lease === "unknown") {
		return {
			decision: "refuse",
			reason: "lease_state_unknown",
			detail:
				"the lease backing this spawn could not be read, so authority to spawn cannot be "
				+ "established; refusing rather than assuming",
			retryAfterMs: null,
		};
	}
	if (input.lease === "not_held") {
		return {
			decision: "refuse",
			reason: "lease_not_held",
			detail: "another worker holds the lease for this session",
			retryAfterMs: null,
		};
	}

	// An existing live box wins over spawning a second one, including when it is
	// `stopping`: that status is transient and will resolve to `stopped` within
	// seconds, at which point a retry spawns cleanly. Spawning alongside it would
	// give the session two boxes with two working copies of the same branch.
	if (input.existingSandbox !== null && !isDeadSandboxStatus(input.existingSandbox.status)) {
		return {
			decision: "refuse",
			reason: "already_active",
			detail: `session already has a sandbox in status ${input.existingSandbox.status}`,
			retryAfterMs: null,
		};
	}

	if (input.orphan) {
		return {
			decision: "adopt",
			externalId: input.orphan.externalId,
			reason: "reconciled_orphan",
		};
	}

	if (input.sessionPausedReason !== null) {
		// A session paused *because* the budget ran out is reported as
		// `budget_exhausted`, not `session_paused`. Both are true; only one tells
		// the user what to change.
		const budgetPause = input.sessionPausedReason === "budget_exhausted";
		return {
			decision: "refuse",
			reason: budgetPause ? "budget_exhausted" : "session_paused",
			detail: `session is paused: ${input.sessionPausedReason}`,
			retryAfterMs: null,
		};
	}

	const policy = input.policy ?? { outcome: "allowed" as const };
	if (policy.outcome === "denied") {
		return {
			decision: "refuse",
			reason: "policy_denied",
			detail: policy.detail,
			retryAfterMs: null,
		};
	}
	if (policy.outcome === "undetermined") {
		// Authority again, so closed again. Note the seam: `SpawnRefusal` has no
		// member for "policy could not be evaluated", so the distinction survives
		// only in `detail`. That is a known wart — see the note in the module report
		// — and the important half is that the *behaviour* is right even though the
		// wire vocabulary is coarse.
		return {
			decision: "refuse",
			reason: "policy_denied",
			detail: `policy could not be evaluated: ${policy.detail}`,
			retryAfterMs: null,
		};
	}

	// Money is integer micro-USD everywhere in Harbor. A float here would make
	// `remaining > 0` true for 0.0000004 dollars and, worse, would make sums of
	// per-token costs drift — which is how a spend cap silently becomes an
	// approximate spend cap. A non-integer arriving here means an upstream bug, and
	// the safe direction to fail on a spend limit is closed.
	if (!Number.isInteger(input.budgetRemainingMicroUsd)) {
		return {
			decision: "refuse",
			reason: "budget_exhausted",
			detail:
				`budget remaining is not an integer micro-USD value `
				+ `(${input.budgetRemainingMicroUsd}); refusing rather than guessing`,
			retryAfterMs: null,
		};
	}
	if (input.budgetRemainingMicroUsd <= 0) {
		return {
			decision: "refuse",
			reason: "budget_exhausted",
			detail: "the organisation's spend cap for the period is used up",
			retryAfterMs: null,
		};
	}

	if (input.circuit.state === "open") {
		return {
			decision: "refuse",
			reason: "circuit_open",
			detail: `provider circuit is open after ${input.circuit.failures} failures`,
			retryAfterMs: input.circuit.retryAfterMs,
		};
	}

	// `half_open` falls through to a spawn: that attempt *is* the probe.
	const cap = setting("maxQueueDepth", input.overrides);
	if (input.queueDepth >= cap) {
		return {
			decision: "refuse",
			reason: "queue_full",
			detail: `${input.queueDepth} prompts already queued, cap is ${cap}`,
			retryAfterMs: null,
		};
	}

	return { decision: "spawn" };
}

// ---------------------------------------------------------------------------
// Timeouts and health
// ---------------------------------------------------------------------------

/**
 * Whether a status is one where the watchdogs should be looking at this box at
 * all.
 *
 * Exhaustive, with no `default`. Adding a status to `SANDBOX_STATUSES` breaks the
 * build here, and that is the intended cost: every new status forces an explicit
 * answer to "does the reaper own boxes in this state", instead of inheriting one
 * by accident.
 */
type WatchdogPhase = "pre_ready" | "live" | "terminal" | "unrecognised";

function watchdogPhase(status: string): WatchdogPhase {
	// The runtime guard has to come first — see `isKnownSandboxStatus`. Without
	// it, a status written by a newer deployment reaches `assertNever` and throws
	// inside a sweep that is iterating hundreds of rows, taking the reaping of
	// every other sandbox with it.
	if (!isKnownSandboxStatus(status)) return "unrecognised";
	switch (status) {
		case "requested":
		case "spawning":
			return "pre_ready";
		case "ready":
		case "busy":
		case "idle":
			return "live";
		case "stopping":
		case "stopped":
		case "stale":
		case "failed":
			return "terminal";
	}
	return assertNever(status, "sandbox status");
}

export type InactivityDecision =
	| { verdict: "active"; idleMs: number; thresholdMs: number }
	| { verdict: "expired"; idleMs: number; thresholdMs: number }
	| { verdict: "not_applicable"; reason: "not_live" | "unrecognised_status" };

export interface InactivitySubject {
	status: string;
	/**
	 * The last thing that counted as activity: a prompt delivered, an agent event,
	 * a participant joining. Null for a box that has never done anything.
	 */
	lastActivityAt: Date | null;
	createdAt: Date;
}

/**
 * Should this box be snapshotted and stopped for being idle?
 *
 * This is the single largest lever on cost in the product, so the failure modes
 * both matter and point in opposite directions: too eager and a human reading a
 * diff pays a cold start for typing slowly, too lazy and an abandoned session
 * bills for an hour. `sandboxInactivityTimeoutMs` is where that trade lives, and
 * `validateConfig` already guarantees it exceeds `agentTurnTimeoutMs` — so a
 * `busy` box in the middle of a legitimate thirty-minute turn cannot be reaped as
 * idle here, and needs no special case. Were those two settings ever allowed to
 * cross, the symptom would be agents dying mid-task with no explanation, which is
 * why the guard lives in config validation and not in a branch here.
 *
 * A box with no activity at all is measured from `createdAt`, not exempted. One
 * that booted and was never used is the purest form of waste, and exempting it —
 * which is what a null-check that returns "active" would do — creates a container
 * that lives forever precisely because nothing ever happened on it.
 *
 * An unrecognised status returns `not_applicable` rather than `expired`, which is
 * the fail-open direction: we do not reap what we do not understand.
 */
export function evaluateInactivityTimeout(
	sandbox: InactivitySubject,
	now: Date,
	overrides?: RepoOverrides,
): InactivityDecision {
	const phase = watchdogPhase(sandbox.status);
	if (phase === "unrecognised") return { verdict: "not_applicable", reason: "unrecognised_status" };
	if (phase !== "live") return { verdict: "not_applicable", reason: "not_live" };

	const thresholdMs = setting("sandboxInactivityTimeoutMs", overrides);
	const since = sandbox.lastActivityAt ?? sandbox.createdAt;
	const idleMs = now.getTime() - since.getTime();
	return idleMs >= thresholdMs
		? { verdict: "expired", idleMs, thresholdMs }
		: { verdict: "active", idleMs, thresholdMs };
}

export type HeartbeatDecision =
	| { verdict: "healthy"; ageMs: number; thresholdMs: number }
	| { verdict: "stale"; ageMs: number; thresholdMs: number }
	| { verdict: "unknown"; reason: "not_yet_ready" | "unrecognised_status" }
	| { verdict: "not_applicable"; reason: "terminal_status" };

export interface HeartbeatSubject {
	status: string;
	lastHeartbeatAt: Date | null;
	/** Set once, when the bridge first reported ready. */
	readyAt: Date | null;
}

/**
 * Is the bridge still talking to us?
 *
 * Measured from `lastHeartbeatAt`, falling back to `readyAt` — because a box that
 * reported ready an hour ago and has never sent a single heartbeat is exactly as
 * dead as one whose heartbeats stopped an hour ago, and a null-check that skipped
 * it would leave that box running forever. The fallback is what makes "never sent
 * one" a detectable condition rather than an exemption.
 *
 * A box that has not reached ready yet returns `unknown`, not `stale`. It is not
 * supposed to be heartbeating during a four-minute `npm ci`, and reaping it here
 * would kill a boot that is behaving exactly as configured. That box belongs to
 * `evaluateConnectingTimeout`, which measures the thing that is actually late.
 * Two watchdogs with disjoint jurisdictions and an explicit "not mine" verdict,
 * rather than one watchdog with an implicit assumption.
 */
export function evaluateHeartbeatHealth(
	sandbox: HeartbeatSubject,
	now: Date,
	overrides?: RepoOverrides,
): HeartbeatDecision {
	const phase = watchdogPhase(sandbox.status);
	if (phase === "unrecognised") return { verdict: "unknown", reason: "unrecognised_status" };
	if (phase === "pre_ready") return { verdict: "unknown", reason: "not_yet_ready" };
	if (phase === "terminal") return { verdict: "not_applicable", reason: "terminal_status" };

	const reference = sandbox.lastHeartbeatAt ?? sandbox.readyAt;
	// Live status but no ready timestamp: a row mid-transition, or one whose ready
	// write landed and whose timestamp did not. There is no honest denominator for
	// an age, and inventing one (measuring from `createdAt`, say) would reap a box
	// for a bookkeeping gap. Liveness fails open.
	if (reference === null) return { verdict: "unknown", reason: "not_yet_ready" };

	const thresholdMs = setting("sandboxStaleHeartbeatMs", overrides);
	const ageMs = now.getTime() - reference.getTime();
	return ageMs >= thresholdMs
		? { verdict: "stale", ageMs, thresholdMs }
		: { verdict: "healthy", ageMs, thresholdMs };
}

export type ConnectingDecision =
	| { verdict: "connecting"; elapsedMs: number; thresholdMs: number }
	| { verdict: "timed_out"; elapsedMs: number; thresholdMs: number }
	| { verdict: "not_applicable"; reason: "already_ready" | "terminal_status" | "unrecognised_status" };

export interface ConnectingSubject {
	status: string;
	createdAt: Date;
	readyAt: Date | null;
}

/**
 * Has this box taken too long to say hello?
 *
 * Measured from `createdAt` against `sandboxBootTimeoutMs`, which
 * `validateConfig` guarantees is at least `setupTimeoutMs + startTimeoutMs` — so
 * a repository whose hooks each run to their own documented limit cannot be
 * killed by the outer watchdog while doing exactly what it was configured to do.
 * That failure is nasty because it presents as "the repo's setup script is
 * broken" and sends whoever investigates into the wrong file entirely.
 *
 * The verdict here is `timed_out`, not `dead`. What the manager does with it —
 * mark the row failed — is deliberately reversible: see `isReconnectBlockedStatus`
 * for why a box that turns up late is still allowed to connect.
 */
export function evaluateConnectingTimeout(
	sandbox: ConnectingSubject,
	now: Date,
	overrides?: RepoOverrides,
): ConnectingDecision {
	const phase = watchdogPhase(sandbox.status);
	if (phase === "unrecognised") {
		return { verdict: "not_applicable", reason: "unrecognised_status" };
	}
	if (phase === "terminal") return { verdict: "not_applicable", reason: "terminal_status" };
	// `readyAt` is the fact; the status is a cache of it. If the bridge reported
	// ready, the boot succeeded, and a status that has not caught up yet must not
	// resurrect a timeout for a box that is already serving.
	if (phase === "live" || sandbox.readyAt !== null) {
		return { verdict: "not_applicable", reason: "already_ready" };
	}

	const thresholdMs = setting("sandboxBootTimeoutMs", overrides);
	const elapsedMs = now.getTime() - sandbox.createdAt.getTime();
	return elapsedMs >= thresholdMs
		? { verdict: "timed_out", elapsedMs, thresholdMs }
		: { verdict: "connecting", elapsedMs, thresholdMs };
}

export type ExecutionDecision =
	| { verdict: "not_running" }
	| { verdict: "running"; elapsedMs: number; remainingMs: number; thresholdMs: number }
	| { verdict: "timed_out"; elapsedMs: number; thresholdMs: number };

/**
 * Has one agent turn run past its limit?
 *
 * The bound exists because a lease authorises work for a finite time, and
 * `agentTurnTimeoutMs` is validated against that lease: a turn that outlives its
 * lease is an agent still writing to a branch that another agent has legitimately
 * been handed. The fencing token makes that harmless at the write; this makes it
 * rare in the first place.
 *
 * `remainingMs` is returned on the running verdict so a caller can schedule its
 * next check instead of polling every second, and it is clamped at zero so the
 * scheduling arithmetic cannot produce a timer in the past.
 */
export function evaluateExecutionTimeout(
	turnStartedAt: Date | null,
	now: Date,
	overrides?: RepoOverrides,
): ExecutionDecision {
	if (turnStartedAt === null) return { verdict: "not_running" };
	const thresholdMs = setting("agentTurnTimeoutMs", overrides);
	const elapsedMs = now.getTime() - turnStartedAt.getTime();
	if (elapsedMs >= thresholdMs) return { verdict: "timed_out", elapsedMs, thresholdMs };
	return {
		verdict: "running",
		elapsedMs,
		remainingMs: Math.max(0, thresholdMs - elapsedMs),
		thresholdMs,
	};
}

// ---------------------------------------------------------------------------
// Boot mode
// ---------------------------------------------------------------------------

/**
 * Why a boot mode was chosen — and, far more often the question anyone actually
 * asks, why the fast one was *not*.
 *
 * "Why is this still cold-booting" has four possible answers and no way to tell
 * them apart from the outside. Returning the reason alongside the mode turns that
 * into one field in the boot event.
 */
export type BootModeReason =
	| "snapshot_available"
	| "repo_image_fresh"
	| "snapshots_disabled"
	| "no_snapshot_ref"
	| "provider_cannot_restore";

export interface BootModeResolution {
	mode: BootMode;
	reason: BootModeReason;
}

export interface BootModeInput {
	/** Provider handle for previously captured filesystem state, if any. */
	snapshotRef: string | null;
	/**
	 * A published prebuilt repo image to boot from, or null.
	 *
	 * Already freshness-filtered AND provider-gated by the caller: this is `null`
	 * unless the pointer is within `imageMaxAgeMs` and the provider can actually boot
	 * an image. The freshness comparison reads the clock and the config through the
	 * pure `src/images/decisions.ts`, and it lives in the caller rather than here so
	 * this module's import list stays `{config, contracts}` — a boundary a test
	 * asserts mechanically.
	 */
	repoImageRef: string | null;
	capabilities: SandboxCapabilities;
	overrides?: RepoOverrides;
}

/**
 * Pick how the box comes up. This resolver selects between three of the four
 * `BOOT_MODES`; the fourth, `build`, is chosen by the image pipeline, never here.
 *
 * The order encodes a precedence. `snapshot_restore` wins first: it carries THIS
 * session's own prior filesystem, so it is strictly more specific than a generic
 * warm image, and it needs all three of the flag on, a snapshot to restore, and a
 * provider that can restore one — each a real failure if assumed. `repo_image` is
 * next: a per-repo image with dependencies already baked, so `setup.sh` is skipped;
 * it is an independent optimisation and is reachable even with snapshots off, but the
 * caller only ever passes a non-null `repoImageRef` when the published image is fresh
 * enough to boot and the provider can boot it. Everything else is `fresh`, and the
 * returned reason names which fast path did not apply — because "why did this
 * cold-boot" has several answers and the field is the only thing that distinguishes
 * them.
 *
 * Both fast paths are off by default and opt-in, because both are latency
 * optimisations with sharp edges — a snapshot can expire, an image can go stale — and
 * a new adopter's first strange bug should not be in the least observable part of the
 * system.
 */
export function resolveBootMode(input: BootModeInput): BootModeResolution {
	const snapshotsEnabled = setting("enableSnapshots", input.overrides);

	// Snapshot restore is the most specific fast path: it carries THIS session's own
	// prior work, so it beats a generic warm image when both are available and usable.
	if (snapshotsEnabled && input.snapshotRef && input.capabilities.supportsRestore) {
		return { mode: "snapshot_restore", reason: "snapshot_available" };
	}

	// A fresh published repo image beats a cold boot: its dependencies are already
	// baked, so `setup.sh` is skipped. Reachable even with snapshots off — it is an
	// independent optimisation, not a variant of restore.
	if (input.repoImageRef !== null) {
		return { mode: "repo_image", reason: "repo_image_fresh" };
	}

	// Neither fast path applied. The fresh reason names which, because "why did this
	// cold-boot" has several answers and only the reason field tells them apart.
	if (!snapshotsEnabled) return { mode: "fresh", reason: "snapshots_disabled" };
	if (!input.snapshotRef) return { mode: "fresh", reason: "no_snapshot_ref" };
	return { mode: "fresh", reason: "provider_cannot_restore" };
}

// ---------------------------------------------------------------------------
// Provider error classification
// ---------------------------------------------------------------------------

const HTTP_STATUS_KEYS = ["status", "statusCode", "code", "httpStatus"] as const;

/** Dig a numeric HTTP status out of whatever shape the provider SDK threw. */
function httpStatusOf(error: unknown): number | null {
	if (typeof error !== "object" || error === null) return null;
	const bag = error as Record<string, unknown>;
	for (const key of HTTP_STATUS_KEYS) {
		const value = bag[key];
		if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) {
			return value;
		}
	}
	const response = bag.response;
	if (typeof response === "object" && response !== null) {
		const status = (response as Record<string, unknown>).status;
		if (typeof status === "number") return status;
	}
	return null;
}

function messageOf(error: unknown): string {
	if (typeof error === "string") return error.toLowerCase();
	if (typeof error !== "object" || error === null) return "";
	const bag = error as Record<string, unknown>;
	const parts = [bag.message, bag.error, bag.code, bag.name]
		.filter((part): part is string => typeof part === "string");
	return parts.join(" ").toLowerCase();
}

/**
 * Turn whatever the provider threw into one of seven words.
 *
 * The whole reason this exists is the circuit breaker: a 503 should count towards
 * opening it and a "no such image" must not, because retrying a typo a hundred
 * times helps nobody and an open circuit would hide any concurrent real outage
 * behind a configuration mistake. Everything else — the dashboard's copy, whether
 * a retry is even offered — follows from the same seven values.
 *
 * Status codes are consulted before message text because they are the part of an
 * error contract providers actually keep. Message wording changes between minor
 * SDK versions and between locales, and a classifier that leads with a regex over
 * prose is a classifier that silently degrades to `unknown` after a dependency
 * bump, with no test failing.
 *
 * The default is `unknown`, which **counts** towards the breaker. Defaulting to a
 * non-tripping type would be the more comfortable choice and the wrong one: it
 * means the first provider to invent an error shape we do not recognise disables
 * the breaker entirely, exactly when a wall of unrecognised errors is the
 * strongest available evidence that something is badly wrong.
 */
export function classifyProviderError(error: unknown): ProviderErrorType {
	const status = httpStatusOf(error);
	if (status !== null) {
		if (status === 401 || status === 403) return "unauthorized";
		if (status === 402) return "quota_exceeded";
		if (status === 404 || status === 410) return "not_found";
		if (status === 429) return "rate_limited";
		if (status === 408 || status === 425) return "transient";
		// A 4xx that is not one of the above is us sending something the provider
		// will not accept — a bad image reference, an unknown region, a malformed
		// spec. Retrying it verbatim produces the same answer forever.
		if (status >= 400 && status < 500) return "invalid_config";
		if (status >= 500) return "transient";
	}

	const message = messageOf(error);
	if (message === "") return "unknown";

	// Node's network errno set. These arrive as `code` on the error rather than as
	// a status, and every one of them is a connection that did not happen — which
	// is the definition of transient, and the case a breaker exists for.
	if (/\b(econnrefused|econnreset|etimedout|epipe|ehostunreach|enetunreach|eai_again|enotfound|socket hang up)\b/.test(message)) {
		return "transient";
	}
	if (/rate.?limit|too many requests|throttl/.test(message)) return "rate_limited";
	if (/quota|out of capacity|insufficient (funds|credit|balance)|billing|payment required|spend/.test(message)) {
		return "quota_exceeded";
	}
	if (/unauthori[sz]ed|forbidden|invalid (api.?key|token|credential)|authentication|permission denied|access denied/.test(message)) {
		return "unauthorized";
	}
	if (/not found|no such (image|container|machine|sandbox|snapshot)|does not exist|unknown image|manifest unknown/.test(message)) {
		return "not_found";
	}
	if (/invalid|malformed|unsupported|bad request|validation|unrecogni[sz]ed (option|flag)/.test(message)) {
		return "invalid_config";
	}
	if (/timed? ?out|timeout|aborted|temporarily unavailable|service unavailable|try again|connection (reset|refused|closed)|network/.test(message)) {
		return "transient";
	}
	return "unknown";
}
