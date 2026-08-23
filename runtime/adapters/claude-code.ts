// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Claude Code, driven headless.
 *
 * `claude -p <prompt> --output-format stream-json --verbose` is the documented
 * non-interactive invocation, and `--verbose` is not optional decoration: without
 * it the stream-json output collapses to a single terminal `result` object, so the
 * live timeline shows nothing for the entire turn and then everything at once. A
 * user watching a twenty-minute turn with no output cannot tell it apart from a
 * hung sandbox, and will kill it.
 *
 * The stream itself is JSONL, one object per line, with four shapes that matter:
 * `system` (init, carrying the session id), `assistant` (content blocks: text and
 * `tool_use`), `user` (tool results), and a terminal `result` carrying the turn's
 * authoritative token counts and cost.
 */

import { normalizeClaudeStyle } from "../../app/activity/claude-style.js";
import type {
	AgentAdapter,
	AgentInterrupt,
	AgentStreamEvent,
	AgentTurnRequest,
	AgentUsage,
} from "../../app/contracts/agent.js";
import {
	activityToStreamEvents,
	baseEnv,
	firstString,
	isRecord,
	microUsdFromDollars,
	parseJsonLine,
	signalFor,
	tokenCount,
	unavailableUsage,
} from "./index.js";

/**
 * Content blocks inside an `assistant` message.
 *
 * `thinking` blocks are deliberately dropped rather than emitted as messages.
 * Extended thinking is the model's scratch space; showing it in the transcript
 * puts text in front of a reviewer that the model did not commit to and often
 * contradicts what it finally said, and the reviewer then has to work out which
 * one is the answer.
 */
function assistantEvents(record: Record<string, unknown>): AgentStreamEvent[] {
	const message = isRecord(record.message) ? record.message : null;
	if (!message || !Array.isArray(message.content)) return [];

	const sessionId = firstString(record.session_id) ?? undefined;
	const events: AgentStreamEvent[] = [];

	for (const block of message.content) {
		if (!isRecord(block)) continue;
		const type = typeof block.type === "string" ? block.type : "";

		if (type === "text") {
			const text = typeof block.text === "string" ? block.text : "";
			if (text.trim() !== "") events.push({ kind: "message", text });
			continue;
		}

		if (type === "tool_use") {
			// Reshaped into the PascalCase hook dialect and handed to the normalizer
			// Harbor already ships, rather than picking `command` / `file_path` out of
			// `block.input` here. Two implementations of that field-picking would
			// drift, and the visible symptom is the live timeline disagreeing with the
			// activity feed about the same tool call.
			events.push(
				...activityToStreamEvents(
					normalizeClaudeStyle({
						hook_event_name: "PreToolUse",
						tool_name: block.name,
						tool_input: block.input,
						session_id: sessionId,
					}),
				),
			);
		}
	}

	return events;
}

/**
 * Usage from the terminal `result` line.
 *
 * This is the **only** place a usage event is emitted for this runtime, and that
 * is a billing decision rather than a laziness one. Every `assistant` line also
 * carries a `usage` block, but those are per-message subtotals of the same turn:
 * emitting them as well and letting the supervisor add them up bills a five-message
 * turn five times over. `usageAccumulationFor("claude-code")` therefore says
 * `absolute`, and this line is the absolute number it refers to.
 *
 * `total_cost_usd` is the agent's own cost figure and takes precedence over
 * Harbor's model price table, because it already accounts for cache pricing,
 * per-account discounts and whatever the provider actually charged.
 */
function usageFrom(record: Record<string, unknown>): AgentUsage {
	const raw = isRecord(record.usage) ? record.usage : null;

	// `modelUsage` is keyed by model id; on a single-model turn there is exactly
	// one key and it is the most reliable statement of what was actually billed.
	const modelUsage = isRecord(record.modelUsage) ? record.modelUsage : null;
	const model =
		firstString(record.model, modelUsage ? Object.keys(modelUsage)[0] : undefined) ?? null;

	if (!raw) {
		// A `result` line with no usage block is rare but real — an early abort, or a
		// future version that moves the field. Zeros with `unavailable` make that a
		// visible hole in the cost record instead of a silent one.
		return unavailableUsage(model);
	}

	const usage: AgentUsage = {
		source: "agent_reported",
		input_tokens: tokenCount(raw.input_tokens) ?? 0,
		output_tokens: tokenCount(raw.output_tokens) ?? 0,
		model,
	};

	const cacheRead = tokenCount(raw.cache_read_input_tokens);
	if (cacheRead !== undefined) usage.cache_read_tokens = cacheRead;
	const cacheWrite = tokenCount(raw.cache_creation_input_tokens);
	if (cacheWrite !== undefined) usage.cache_write_tokens = cacheWrite;

	const microUsd = microUsdFromDollars(record.total_cost_usd);
	if (microUsd !== undefined) usage.micro_usd = microUsd;

	return usage;
}

function resultEvents(record: Record<string, unknown>): AgentStreamEvent[] {
	const events: AgentStreamEvent[] = [];

	// The deny-list, not an allow-list: a result is treated as fine unless it says
	// otherwise. `subtype` grows over time (`error_max_turns`,
	// `error_during_execution`, …) and an allow-list of known-good subtypes would
	// turn every new one into a spurious failure on the day the agent updates.
	if (record.is_error === true || (typeof record.subtype === "string" && record.subtype.startsWith("error"))) {
		const message =
			firstString(record.error, record.result, record.subtype) ?? "Claude Code reported an error.";
		events.push({ kind: "warning", message });
	}

	events.push({ kind: "usage", usage: usageFrom(record) });
	return events;
}

export const claudeCodeAdapter: AgentAdapter = {
	runtime: "claude-code",

	/**
	 * `env_key_optional`, not `env_key`, and the difference is the whole reason the
	 * credential spec is a union.
	 *
	 * Claude Code authenticates two ways: an `ANTHROPIC_API_KEY`, or a Claude
	 * subscription login stored in the sandbox. Under a subscription the key is
	 * genuinely absent and that is the correct configuration — declaring it
	 * `required` would make Harbor refuse a working setup at admission, which is an
	 * outage caused by our own preflight. Declaring `none` is the opposite mistake:
	 * an API-key deployment that forgot the secret would boot fine and fail on the
	 * first turn with a provider error the user reads as "Harbor is broken".
	 *
	 * `env_key_optional` gets both: the key is used when present, and its absence
	 * produces an `indeterminate` credential check that is recorded and surfaced
	 * rather than either refused or ignored.
	 */
	credentials: { mode: "env_key_optional", variable: "ANTHROPIC_API_KEY", required: false },

	/** Replayed, not reattached — see the note on `recovery` below. */
	recovery: "replay",

	command(request: AgentTurnRequest) {
		const args = ["-p", "--output-format", "stream-json", "--verbose"];

		if (request.resume_token) {
			args.push("--resume", request.resume_token);
		}
		if (request.model) {
			args.push("--model", request.model);
		}
		if (request.mcp_servers && Object.keys(request.mcp_servers).length > 0) {
			// One argv element containing a JSON document. Claude Code also accepts a
			// file path here, but writing a file means a temp file with brokered MCP
			// headers in it surviving on the sandbox disk after the turn ends.
			args.push("--mcp-config", JSON.stringify({ mcpServers: request.mcp_servers }));
			// Without this, the sandbox image's own `.mcp.json` is merged in and the
			// agent can reach servers the control plane never authorised for this
			// session. The whole point of resolving MCP servers upstream is that the
			// resolved set is the complete set.
			args.push("--strict-mcp-config");
		}

		// Only defensible because of where this runs. In a disposable sandbox with no
		// host filesystem, no ambient cloud credentials and git access brokered
		// per-call, the permission prompt protects nothing and its only effect is that
		// every file edit is auto-denied and the turn produces a polite refusal
		// instead of a diff. The same flag on a laptop would be reckless, which is why
		// it is here in the adapter and not in a shared default.
		args.push("--permission-mode", "bypassPermissions");

		// `--` then the prompt, last, as a single element.
		//
		// The separator is the load-bearing part. The prompt is attacker-influenced
		// text — it can come from a GitHub comment — and without `--` a prompt
		// beginning with a hyphen is parsed as a flag. `--dangerously-skip-permissions`
		// typed into an issue comment would otherwise become an argument to the
		// process rather than a request to the model. The cost if a future version
		// stops honouring `--` is a stray "--" in the prompt text, which is cosmetic;
		// the cost of omitting it is argument injection.
		args.push("--", request.body);

		return { bin: "claude", args, env: baseEnv(request) };
	},

	parseLine(line: string): AgentStreamEvent[] {
		const record = parseJsonLine(line);
		if (!record) return [];

		const type = typeof record.type === "string" ? record.type : null;
		if (!type) return [];

		// A `default` branch is correct here and banned in `signalFor`, and the
		// distinction is who owns the set. `AgentInterrupt` is Harbor's own closed
		// set, so a new member must break the build. This string comes out of someone
		// else's process and gains members whenever they ship; treating an unknown one
		// as fatal would break every Harbor deployment on the day Claude Code adds an
		// event type.
		switch (type) {
			case "assistant":
				return assistantEvents(record);
			case "result":
				return resultEvents(record);
			case "system":
				// `system`/`init` carries the session id and the tool list. The id is
				// read by `resumeTokenFrom` from the whole stdout; re-announcing the
				// boot in the transcript would just be noise above the first message.
				return [];
			case "user":
				// Tool *results* arrive as `user` messages, and the block carries a
				// `tool_use_id` but not the tool's name. Emitting a post-phase event
				// would therefore mean either inventing a name — a timeline that claims
				// a tool ran which never did — or keeping an id→name map on this module
				// singleton, which is shared by every concurrent turn in the process and
				// would attribute one session's result to another session's tool.
				//
				// Nothing is actually lost: Claude Code's `PostToolUse` hook posts to
				// Harbor's activity ingest and *does* carry `tool_name`, and
				// `src/activity/claude-code.ts` already parses it. The post-phase row
				// comes from there.
				return [];
			case "stream_event":
				// Partial token deltas. The `assistant` message that follows repeats the
				// same text in full, so emitting both duplicates every sentence.
				return [];
			default:
				return [];
		}
	},

	interrupt(interrupt: AgentInterrupt): NodeJS.Signals {
		return signalFor(interrupt);
	},

	/**
	 * The session id, taken from the **last** line that carries one.
	 *
	 * Scanned backwards rather than forwards because a resumed turn can be issued a
	 * new session id partway through — a compaction, or a fork — and the id that
	 * continues the conversation is the most recent one. Taking the first would pin
	 * every subsequent turn to a thread the agent has already moved on from, and the
	 * symptom is an agent that forgets the last few exchanges of a long session.
	 */
	resumeTokenFrom(stdout: string, _workspace: string): string | null {
		const lines = stdout.split("\n");
		for (let index = lines.length - 1; index >= 0; index -= 1) {
			const record = parseJsonLine(lines[index] ?? "");
			if (!record) continue;
			const sessionId = firstString(record.session_id);
			if (sessionId) return sessionId;
		}
		return null;
	},
};

/**
 * Why `replay` and not `reattach`.
 *
 * Claude Code does persist a transcript, and `--resume` will pick a session back
 * up — but that is resuming a *conversation*, not reattaching to an *in-flight
 * turn*. If the sandbox dies mid-turn there is no handle to the half-finished
 * turn: the tool call that was running was killed with the process, and the
 * transcript on disk ends wherever the last flush landed. Re-sending the prompt is
 * safe because prompts are idempotent at the queue level and the workspace is a
 * git checkout whose state the agent can read before acting. Claiming `reattach`
 * would make the supervisor wait for a turn that is never coming back.
 */
