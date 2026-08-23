# ADR 0002 — The spawn saga: persisted intent, reconciliation, and a fencing token

**Status:** accepted
**Date:** 2026-08-11

## Context

A sandbox costs money from the instant it exists and it can push to a customer's
repository. Those two facts make duplication the most expensive bug this system
can have: one duplicate is an unbounded bill, and two agents on one branch is
damage in somebody's git history that no amount of cleanup undoes.

The obvious mechanism is to take a lease before calling the provider. Harbor does
that — `claim()` in `core/kernel/work.ts` is the lease primitive and the admission
path goes through it. It is not enough, and the gap is not theoretical. Claiming
a lease before contacting a provider does not survive:

1. **A crash between the lease and the provider call.** The lease is held, nothing
   was created, and the next holder cannot tell that from the case below.
2. **A create that succeeded and whose response was lost.** The box exists, is
   running, is billing, and no row in our database points at it.
3. **A retry after the box exists but before its id was persisted.** Identical to
   (2) from this side.
4. **A lease that expires while its holder is still running.** The original worker
   is alive, believes it holds the work, and has a working set of credentials.

Cases 2 and 3 are *indistinguishable from the caller's side* without asking the
provider what it actually has. Any design that does not ask has to guess, and both
guesses are wrong in an expensive direction: guess "it exists" and the session
never gets a sandbox; guess "it does not" and the organisation pays for two.

So "exactly one sandbox per unit of work" is not a promise this system can keep,
and claiming it anyway ships a guarantee that is quietly false.

## Decision

The property Harbor implements, and the one its tests assert, is:

> **At most one *active* sandbox per lease, including after ambiguous failures.**

Three mechanisms, all required, none sufficient alone.

### 1. The spawn intent is persisted before the provider is called

`openAttempt` writes a `sandboxes` row in status `requested` inside a transaction
serialised by a session-scoped advisory lock, and **the row's primary key is the
`attemptId`** passed to the provider as a label, tag or equivalent searchable
metadata. Providers must attach it before the box can do anything; that
requirement is part of `CreateSandboxConfig` and is checked by the provider
contract suite.

One identifier rather than two, because a separate attempt id is a second thing
to keep in sync and a label that can point at a row which does not exist.

The lock is advisory rather than `select … for update` on the session row.
`appendEvents` updates the session row to allocate a sequence number, so a saga
holding that row lock and then appending an event would block on a lock it holds
itself, on another connection, forever.

### 2. Reconciliation happens before any second spawn

An unfinished attempt is classified rather than assumed. A `requested` row written
seconds ago by another worker is *in flight*, and the spawn is refused with
`already_active`. The same row carrying a `failureReason`, or older than
`sandboxBootTimeoutMs`, is *resumable*: `provider.findByAttemptId(attemptId)` is
asked what exists, and a box we already made is **adopted** — `SpawnOutcome.kind`
`"adopted"`, reason `"reconciled_orphan"` — never duplicated.

`findByAttemptId` **fails closed by contract**: a provider that cannot reach its
backend throws rather than returning `null`, because `null` on a lost connection
turns one network blip into two agents pushing to one branch. This is the mirror
of the liveness rule (`isLive`, `DEAD_SANDBOX_STATUSES`), which fails *open* — and
the asymmetry is deliberate at every site. See ADR 0003.

### 3. A fencing token guards every privileged side effect

The token is a monotonically increasing integer per session: the ordinal of the
sandbox row under `(created_at, id)`. `validateFence(sandboxId, token)` is called
before writing to the transcript, pushing a branch, opening a pull request or
taking a snapshot, and it refuses a box whose token has been superseded **even
though that box is running, healthy and convinced it owns the work.**

That is what makes case 4 harmless. Nothing here tries to kill the stale box:
killing a remote container is best-effort and asynchronous, and a guarantee that
depends on a kill landing is not a guarantee. Refusing its writes is synchronous
and local.

The token is not stored in a dedicated column — the schema was fixed at this
point and this module may not alter it. It is *derived* from row ordering and
recorded in the `sandbox_requested` event payload, which is append-only and is
what a human reads during a post-mortem. To make the ordering total,
`persistIntent` forces each new row's `created_at` strictly above the newest
existing row for that session; without it, two rows written in the same
millisecond are ordered by a random uuid, and a newer attempt whose uuid sorted
low would compute a *lower* ordinal, conclude it had been superseded by the row it
replaced, and refuse every one of its own writes while the box ran and produced
nothing.

### The circuit breaker is shared, not per session

`circuit_breakers` holds one row per `(org, provider)`. A per-session breaker
means every session independently rediscovers a provider outage by burning its own
`circuitFailureThreshold` spawns and its own cooldown: fifty sessions produce a
hundred and fifty doomed attempts aimed at the dependency least able to absorb
them. Shared state means the first session pays the discovery cost and the rest
are refused instantly with an accurate reason and a real `retryAfterMs`.

Only `CIRCUIT_TRIPPING_ERROR_TYPES` count. An `invalid_config` — a typo in an
image name — must never open the circuit: retrying a typo helps nobody, and an
open circuit hides any concurrent real outage behind a configuration mistake.

## Consequences

### Positive

- The four ambiguous failures have defined, tested outcomes rather than
  undefined ones. Each is a case in `app/sandbox/manager.test.ts`, run against
  real Postgres and a fake provider that can be told to lose its response.
- An orphaned container is *discoverable*. Before the attempt label, a lost
  response produced a box nothing in the system could name.
- A stale worker's damage is bounded by a synchronous local check rather than by
  the reliability of a remote kill.
- One failing provider does not multiply across sessions.

### Negative — the accepted costs

These are real, and they are accepted knowingly rather than argued away.

- **Reconciliation costs a provider round trip on every retry.** Any retry of an
  attempt that already reached the provider begins with a `findByAttemptId` call,
  which is latency added to exactly the path a user is already waiting on — the
  one that has just failed once. The alternative is to guess, and both guesses
  are worse than a round trip. The cost is paid only on retry: a first attempt
  does not reconcile.

- **Fencing means a long-running box can be orphaned and must be reaped by the
  sweep.** A box that is fenced out keeps running until something stops it. The
  fence refuses its *writes* and does not terminate it. `onConnectingTimeout`
  reconciles attempt ids and stops what it finds, and `onInactivity` and
  `onStaleHeartbeat` reap live boxes — but all three are periodic, so between the
  moment a box is superseded and the moment a sweep reaches it, the organisation
  is paying for a container doing work nobody will accept. If the sweep is not
  running, nothing reclaims it: this is a background job the deployment must keep
  alive, and the failure mode of not doing so is a bill rather than an error.

- **"At most one active" still permits a brief window where a dying box and a new
  box coexist.** Stopping is not atomic with spawning. `stopSandbox` writes the
  dead status *before* asking the provider to stop, so the moment the row is
  marked dead a new spawn is admitted — while the old container may still be
  shutting down, flushing buffered events, or ignoring a stop that failed. During
  that window two containers exist for one session. Both are billing; only one can
  write, because the fence refuses the other. The alternative — waiting for a
  confirmed stop before admitting a spawn — makes every resume as slow as the
  slowest provider's teardown and, worse, blocks the session indefinitely when a
  stop cannot be confirmed at all.

- **Adoption can attach to a box that is already dead.** `isLive` is a deny-list,
  so an unrecognised provider state reads as live and is adopted. A box that is
  actually gone costs one boot timeout before the connecting watchdog fails the
  row. That is the cheaper direction: abandoning a box that is actually alive
  strands a running container with no row pointing at it.

- **A refused reservation and an ambiguous provider failure are accounted
  differently, and one of them over-counts.** A reservation is deliberately *not*
  released when a create fails ambiguously, because the box may exist. Reservations
  age out on their own, so an org whose provider is flapping sees its available
  budget under-report for up to one stale-reservation window.

### Neutral

- `SpawnRefusal` has no member for "policy could not be evaluated" or "spend could
  not be determined". Both refuse — correctly, since both are authority — but the
  true reason survives only in the event payload. Widening the wire vocabulary is a
  contracts change and is deliberately not made here.
- The fence would be cheaper and clearer as an integer column on `sandboxes`, read
  and compared directly instead of derived by counting rows. Deriving it costs two
  small indexed aggregates per privileged call. The column is the recommended
  follow-up; the derivation exists because this module may not change the schema.
