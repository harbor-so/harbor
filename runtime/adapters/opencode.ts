// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * opencode, driven server-first.
 *
 * opencode is the odd one of the three built-ins because it is not really a CLI
 * that happens to have a server — it is a server that happens to have a CLI.
 * `opencode serve` owns session state on disk and publishes an event stream; the
 * `run` subcommand is a client that starts one, sends a message, prints what comes
 * back and exits.
 *
 * That shapes three decisions here:
 *
 *  - **`recovery: "reattach"`.** This is the only built-in that earns it. If the
 *    sandbox is restarted mid-turn, the session and its transcript are still on
 *    disk and the supervisor can attach to the existing session id and read the
 *    tail. Declaring `replay` instead would re-send a prompt whose edits already
 *    landed, and the agent would apply them twice — a second identical function,
 *    a duplicated migration — which is far worse than the pause that reattaching
 *    costs.
 *  - **`parseLine` accepts three input shapes, not one.** Depending on how the
 *    supervisor is attached, a line is either a server event forwarded verbatim,
 *    a plugin hook payload (the shape `src/activity/opencode.ts` already parses,
 *    reused here rather than reimplemented), or a `--print-logs` log line.
 *  - **Plain text is a message, not garbage.** `opencode run` in its default mode
 *    prints the assistant's answer as prose. An adapter that only understood JSON
 *    would show an empty transcript for a turn that worked perfectly.
 */

import { opencodeNormalizer } from "../../app/activity/opencode.js";
import { summarizeTool } from "../../app/activity/types.js";
import type {
	AgentAdapter,
	AgentInterrupt,
	AgentStreamEvent,
	AgentTurnRequest,
	AgentUsage,
} from "../../app/contracts/agent.js";
import {
	activityToStreamEvents,
	firstString,
	isRecord,
	microUsdFromDollars,
	parseJsonLine,
	baseEnv,
	signalFor,
	stripAnsi,
	summaryLine,
	tokenCount,
} from "./index.js";

/**
 * A `--print-logs` line, split into level and remainder.
 *
 * The format is `LEVEL  <timestamp> +<delta> service=… key=value …`. Only the
 * level is load-bearing: an ERROR line is worth surfacing as a warning, and
 * everything below it is internal chatter that would bury the transcript. The
 * return value is null for anything that is not a log line at all, which is how
 * `parseLine` tells prose apart from logging.
 */
function parseLogLine(line: string): { level: string; rest: string } | null {
	const match = /^(DEBUG|INFO|WARN|ERROR|FATAL)\s+(.*)$/.exec(line);
	if (!match) return null;
	return { level: match[1] ?? "", rest: match[2] ?? "" };
}

/**
 * Usage from an opencode assistant message.
 *
 * opencode reports tokens and cost **per assistant message**, and there is no
 * turn-level total anywhere in its stream. That is why
 * `usageAccumulationFor("opencode")` is `additive` while the other two built-ins
 * are `absolute`: the supervisor must sum these, and summing Claude Code's would
 * bill a five-message turn five times. The declaration is what keeps those two
 * facts from being confused.
 */
function usageFromInfo(info: Record<string, unknown>): AgentUsage | null {
	const tokens = isRecord(info.tokens) ? info.tokens : null;
	if (!tokens) return null;

	const model = firstString(info.modelID, info.model);
	const providerId = firstString(info.providerID);
	const usage: AgentUsage = {
		source: "agent_reported",
		input_tokens: tokenCount(tokens.input) ?? 0,
		output_tokens: tokenCount(tokens.output) ?? 0,
		// Qualified with the provider because opencode routes the same model name
		// across several of them, and `claude-sonnet-4-5` billed through Bedrock is
		// not the same price as the same string billed direct. An unqualified name
		// would price a multi-provider deployment against the wrong table.
		model: model ? (providerId ? `${providerId}/${model}` : model) : null,
	};

	const cache = isRecord(tokens.cache) ? tokens.cache : null;
	if (cache) {
		const read = tokenCount(cache.read);
		if (read !== undefined) usage.cache_read_tokens = read;
		const write = tokenCount(cache.write);
		if (write !== undefined) usage.cache_write_tokens = write;
	}

	const microUsd = microUsdFromDollars(info.cost);
	if (microUsd !== undefined) usage.micro_usd = microUsd;

	return usage;
}

/** A `message.part.updated` part: assistant text, or a tool call and its state. */
function partEvents(part: Record<string, unknown>): AgentStreamEvent[] {
	const type = typeof part.type === "string" ? part.type : "";

	if (type === "text") {
		const text = typeof part.text === "string" ? part.text : "";
		return text.trim() === "" ? [] : [{ kind: "message", text }];
	}

	if (type === "reasoning") return [];

	if (type === "tool") {
		const tool = firstString(part.tool, part.name) ?? "unknown";
		const state = isRecord(part.state) ? part.state : {};
		const status = typeof state.status === "string" ? state.status : "";
		const summary = summarizeTool(state.input ?? part.args, state.output ?? state.result);
		if (typeof state.title === "string") summary.title = state.title;

		if (status === "error") {
			const message = firstString(state.error, state.output) ?? `${tool} failed.`;
			return [{ kind: "warning", message }];
		}

		// Anything that is not explicitly finished is reported as `pre`. A deny-list,
		// not an allow-list: opencode has used `pending`, `running` and `queued` for
		// the same idea, and an allow-list of in-flight statuses would silently mark a
		// running tool as completed the moment a new one is introduced.
		const phase: "pre" | "post" = status === "completed" ? "post" : "pre";
		return [{ kind: "tool_call", tool, phase, summary: summaryLine(summary) }];
	}

	return [];
}

/** A JSON line: a plugin hook payload, or a server event. */
function jsonEvents(record: Record<string, unknown>): AgentStreamEvent[] {
	// The plugin dialect first. `src/activity/opencode.ts` already reads exactly
	// this shape — `{ event: "tool.execute.before", tool, args, sessionID }` — and
	// reusing it means the live timeline and the activity feed summarise a tool call
	// identically instead of drifting apart.
	if (typeof record.event === "string") {
		const events = activityToStreamEvents(opencodeNormalizer.normalize(record));
		if (events.length > 0) return events;
	}

	const type = typeof record.type === "string" ? record.type : "";
	const properties = isRecord(record.properties) ? record.properties : record;

	switch (type) {
		case "message.part.updated": {
			const part = isRecord(properties.part) ? properties.part : null;
			return part ? partEvents(part) : [];
		}
		case "message.updated": {
			const info = isRecord(properties.info) ? properties.info : null;
			const usage = info ? usageFromInfo(info) : null;
			return usage ? [{ kind: "usage", usage }] : [];
		}
		case "session.error": {
			const error = isRecord(properties.error) ? properties.error : properties;
			const message =
				firstString(error.message, error.name, properties.message) ?? "opencode reported an error.";
			return [{ kind: "warning", message }];
		}
		case "session.idle":
		case "session.updated":
		case "server.connected":
		case "storage.write":
			return [];
		default:
			return [];
	}
}

/**
 * MCP servers for opencode, as inline config in the environment.
 *
 * opencode has no CLI flag for this — configuration is files and environment
 * only, with `OPENCODE_CONFIG_CONTENT` sitting near the top of the precedence
 * chain (above the project's own `opencode.json`). That makes it the analogue of
 * Claude Code's `--mcp-config`, and it is chosen for the same reason: the
 * alternative is writing a file, and that file would contain brokered
 * credentials and would outlive the turn on the sandbox's disk.
 *
 * Two differences from Claude Code that must not be papered over:
 *
 *  - **The shape is not the same.** Harbor's `McpServerSpec` says `"http"`;
 *    opencode wants `"remote"` under an `mcp` key rather than `mcpServers`.
 *    Passing Harbor's shape through unchanged yields a config opencode parses
 *    and silently ignores.
 *  - **There is no `--strict-mcp-config` equivalent.** Claude Code can be told
 *    that the resolved set is the complete set; opencode merges the global and
 *    project configs underneath this one. So a repository that ships its own
 *    `mcp` block still contributes servers the control plane never authorised.
 *    `OPENCODE_CONFIG_CONTENT` wins on a key collision, which is enough to stop
 *    `harbor-agent` itself being shadowed, but it is not isolation and should not
 *    be described as such.
 */
function mcpEnv(request: AgentTurnRequest): Record<string, string> {
	const servers = request.mcp_servers;
	if (!servers || Object.keys(servers).length === 0) return {};

	const mcp: Record<string, unknown> = {};
	for (const [name, spec] of Object.entries(servers)) {
		if (spec.type === "http") {
			mcp[name] = {
				type: "remote",
				url: spec.url,
				enabled: true,
				...(spec.headers ? { headers: spec.headers } : {}),
			};
			continue;
		}
		mcp[name] = {
			type: "local",
			// opencode takes one argv array, not a command plus args.
			command: [spec.command ?? "", ...(spec.args ?? [])].filter(Boolean),
			enabled: true,
		};
	}

	return { OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp }) };
}

export const opencodeAdapter: AgentAdapter = {
	runtime: "opencode",

	/**
	 * `none`, and this is the one adapter where that is the honest answer rather
	 * than a shrug.
	 *
	 * opencode is a router: the model provider is chosen per session, and the
	 * credential lives in opencode's own `auth.json` or in whichever provider
	 * variable that provider needs — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
	 * `GROQ_API_KEY`, a local Ollama with no key at all. Naming any single variable
	 * here would produce a preflight that refuses a correctly configured Groq
	 * deployment because an Anthropic key is missing. There is no one variable to
	 * declare, so none is declared, and the failure surfaces where it is legible:
	 * opencode's own provider error on the first turn.
	 */
	credentials: { mode: "none" },

	/** The only built-in that can be reattached — see the header. */
	recovery: "reattach",

	command(request: AgentTurnRequest) {
		const args = ["run", "--print-logs"];

		if (request.resume_token) {
			args.push("--session", request.resume_token);
		}
		if (request.model) {
			args.push("--model", request.model);
		}

		// `--` then the prompt, one element. Same reason as the other adapters: the
		// prompt can come from a GitHub comment, and without the separator a leading
		// hyphen turns attacker-influenced text into flags.
		args.push("--", request.body);

		return { bin: "opencode", args, env: { ...baseEnv(request), ...mcpEnv(request) } };
	},

	parseLine(line: string): AgentStreamEvent[] {
		const cleaned = stripAnsi(line).trim();
		if (!cleaned) return [];

		const record = parseJsonLine(cleaned);
		if (record) return jsonEvents(record);

		const log = parseLogLine(cleaned);
		if (log) {
			if (log.level === "ERROR" || log.level === "FATAL") {
				return [{ kind: "warning", message: log.rest }];
			}
			return [];
		}

		// Not JSON and not a log line, so it is the assistant talking. This branch is
		// why the text runtimes work at all, and it is deliberately last: putting it
		// first would turn every INFO line into a message in the transcript.
		return [{ kind: "message", text: cleaned }];
	},

	interrupt(interrupt: AgentInterrupt): NodeJS.Signals {
		return signalFor(interrupt);
	},

	/**
	 * The opencode session id.
	 *
	 * Two sources, in the order they are trustworthy. A JSON line that names the
	 * session is authoritative. Failing that, `--print-logs` prints `sessionID=…`
	 * on its own log lines, and the `ses_` prefix is distinctive enough to match
	 * safely — the alternative, having no resume token at all, means every follow-up
	 * message in a session starts a new conversation and the agent asks the user to
	 * repeat context it was told a minute ago.
	 *
	 * Scanned from the end, because a session that was compacted or forked mid-turn
	 * continues under the newest id.
	 */
	resumeTokenFrom(stdout: string, _workspace: string): string | null {
		const lines = stdout.split("\n");
		for (let index = lines.length - 1; index >= 0; index -= 1) {
			const line = stripAnsi(lines[index] ?? "");
			if (!line.trim()) continue;

			const record = parseJsonLine(line);
			if (record) {
				const properties = isRecord(record.properties) ? record.properties : {};
				const info = isRecord(properties.info) ? properties.info : {};
				const id = firstString(
					record.sessionID,
					record.session_id,
					properties.sessionID,
					info.sessionID,
					info.id,
				);
				if (id) return id;
				continue;
			}

			const match = /\bses_[0-9a-zA-Z]{6,}/.exec(line);
			if (match) return match[0];
		}
		return null;
	},
};
