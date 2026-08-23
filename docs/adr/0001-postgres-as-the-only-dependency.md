# ADR 0001 — Postgres as the only required dependency

**Status:** accepted
**Date:** 2026-08-11

## Context

A background coding agent platform needs five things from its infrastructure:
single-writer execution per session, durable per-session state, live fan-out to
every open client, a scheduler for expiry and automation sweeps, and blob storage
for artifacts.

The natural architecture for that list is an actor runtime: one addressable,
single-threaded object per session, each with private storage and a socket hub,
with a separate shared database for cross-session coordination. It is a genuinely
good fit. Every one of the five things above is a first-class primitive, and the
concurrency model comes for free.

The question is not whether that architecture is sound — it is — but what
requiring it costs in adoption.

A background agent holds source-control credentials, model API keys, and a shell
on a checkout of a company's source code. The teams who most want one are the
teams for whom that sentence starts a security review, and the outcome of that
review is usually "only if we run it ourselves." A control plane built on a
specific vendor's actor runtime cannot run on a VM, in a VPC, on-premises, in an
air-gapped environment, or on a laptop. That rules out the deployment the people
asking for it actually need.

So the constraint came first, and it is the product: **Harbor must run wherever
the code already lives, and evaluating it must not require an account anywhere.**

## Decision

The control plane is a plain Node process (Next.js) and Postgres. Nothing else is
required to run the entire product, sandboxes included.

Postgres already provides all five primitives:

| Requirement | Mechanism |
|---|---|
| Single writer per session | `pg_try_advisory_lock(hashtext(session_id))` |
| Durable per-session state | tables carrying `orgId` and `sessionId` |
| Live fan-out | `LISTEN/NOTIFY` → SSE downward, POST upward |
| Exactly one holder per unit of work | a partial unique index on `(org_id, scope)` |
| Scheduling | a table with a deadline and an advisory-locked sweeper |
| Blob storage | the filesystem, or S3-compatible storage, configured |

There is no global singleton scheduler, because lease reclamation is
expiry-driven: a lapsed lease is reclaimable by any runner, which needs no
coordinator to elect.

### The three properties an actor runtime would give us

Each is worth stating explicitly, because two we get by other means and one we
genuinely do not.

**Socket hibernation, because sessions idle for hours.** Not applicable: we hold
no socket. The bridge posts upward and reads an SSE stream downward, and an idle
session has its sandbox stopped on inactivity — behaviour we want anyway, for
cost reasons. Hibernation solves a problem created by holding a socket open
through the idle period; not holding one solves it more cheaply.

**Per-session isolation, so one hot session cannot degrade another.** This is the
real one, and we do not get it. What we do instead is bound the thing that creates
the problem: per-session event ingest is batched rather than one transaction per
token, payloads are truncated at ingest, and old events are compacted rather than
accumulated indefinitely. That bounds the blast radius; it does not make it
structurally impossible. See the accepted costs below.

**Single-threaded execution, which makes the reconnect model correct with one
invariant.** The invariant an actor runtime lets you rely on is: finish all async
work, read the snapshot, then register the subscriber, *with no `await` in
between*. It is elegant, and it is fragile — it is a rule maintained by hand, and
a single well-intentioned `await` added to fetch a display name silently
reintroduces a lost-event race that no test will catch.

We do not need the invariant. Subscribing to the notify channel **first**, then
reading the snapshot, then filtering replayed events by `seq >
snapshot_through_seq` makes loss impossible by construction: an event landing
during the read arrives on the live channel, and the sequence number tells the
client whether it already had it. No ordering discipline is maintained by hand, so
no refactor can break it. This is the one place where the Postgres design is not a
substitute for the actor design but an improvement on it.

## Consequences

### Positive

- `docker compose up` runs the whole product, including sandboxes, with no vendor
  account of any kind.
- One store rather than six. No dual-write between a per-session store and a
  shared coordination index, and so no reconciliation path to get wrong.
- Real transactions, and one store to have them in. Lease admission
  (`claim` in `core/kernel/work.ts`), budget reservation (`reserveBudget` in
  `app/lib/cost.ts`) and event append are each atomic, and each is free to compose
  reads and writes across several tables inside one transaction — `reserveBudget`
  reads the day's spend and writes the reservation under one org-budget lock, which
  is what makes the cap hold under concurrency.

  Stated precisely, because an earlier version of this line overstated it: these
  three are **not** a single transaction with each other. `claim` commits when the
  lease is taken; `reserveBudget` runs later, in its own transaction, on the spawn
  path. The guarantee is that they share one store, so there is no dual-write
  between systems and no reconciliation path to get wrong — not that a lease and
  its first reservation commit or roll back together. A backend that serialises
  these per scope by another means is therefore not required to reproduce a
  cross-entity transaction that does not exist here.
- Deployable into a VPC, on-premises, or air-gapped.

### Negative — the accepted costs

- **We inherit a noisy-neighbour problem.** One session streaming hundreds of
  events per second shares a connection pool with every other. Batching, payload
  caps and compaction mitigate it; they do not make it structurally impossible.
  At a scale we have not reached, this needs partitioning, and partitioning
  Postgres is real work where the actor design's equivalent is nothing.
- **Advisory locks are weaker than single-threaded execution.** A lock held by a
  process that is paused but not dead is still held, and a lock is released if the
  connection drops mid-operation. We handle the second case with fencing tokens on
  every privileged side effect; the first is a real, accepted exposure. See
  [ADR 0006](./0006-connection-scoped-advisory-locks.md).
- **We must operate Postgres.** Connection limits, vacuum, backups, and a `LISTEN`
  connection per open stream are our problem now.
- **SSE plus POST is chattier than a duplex socket** for the rare downward
  message, and reconnection is our code rather than a platform's.
- **No free global consistency for the circuit breaker.** It is a Postgres table
  with a unique index, which is correct but is a write on a hot path.

### Neutral

- A session's control plane lives in one region. Sandboxes were never at the edge,
  so the latency that actually matters — model round-trips and container boot — is
  unchanged.
