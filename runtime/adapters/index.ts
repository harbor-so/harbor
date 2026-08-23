// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The adapter registry, and the handful of decisions every adapter shares.
 *
 * Four things live here rather than being copied into each adapter, and each one
 * is here because a divergent copy would be a bug rather than a style problem:
 *
 *  - **The interrupt mapping.** `stop` and `cancel` mean different things (see the
 *    doc comment in `src/contracts/agent.ts`), and an adapter that quietly mapped
 *    both to SIGKILL would silently throw away a human's half-finished edit while
 *    every other adapter preserved it. One function, one meaning.
 *  - **The line reader.** Every agent's stdout arrives as bytes from a process that
 *    also writes progress spinners, colour codes and, when a container is torn
 *    down mid-write, half a line. If any adapter throws on one of those, a turn
 *    that was otherwise succeeding dies at the last tool call.
 *  - **Git identity.** Commit attribution is the trust anchor of the PR model, so
 *    the author/committer split is decided once, not four times.
 *  - **Usage accumulation.** Whether a usage record is a running total or a delta
 *    is the difference between a correct bill and a bill inflated by the number of
 *    assistant messages in the turn. It is declared per runtime, next to the
 *    adapters, so adding a runtime forces the question to be answered.
 *
 * ## A note on the import cycle, which is deliberate and safe
 *
 * The adapters import helpers from this file and this file imports the adapters.
 * That cycle is fine *only* because every value this module exports is a hoisted
 * `function` declaration, and function declarations are initialised for the whole
 * module graph before any module body runs. There is deliberately **no top-level
 * `const`** in this file — not a regex, not a lookup table — because a `const` is
 * in its temporal dead zone while an adapter module body is evaluating, and the
 * failure mode is a `ReferenceError` at import time that appears only when an
 * adapter is imported directly rather than through this index. `adapterFor` is a
 * switch rather than a record for exactly the same reason: a top-level
 * `{ "claude-code": claudeCodeAdapter, … }` would read the adapter bindings during
 * this module's evaluation, which is precisely when they are not yet initialised.
 */

import type { NormalizedActivity } from "../../app/activity/types.js";
import { setting } from "../../core/kernel/config.js";
import type {
	AgentAdapter,
	AgentCredentialSpec,
	AgentInterrupt,
	AgentRuntime,
	AgentStreamEvent,
	AgentTurnRequest,
	AgentUsage,
	GitIdentity,
} from "../../app/contracts/agent.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";
import { customAdapter } from "./custom.js";
import { opencodeAdapter } from "./opencode.js";

export { claudeCodeAdapter } from "./claude-code.js";
export { codexAdapter } from "./codex.js";
export { opencodeAdapter } from "./opencode.js";
export {
	CustomAgentConfigError,
	customAdapter,
	customAgentSpec,
	type CustomAgentSpec,
	type CustomAgentSpecResult,
	type CustomStreamFormat,
} from "./custom.js";

// ---------------------------------------------------------------------------
// Exhaustiveness
// ---------------------------------------------------------------------------

/**
 * Turn a missed union member into a compile error.
 *
 * Every switch over a Harbor-owned closed set in this directory ends **without a
 * `default` branch** and calls this on the line after, in the position TypeScript
 * has narrowed to `never`. The point is not the runtime throw — it is that adding
 * a sixth `AgentRuntime` or a seventh `ActivityKind` stops the build at every
 * place that has to decide something about it. A `default` branch is how a new
 * status silently inherits whatever the previous one did.
 */
export function assertNever(value: never, context: string): never {
	throw new Error(`Unreachable ${context}: ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------------------
// Reading a line of somebody else's stdout
// ---------------------------------------------------------------------------

/**
 * Remove terminal control sequences from a line.
 *
 * Agents detect a TTY and mostly behave, but they are not the only writer to the
 * pipe: a wrapper script, a package manager warming a cache, or the agent's own
 * spinner can wrap an otherwise perfect JSON line in colour codes, and
 * `JSON.parse("ESC[32m{…}ESC[0m")` fails. Losing a whole line to a
 * decoration looks like the agent went silent rather than like a parsing problem,
 * so the decoration is stripped before anything else looks at the line.
 *
 * `command()` also sets `NO_COLOR`, which is the actual fix; this is the belt to
 * that braces, because `NO_COLOR` is honoured by convention and not by contract.
 */
export function stripAnsi(line: string): string {
	// Built per call rather than hoisted: see the import-cycle note at the top of
	// this file. The allocation is noise next to the JSON.parse that follows.
	const osc = /\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g;
	const csi = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
	const other = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
	return line.replace(osc, "").replace(csi, "").replace(other, "").replace(/\r/g, "");
}

/**
 * A line of agent stdout as a JSON object, or null.
 *
 * Null covers every way a line can fail to be an object — empty, pure ANSI, a
 * plain log line, a write truncated by a container teardown, valid JSON that
 * happens to be a bare number — and it is deliberately one return value rather
 * than several, because every caller does the same thing with all of them:
 * nothing.
 *
 * This is the **fail-open** half of the asymmetry documented on
 * `checkCredentials`: a line we cannot classify is treated as harmless noise and
 * the turn continues. Failing closed here — refusing to proceed on anything
 * unrecognised — means one unexpected line from a newer agent version ends a turn
 * that was otherwise succeeding, and the user loses twenty minutes of real work to
 * a log format change.
 */
export function parseJsonLine(line: string): Record<string, unknown> | null {
	const cleaned = stripAnsi(line).trim();
	if (!cleaned) return null;
	// Cheap reject before the parse. On the text-mode runtimes most stdout is not
	// JSON at all, and a thrown-and-caught exception per log line is measurable
	// when a build is streaming thousands of them through the bridge.
	if (!cleaned.startsWith("{")) return null;
	try {
		const parsed: unknown = JSON.parse(cleaned);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The first string among several candidate fields, trimmed, or null. */
export function firstString(...candidates: unknown[]): string | null {
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
	}
	return null;
}

/**
 * Collapse a normalised tool payload into the one-line summary the timeline shows.
 *
 * The cap comes from `maxEventPayloadChars` rather than a number written here,
 * because the thing being capped is exactly what that setting exists to cap: a
 * tool that printed a 40MB build log must not be able to make the timeline
 * unreadable, and an operator whose repository legitimately produces long diffs
 * must be able to raise the limit without forking.
 */
export function summaryLine(payload: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(payload)) {
		if (value === undefined || value === null || value === "") continue;
		parts.push(`${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
	}
	const joined = parts.join(" ");
	const cap = setting("maxEventPayloadChars");
	if (joined.length <= cap) return joined;
	return `${joined.slice(0, cap)}… (+${joined.length - cap} chars)`;
}

/**
 * Bridge one normalised activity row into the agent stream, or drop it.
 *
 * Only `tool_call` has a home in `AgentStreamEvent`. The rest are dropped rather
 * than forced into `message`: a session-lifecycle row is not something the agent
 * said, and putting it in the transcript would show the user text that no model
 * ever wrote.
 */
function activityRowToStreamEvent(row: NormalizedActivity): AgentStreamEvent | null {
	switch (row.kind) {
		case "tool_call":
			return {
				kind: "tool_call",
				tool: row.tool ?? "unknown",
				// A normalizer may legitimately produce a tool row with no phase. `pre`
				// is the safe reading: it says the call was seen, and claims nothing
				// about a result that may never arrive.
				phase: row.phase ?? "pre",
				summary: summaryLine(row.payload ?? {}),
			};
		case "session_start":
		case "session_end":
		case "prompt":
		case "stop":
		case "subagent":
			return null;
	}
	return assertNever(row.kind, "ActivityKind in activityRowToStreamEvent");
}

/**
 * Carry the existing activity normalizers' output into the agent stream.
 *
 * Harbor already has parsers for these hosts' tool vocabulary in `src/activity/`,
 * written against captured payloads and covered by tests. Re-deriving "what did
 * this tool call touch" inside each adapter would mean two implementations of the
 * same clipping and field-picking rules, and they would drift — the summary shown
 * in the live timeline would stop matching the summary stored for the same tool
 * call in the activity feed, and the first bug report would be "the dashboard
 * disagrees with itself". So the adapters shape their stream events into the hook
 * dialect those normalizers already read, and this function carries the result
 * across.
 */
export function activityToStreamEvents(rows: NormalizedActivity[]): AgentStreamEvent[] {
	const events: AgentStreamEvent[] = [];
	for (const row of rows) {
		const event = activityRowToStreamEvent(row);
		if (event) events.push(event);
	}
	return events;
}

// ---------------------------------------------------------------------------
// Interrupts
// ---------------------------------------------------------------------------

/**
 * The one place stop and cancel become signals.
 *
 * SIGINT for `stop` because every one of these agents installs a handler for it
 * that finishes the tool call in flight, flushes its transcript and exits — the
 * work survives and the turn is recorded as stopped. SIGKILL for `cancel` because
 * the callers of cancel are a timeout and a budget breach, and both exist
 * precisely for the case where the process is wedged and will not honour a polite
 * request. A cancel that waits is not a cancel.
 *
 * The consequence, and it is intended: SIGKILL leaves the workspace exactly where
 * the agent got to, possibly mid-edit. That is why cancel records the turn as
 * cancelled rather than stopped, and why these are two verbs and not one.
 */
export function signalFor(interrupt: AgentInterrupt): NodeJS.Signals {
	switch (interrupt) {
		case "stop":
			return "SIGINT";
		case "cancel":
			return "SIGKILL";
	}
	return assertNever(interrupt, "AgentInterrupt in signalFor");
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * Git author and committer for a turn.
 *
 * The author is the human who asked; the committer is Harbor. That split is not
 * cosmetic — it is what makes "you cannot approve your own agent's work" a fact
 * about the commit rather than a policy somebody has to remember. If the bot both
 * authored and committed, every review rule keyed on authorship sees a bot and
 * waves it through; if the human did both, the human can self-approve.
 *
 * `agent-only` sets both to Harbor, which is the honest record for a scheduled
 * dependency bump that no person asked for. There is deliberately no third branch:
 * a missing identity was already refused by `attributedIdentity()` at enqueue
 * time, and re-deriving one here is exactly the guess that contract exists to
 * prevent.
 */
export function gitEnv(identity: GitIdentity): Record<string, string> {
	const botName = "Harbor";
	const botEmail = "harbor[bot]@users.noreply.github.com";

	switch (identity.mode) {
		case "agent-only":
			return {
				GIT_AUTHOR_NAME: botName,
				GIT_AUTHOR_EMAIL: botEmail,
				GIT_COMMITTER_NAME: botName,
				GIT_COMMITTER_EMAIL: botEmail,
			};
		case "attributed-user":
			return {
				GIT_AUTHOR_NAME: identity.name,
				GIT_AUTHOR_EMAIL: identity.email,
				GIT_COMMITTER_NAME: botName,
				GIT_COMMITTER_EMAIL: botEmail,
			};
	}
	return assertNever(identity, "GitIdentity in gitEnv");
}

/**
 * The environment every agent process gets, whichever agent it is.
 *
 * `GIT_TERMINAL_PROMPT=0` is the one that has actually bitten people. Without it,
 * a `git push` whose brokered credential has expired opens a username prompt; the
 * agent's stdin is a pipe nobody is writing to; the turn hangs until the
 * thirty-minute turn timeout fires. The user sees half an hour of nothing followed
 * by "timed out", with nothing pointing at the dead token. With it, git fails in
 * milliseconds and says why.
 *
 * `NO_COLOR` / `FORCE_COLOR=0` / `TERM=dumb` keep escape sequences out of the
 * JSONL stream. `stripAnsi` cleans up after them anyway, but a line that arrives
 * clean cannot be mangled by a sequence `stripAnsi` does not know about.
 *
 * Nothing secret is returned here. Model credentials are declared on the adapter
 * (`credentials`) and injected by the runtime from the secrets table, so that a
 * turn request logged in full never contains a key.
 */
export function baseEnv(request: AgentTurnRequest): Record<string, string> {
	return {
		...gitEnv(request.identity),
		GIT_TERMINAL_PROMPT: "0",
		GIT_ASKPASS: "",
		NO_COLOR: "1",
		FORCE_COLOR: "0",
		TERM: "dumb",
		CI: "1",
		HARBOR_SESSION_ID: request.session_id,
		HARBOR_PROMPT_ID: request.prompt_id,
		HARBOR_WORKSPACE: request.workspace,
	};
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/**
 * The usage record for "the agent told us nothing".
 *
 * Zeros plus `source: "unavailable"`, never an estimate from character counts.
 * The temptation is real — a rough number looks more useful than a gap — but a
 * number that disagrees with the provider invoice is worse than a gap, because a
 * gap reads as a gap while a fabricated number reads as fact and gets budgeted
 * against.
 */
export function unavailableUsage(model: string | null = null): AgentUsage {
	return { source: "unavailable", input_tokens: 0, output_tokens: 0, model };
}

/**
 * Convert a dollar amount an agent reported into integer micro-USD.
 *
 * Agents report cost as a float because JSON has one number type. Harbor stores
 * integers, so the float is rounded here, at the boundary, once — rather than
 * carried inwards where a later `0.1 + 0.2` turns a billing row into
 * `0.30000000000000004` and somebody spends an afternoon on it. Non-finite and
 * negative inputs yield `undefined` rather than a clamped zero: a cost we cannot
 * read is absent, not free.
 */
export function microUsdFromDollars(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	return Math.round(value * 1_000_000);
}

/** A token count an agent reported, ignoring anything that is not a count. */
export function tokenCount(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	return Math.round(value);
}

/**
 * Whether a `usage` stream event is a running total for the turn or an increment.
 *
 * This is the difference between a correct bill and one inflated by the number of
 * assistant messages in the turn, and it genuinely differs by agent: Claude Code
 * emits one authoritative total on its `result` line, Codex re-emits a cumulative
 * `token_count` as the turn progresses, and opencode reports tokens per assistant
 * message with no turn-level total anywhere. A supervisor that summed all three
 * would double-count two of them; one that took the last of all three would
 * under-count the third. Neither failure is visible until an invoice arrives.
 *
 * So it is declared rather than inferred, in a switch with no `default`, so that a
 * new runtime cannot be added without somebody answering the question.
 *
 * `custom` is `absolute` because that is what Harbor's documented contract for a
 * custom agent requires: a usage record is a running total for the turn. An
 * operator can be told a rule; a heuristic cannot be told anything, and guessing
 * here produces a wrong invoice instead of a visible misconfiguration.
 */
export type UsageAccumulation = "absolute" | "additive";

export function usageAccumulationFor(runtime: AgentRuntime): UsageAccumulation {
	switch (runtime) {
		case "claude-code":
			return "absolute";
		case "codex":
			return "absolute";
		case "opencode":
			return "additive";
		case "cursor":
			return "additive";
		case "custom":
			return "absolute";
	}
	return assertNever(runtime, "AgentRuntime in usageAccumulationFor");
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Finding an adapter, with a reason when there is not one.
 *
 * Not `AgentAdapter | null`. A null forces every caller to invent an error
 * message, and this can fail in ways that want different messages and different
 * operator responses: a runtime Harbor cannot drive headless is a permanent
 * refusal with a documented workaround, which is not the same as a transient
 * lookup failure and must not read like one.
 */
export type AdapterLookup =
	| { ok: true; adapter: AgentAdapter }
	| { ok: false; reason: "not_implemented"; runtime: AgentRuntime; message: string };

export function adapterFor(runtime: AgentRuntime): AdapterLookup {
	switch (runtime) {
		case "claude-code":
			return { ok: true, adapter: claudeCodeAdapter };
		case "codex":
			return { ok: true, adapter: codexAdapter };
		case "opencode":
			return { ok: true, adapter: opencodeAdapter };
		case "custom":
			return { ok: true, adapter: customAdapter };
		case "cursor":
			// Cursor has an activity normalizer (`src/activity/cursor.ts`) because its
			// hooks post to Harbor from a developer's own machine, but it has no
			// adapter: there is no supported way to drive it headless in a sandbox.
			// Refusing by name beats a generic failure, because the operator's next
			// move — pick another runtime, or declare a `custom` one — is in the
			// message rather than in a support thread.
			return {
				ok: false,
				reason: "not_implemented",
				runtime,
				message:
					"Cursor is supported for activity ingest but cannot be driven headless by Harbor. "
					+ "Use runtime 'custom' with HARBOR_CUSTOM_AGENT_BIN to point at a CLI you can run "
					+ "non-interactively, or pick claude-code, codex or opencode.",
			};
	}
	return assertNever(runtime, "AgentRuntime in adapterFor");
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * Can this adapter reach a model? Three answers, and the third is the point.
 *
 * `satisfied` and `missing` are the easy ones. `indeterminate` exists because the
 * honest answer for a subscription login is "not from here": Claude Code and Codex
 * both accept an OAuth session baked into the sandbox image or brokered at boot,
 * and from the control plane there is nothing to look at. Collapsing that into
 * `missing` refuses every subscription user at admission — an outage caused by a
 * correct configuration. Collapsing it into `satisfied` produces a boot that
 * succeeds and a first turn that fails with a provider error, which reads to the
 * user as "Harbor is broken".
 *
 * ## The asymmetry, stated at the site
 *
 * This is the **fail-CLOSED** half. Authority questions — "may this run" — resolve
 * against the caller when they cannot be resolved: a `required` variable that is
 * absent, blank, or whitespace-only is `missing`, and an environment that cannot
 * be read at all yields `missing` rather than an optimistic pass. The opposite
 * convention lives in `parseJsonLine`, which answers a **fail-OPEN** liveness
 * question — "is this stream still healthy" — where an unrecognised line is
 * treated as benign, because failing closed there ends a working turn over one
 * unexpected log line from a newer agent version. Refusing to spawn on doubt costs
 * a user one clear error message; spawning on doubt costs them a provider bill and
 * a confusing failure twenty minutes later.
 *
 * `indeterminate` is not a licence to fail open. It is a distinct outcome the
 * caller must route deliberately: Harbor admits the spawn and records the reason,
 * so that if the turn does fail on authentication, the timeline already says the
 * credential could not be verified in advance.
 */
export type CredentialCheck =
	| { status: "satisfied"; via: "environment" | "not_required" }
	| { status: "missing"; variable: string; message: string }
	| {
			status: "indeterminate";
			reason: "optional_key_absent" | "broker_not_probed";
			message: string;
	  };

export function checkCredentials(
	spec: AgentCredentialSpec,
	env: Record<string, string | undefined>,
): CredentialCheck {
	switch (spec.mode) {
		case "none":
			return { status: "satisfied", via: "not_required" };

		case "env_key": {
			const value = env[spec.variable];
			if (typeof value === "string" && value.trim() !== "") {
				return { status: "satisfied", via: "environment" };
			}
			return {
				status: "missing",
				variable: spec.variable,
				message:
					`${spec.variable} is required by this agent and is not set. Add it as an `
					+ "organisation secret so Harbor can inject it, or switch the session to a "
					+ "runtime that carries its own subscription login.",
			};
		}

		case "env_key_optional": {
			const value = env[spec.variable];
			if (typeof value === "string" && value.trim() !== "") {
				return { status: "satisfied", via: "environment" };
			}
			return {
				status: "indeterminate",
				reason: "optional_key_absent",
				message:
					`${spec.variable} is not set. That is a valid configuration — this agent also `
					+ "accepts a subscription login stored in the sandbox — so Harbor will start the "
					+ "session. If the first turn fails to authenticate, this is why.",
			};
		}

		case "subscription_oauth":
			return {
				status: "indeterminate",
				reason: "broker_not_probed",
				message:
					`This agent authenticates through the ${spec.broker} broker, which Harbor does `
					+ "not probe before spawning. A stale login surfaces on the first turn, not here.",
			};
	}
	return assertNever(spec, "AgentCredentialSpec in checkCredentials");
}
