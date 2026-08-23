// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * OpenAI Codex CLI, driven headless.
 *
 * `codex exec --sandbox workspace-write --json <prompt>`. The sandbox mode is the
 * interesting flag: `read-only` produces an agent that can analyse and never
 * change anything, and `danger-full-access` lets it out of the workspace. Harbor
 * already runs the whole process inside a disposable container, so the useful
 * boundary here is not "protect the machine" — it is "keep the blast radius equal
 * to the git checkout we are going to diff", which is exactly `workspace-write`.
 *
 * ## Two JSON dialects, both handled on purpose
 *
 * Codex has shipped two shapes for `--json`. The older one wraps everything in an
 * envelope, `{"id":"0","msg":{"type":"agent_message",…}}`; the newer flat schema
 * emits `{"type":"item.completed","item":{…}}` and friends. Which one a given
 * binary speaks depends on the version installed in the sandbox image, and Harbor
 * does not control that image on a self-hosted deployment. Supporting only the
 * newer one means an operator on last quarter's Codex sees a turn that runs
 * correctly, changes files, and shows a completely empty timeline — the worst kind
 * of bug, because everything except the observability worked.
 */

import { summarizeTool } from "../../app/activity/types.js";
import type {
	AgentAdapter,
	AgentInterrupt,
	AgentStreamEvent,
	AgentTurnRequest,
	AgentUsage,
} from "../../app/contracts/agent.js";
import {
	baseEnv,
	firstString,
	isRecord,
	parseJsonLine,
	signalFor,
	summaryLine,
	tokenCount,
} from "./index.js";

/**
 * Token counts, from whichever of the three places this version puts them.
 *
 * Codex reports `input_tokens` **inclusive** of `cached_input_tokens`, where
 * Anthropic reports them exclusive. Harbor records both numbers exactly as the
 * agent gave them and does not subtract one from the other, because the adapter is
 * not authoritative for how a provider prices a cache hit; a silently adjusted
 * count is a number that disagrees with the invoice, which is the one outcome the
 * usage contract exists to prevent. Reconciliation, if it ever happens, belongs in
 * the model price table where it is visible.
 *
 * Codex reports no monetary figure at all, so `micro_usd` is absent and the cost
 * row is priced from the model table and marked estimated.
 */
function usageFrom(raw: Record<string, unknown>, model: string | null): AgentUsage {
	const usage: AgentUsage = {
		source: "agent_reported",
		input_tokens: tokenCount(raw.input_tokens) ?? 0,
		output_tokens: tokenCount(raw.output_tokens) ?? 0,
		model,
	};
	const cached = tokenCount(raw.cached_input_tokens);
	if (cached !== undefined) usage.cache_read_tokens = cached;
	return usage;
}

/**
 * `token_count`, in all three shapes Codex has used for it.
 *
 * The newer envelope splits `total_token_usage` from `last_token_usage`, and
 * picking the wrong one is a billing bug rather than a cosmetic one:
 * `last_token_usage` is the most recent model call, and a turn with eight tool
 * calls emits eight of them. `usageAccumulationFor("codex")` declares `absolute`,
 * so the supervisor keeps the last usage event it sees — which is only correct if
 * every one of them is a running total. Hence `total_token_usage` first.
 */
function tokenCountEvents(msg: Record<string, unknown>): AgentStreamEvent[] {
	const info = isRecord(msg.info) ? msg.info : null;
	const total = info && isRecord(info.total_token_usage) ? info.total_token_usage : null;
	const raw = total ?? (info ? null : msg);
	if (!raw) return [];
	return [{ kind: "usage", usage: usageFrom(raw, null) }];
}

/** A shell invocation Codex reports as an array of argv elements, or a string. */
function commandText(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.filter((part) => typeof part === "string").join(" ");
	return undefined;
}

function execEvents(
	msg: Record<string, unknown>,
	phase: "pre" | "post",
): AgentStreamEvent[] {
	const summary = summarizeTool(
		{ command: commandText(msg.command) },
		{ stdout: firstString(msg.aggregated_output, msg.stdout, msg.output) ?? undefined },
	);
	// Set after `summarizeTool` rather than handed to it: that helper maps `path`
	// onto `file_path`, and labelling a working directory as the file a command
	// touched puts a wrong path in front of a reviewer.
	if (typeof msg.cwd === "string") summary.cwd = msg.cwd;
	if (typeof msg.exit_code === "number") summary.exit_code = msg.exit_code;
	return [{ kind: "tool_call", tool: "shell", phase, summary: summaryLine(summary) }];
}

/** A patch application, whose payload is a map of path → change. */
function patchEvents(
	msg: Record<string, unknown>,
	phase: "pre" | "post",
): AgentStreamEvent[] {
	const changes = isRecord(msg.changes) ? Object.keys(msg.changes) : [];
	const summary: Record<string, unknown> = {};
	if (changes.length > 0) summary.files = changes;
	if (typeof msg.success === "boolean") summary.success = msg.success;
	const error = firstString(msg.stderr, msg.error);
	if (error) summary.error = error;
	return [{ kind: "tool_call", tool: "apply_patch", phase, summary: summaryLine(summary) }];
}

/** One `item` from the flat schema, at the phase its envelope implies. */
function itemEvents(item: unknown, phase: "pre" | "post"): AgentStreamEvent[] {
	if (!isRecord(item)) return [];
	const type = typeof item.type === "string" ? item.type : "";

	switch (type) {
		case "agent_message": {
			// `item.started` for the same item fires with empty or partial text, and
			// the completed one repeats it in full. Emitting both shows the user the
			// same paragraph twice.
			if (phase === "pre") return [];
			const text = firstString(item.text, item.message);
			return text ? [{ kind: "message", text }] : [];
		}
		case "reasoning":
			// Dropped for the same reason as Claude Code's `thinking` blocks: it is
			// scratch space the model did not commit to, and a reviewer cannot tell it
			// apart from the answer.
			return [];
		case "command_execution":
			return execEvents(item, phase);
		case "file_change":
			return patchEvents(item, phase);
		case "mcp_tool_call": {
			const tool = firstString(item.tool, item.name) ?? "mcp";
			const summary = summarizeTool(item.arguments ?? item.input, item.result ?? item.output);
			if (typeof item.server === "string") summary.server = item.server;
			return [{ kind: "tool_call", tool, phase, summary: summaryLine(summary) }];
		}
		case "web_search": {
			const summary = summarizeTool({ pattern: item.query }, undefined);
			return [{ kind: "tool_call", tool: "web_search", phase, summary: summaryLine(summary) }];
		}
		case "error": {
			const message = firstString(item.message, item.text) ?? "Codex reported an error.";
			return [{ kind: "warning", message }];
		}
		default:
			// Unknown item types (todo lists, plan updates, whatever ships next) are
			// dropped, not failed. See `parseJsonLine` on failing open over somebody
			// else's vocabulary.
			return [];
	}
}

export const codexAdapter: AgentAdapter = {
	runtime: "codex",

	/**
	 * Optional for the same reason as Claude Code's: `codex login` stores a ChatGPT
	 * subscription session, and under that configuration `OPENAI_API_KEY` is
	 * legitimately absent. Requiring it would refuse a valid setup at admission.
	 */
	credentials: { mode: "env_key_optional", variable: "OPENAI_API_KEY", required: false },

	/**
	 * Codex writes a rollout file per session, so a *conversation* survives a
	 * restart and `codex exec resume` will pick it up. An interrupted *turn* does
	 * not: the exec that was running died with the container. Replay the prompt.
	 */
	recovery: "replay",

	command(request: AgentTurnRequest) {
		const args = ["exec"];

		// `resume <id>` has to sit immediately after `exec`, before the options, or
		// clap reads the session id as the prompt and the agent starts a fresh thread
		// whose first message is a UUID.
		if (request.resume_token) {
			args.push("resume", request.resume_token);
		}

		args.push("--sandbox", "workspace-write", "--json");

		if (request.model) {
			args.push("--model", request.model);
		}

		// Same argument-injection reasoning as the other adapters: `--` first, then
		// the prompt as one element, so attacker-influenced text beginning with a
		// hyphen cannot become a flag. `--sandbox danger-full-access` arriving from a
		// GitHub comment is the concrete thing this prevents.
		args.push("--", request.body);

		return { bin: "codex", args, env: baseEnv(request) };
	},

	parseLine(line: string): AgentStreamEvent[] {
		const record = parseJsonLine(line);
		if (!record) return [];

		// The older dialect nests everything under `msg`; the flat one does not. One
		// unwrap here means the switch below reads the same either way.
		const msg = isRecord(record.msg) ? record.msg : record;
		const type = typeof msg.type === "string" ? msg.type : null;
		if (!type) return [];

		switch (type) {
			// -- Older enveloped dialect ---------------------------------------
			case "agent_message": {
				const text = firstString(msg.message, msg.text);
				return text ? [{ kind: "message", text }] : [];
			}
			case "agent_reasoning":
			case "agent_reasoning_delta":
			case "agent_message_delta":
				return [];
			case "exec_command_begin":
				return execEvents(msg, "pre");
			case "exec_command_end":
				return execEvents(msg, "post");
			case "patch_apply_begin":
				return patchEvents(msg, "pre");
			case "patch_apply_end":
				return patchEvents(msg, "post");
			case "mcp_tool_call_begin":
				return itemEvents({ ...msg, type: "mcp_tool_call" }, "pre");
			case "mcp_tool_call_end":
				return itemEvents({ ...msg, type: "mcp_tool_call" }, "post");
			case "token_count":
				return tokenCountEvents(msg);
			case "error":
			case "stream_error": {
				const message = firstString(msg.message, msg.error) ?? "Codex reported an error.";
				return [{ kind: "warning", message }];
			}
			case "session_configured":
			case "task_started":
			case "task_complete":
				// Lifecycle only. The session id is read out of the whole stdout by
				// `resumeTokenFrom`; repeating it in the transcript helps nobody.
				return [];

			// -- Newer flat schema ---------------------------------------------
			case "item.started":
				return itemEvents(msg.item, "pre");
			case "item.completed":
				return itemEvents(msg.item, "post");
			case "item.updated":
				// Interim state for an item whose `completed` envelope will carry the
				// final version. Emitting both shows a half-written command running
				// alongside the real one.
				return [];
			case "turn.completed": {
				const usageRaw = isRecord(msg.usage) ? msg.usage : {};
				return [{ kind: "usage", usage: usageFrom(usageRaw, null) }];
			}
			case "turn.failed": {
				const error = isRecord(msg.error) ? msg.error : {};
				const message = firstString(error.message, msg.message) ?? "Codex turn failed.";
				return [{ kind: "warning", message }];
			}
			case "thread.started":
			case "turn.started":
				return [];

			default:
				// Somebody else's vocabulary, so unknown members are dropped rather than
				// treated as failure — see `parseJsonLine`.
				return [];
		}
	},

	interrupt(interrupt: AgentInterrupt): NodeJS.Signals {
		return signalFor(interrupt);
	},

	/**
	 * The conversation id, from the last line that names one.
	 *
	 * Both dialects announce it up front — `session_configured.session_id` in the
	 * old one, `thread.started.thread_id` in the new — and both names are checked
	 * because a sandbox image pinned to an older Codex is a supported deployment,
	 * not a bug. Returning null when neither appears means the next turn starts a
	 * fresh thread, which loses context but never resumes the *wrong* one; guessing
	 * an id from a rollout filename would risk the latter.
	 */
	resumeTokenFrom(stdout: string, _workspace: string): string | null {
		const lines = stdout.split("\n");
		for (let index = lines.length - 1; index >= 0; index -= 1) {
			const record = parseJsonLine(lines[index] ?? "");
			if (!record) continue;
			const msg = isRecord(record.msg) ? record.msg : record;
			const id = firstString(msg.session_id, msg.thread_id, msg.conversation_id);
			if (id) return id;
		}
		return null;
	},
};
