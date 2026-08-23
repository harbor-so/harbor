# ADR 0005 — Bring your own coding agent

**Status:** accepted
**Date:** 2026-08-11

## Context

Building the platform around a single coding agent is the cheaper choice, and for
a team building only for itself it is the right one — they have already picked an
agent, and coupling to it buys deep integration with that agent's plugin system.

It is the wrong choice for a project meant to be adopted. A company evaluating a
background agent platform has already standardised on a coding agent; that
decision came with a procurement cycle, a security review and a set of habits.
Requiring them to switch makes re-running last quarter's evaluation the price of
trying our infrastructure, which means most of them do not try it.

Harbor already had most of what was needed: `app/activity/` contains stream
normalizers for Claude Code, Codex, OpenCode and Cursor, written for a different
purpose.

## Decision

`AgentAdapter` (`app/contracts/agent.ts`) is the integration point, and it is
defined before either the sandbox runtime or cost accounting, because both depend
on answers it gives. Six members:

- `credentials` — how the agent gets model access, declared rather than assumed.
  An adapter that silently expects an API key and gets none produces a boot that
  succeeds and a first turn that fails with a provider error, which reads to the
  user as "Harbor is broken". Declaring it lets the control plane refuse before
  spawning a box, with an error that names the variable.
- `command` — argv arrays, never a shell string. The prompt is attacker-influenced
  text and an argv element is the only form that cannot be reinterpreted as
  command syntax.
- `parseLine` — one line of the agent's output to zero or more normalised events,
  reusing the existing normalizers. Must return `[]` on garbage rather than
  throwing; an adapter that dies on one malformed line kills a turn that was
  otherwise succeeding.
- `interrupt` — `stop` and `cancel` map to different signals, because they are
  different operations. See below.
- `resumeTokenFrom` — every supported agent has some notion of continuing a prior
  thread; the adapter maps an opaque string onto whichever it is.
- `recovery` — `reattach`, `replay` or `abandon`, declared per adapter, so the
  supervisor does not apply one recovery strategy to agents with genuinely
  different durability.

A `custom` adapter takes an argv template and a stream format from configuration.
Without it, "bring your own agent" means "bring one of ours", and the first team
with an in-house agent has to fork.

### Stop and cancel are two words because they are two things

`stop` asks the agent to wind up: finish the tool call in flight, write what it
has, exit. Work survives. This is the button a human presses on realising they
asked for the wrong thing.

`cancel` kills the process. Nothing is written. This is what a timeout or a budget
breach uses.

They were one verb in the first draft. Collapsing them means either every timeout
waits politely for an agent that may be wedged, or every human "stop" discards a
half-finished edit.

### The adapter is authoritative for token counts

When an agent reports usage, that number is used. Harbor does not re-tokenize or
estimate from character counts. When an agent reports nothing, `source` is
`unavailable`, the cost row is written with zero and an explicit marker, and no
number is invented — a gap in the data reads as a gap, whereas a fabricated number
reads as fact and somebody makes a decision from it.

## Consequences

### Positive

- A team keeps the agent they evaluated.
- Three agents can be compared on the same prompt in the same platform, because
  the runtime travels with the session rather than with the deployment.
- Most of the work was already done by the activity normalizers.

### Negative — the accepted costs

- **The lowest common denominator constrains the feature set.** Anything one agent
  can do and another cannot either becomes optional and therefore unreliable, or
  is not exposed. A single-agent platform can use its agent's plugin system
  deeply; we cannot.
- **Four adapters is four things to keep working** against four upstream CLIs that
  change their output formats without notice. Each break presents as "Harbor
  stopped showing tool calls" and is diagnosed in a stream fixture.
- **`recovery` is per-adapter and therefore inconsistent.** A session's behaviour
  after a sandbox restart depends on which agent it is running, which is a
  surprising thing to have to explain to a user.
- **`custom` is an escape hatch we cannot test against reality.** It will produce
  bug reports we cannot reproduce.
