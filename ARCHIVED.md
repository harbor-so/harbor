# Archived

**This repository is retired and read-only as of 2026-08-22.** It is kept because it contains
real work worth referencing, not because anything here is maintained.

Tagged **`v0-agent-platform`** at the final commit. A second tag, `v0-coordination`, marks an
earlier state from before this codebase's first reset.

## What this was

A background coding-agent platform. Agents ran in isolated cloud sandboxes owned and operated
by Harbor: thirteen sandbox providers, a session runner with a single-writer lease per session,
prebuilt per-repo images, five connectors, event-driven automations, a supervisor and bridge
running inside each sandbox, and a Next.js control plane over all of it. Roughly 250 source
files and 1,335 passing tests against real Postgres.

The coordination primitive underneath it — an exclusive lease over a scope, enforced by a
Postgres partial unique index — worked and was well tested. Everything else was scaffolding for
running other people's agents.

## Why it was retired

The product pivoted from *running* agents to *coordinating* them.

The pilot customer runs his own agents, on his own machine, under Conductor. He needs none of
the execution surface: no sandboxes, no image pipeline, no session runner. What he needs is
small — agents declare work before starting, the declarations accumulate in a ledger, and a few
views read that ledger.

Restructuring 250 files around a 20-file product is more work than building the 20 files, and it
leaves 230 files to maintain forever. So the coordination work continues elsewhere and this
stays as a reference.

The final two commits here are a genuine improvement and are the reason the tag is worth
keeping: the tree was split into `core/` (Apache-2.0, extractable) and `app/` (FSL), the
boundary was made mechanically enforced rather than conventional, and five CI checks were added,
each verified failing on a real violation.

## What is worth salvaging

Read these; do not fork the repo.

- **`scripts/check-boundaries.mjs`** — dependency-free import-boundary checker. Resolves static,
  bare, dynamic-literal, computed `import()`, `require()` and alias forms, and fails loudly when
  a zone walks to zero files instead of passing vacuously. Better than anything off the shelf,
  and the dynamic-import case is not academic: it is how an app-layer dependency hid inside
  `core/` from a static analysis.
- **The other CI checks** — `check-spdx`, `check-license-leak`, `check-write-path`,
  `check-migrations`. Each verified failing on a real violation, which is the only proof a check
  works.
- **`core/kernel/work.test.ts`** — the concurrency tests. Task-keyed, so they assert the wrong
  invariant for a scope-keyed product, but the shapes they exercise (N agents racing one row,
  interleaved rounds, lost updates against a concurrent claim) were hard-won and are the right
  specification to rewrite from.
- **`app/activity/` and `integrations/`** — hook ingestion for Claude Code, Codex, Cursor,
  OpenCode and Devin. Conductor has no hook format of its own; it drives Claude Code or Codex,
  and both speak the same dialect, so one normalizer covers a Conductor workspace whichever
  binary launched it.
- **The Drizzle migration tooling** — the plumbing, not the migrations.
- **`docs/adr/0001`–`0007`** — read for reasoning, carry none. They document the sandbox and
  session architecture of the retired product. ADR 0004 (branch per lease) is worth re-deciding
  from scratch, because path-glob scopes break its one-branch-one-lease assumption.

Everything else — the sandbox providers, the connectors, `app/images/`, `app/triggers/`,
`runtime/`, the session runner, chat, digests — stays here.

## Where the work continues

`harbor-so/berth` — the coordination ledger. Exclusive leases over namespaced scopes, an
append-only event log, and the views that read it.
