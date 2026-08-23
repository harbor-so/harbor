// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The escape hatch: any agent an operator can run non-interactively.
 *
 * Without this file, "bring your own agent" means "bring one of ours", and the
 * first company with an in-house agent — which is most companies that have run an
 * evaluation — has to fork Harbor to use it. Forks do not get upgrades, so that
 * fork is where their deployment stops improving. A declared argv template and a
 * declared stream format cost far less than that.
 *
 * The configuration is five environment variables:
 *
 *   HARBOR_CUSTOM_AGENT_BIN      the executable, e.g. `/usr/local/bin/our-agent`
 *   HARBOR_CUSTOM_AGENT_ARGS     the argv template, containing `{prompt}` exactly once
 *   HARBOR_CUSTOM_AGENT_FORMAT   `jsonl` or `text`
 *   HARBOR_CUSTOM_AGENT_RESUME   optional argv fragment containing `{resume_token}`
 *   HARBOR_CUSTOM_AGENT_ENV_KEY  optional name of a required credential variable
 *
 * plus HARBOR_CUSTOM_AGENT_RECOVERY and HARBOR_CUSTOM_AGENT_RESUME_PATTERN, both
 * documented at their point of use below.
 *
 * ## Why the template is split before substitution, not after
 *
 * `HARBOR_CUSTOM_AGENT_ARGS` is split into argv elements **first**, and `{prompt}`
 * is replaced inside each resulting element **second**. Doing it the other way —
 * substituting into the template string and then splitting — is the bug this whole
 * design exists to avoid: a prompt containing `; rm -rf /` or a newline or a quote
 * would be split into extra argv elements, and a prompt is attacker-influenced
 * text that arrives from a GitHub comment. In this order the prompt cannot become
 * more than one element no matter what is in it, and there is no shell anywhere in
 * the path to reinterpret it.
 */

import { normalizeClaudeStyle } from "../../app/activity/claude-style.js";
import { summarizeTool } from "../../app/activity/types.js";
import type {
	AgentAdapter,
	AgentCredentialSpec,
	AgentInterrupt,
	AgentStreamEvent,
	AgentTurnRequest,
	AgentUsage,
} from "../../app/contracts/agent.js";
import {
	activityToStreamEvents,
	assertNever,
	baseEnv,
	firstString,
	isRecord,
	microUsdFromDollars,
	parseJsonLine,
	signalFor,
	stripAnsi,
	summaryLine,
	tokenCount,
} from "./index.js";

/**
 * How the custom agent's stdout is read.
 *
 * `text` is not a lesser option. An agent that prints prose gets a working
 * transcript, working stop/cancel, working git attribution and working timeouts;
 * what it does not get is per-tool rows or token accounting, and Harbor says so
 * with `source: "unavailable"` rather than estimating them.
 */
export const CUSTOM_STREAM_FORMATS = ["jsonl", "text"] as const;
export type CustomStreamFormat = (typeof CUSTOM_STREAM_FORMATS)[number];

export interface CustomAgentSpec {
	bin: string;
	/** Argv template, already split. Elements may contain `{prompt}`. */
	argsTemplate: string[];
	/** Argv fragment inserted before the prompt when resuming. May contain `{resume_token}`. */
	resumeTemplate: string[];
	format: CustomStreamFormat;
	credentials: AgentCredentialSpec;
	recovery: "reattach" | "replay" | "abandon";
	/** Regex with one capture group, applied to stdout to recover a resume token. */
	resumePattern: RegExp | null;
}

/**
 * A configuration, or a typed reason it is unusable.
 *
 * Never a boolean and never a thrown string. Each reason maps to a different fix
 * by a different person: `not_configured` means the operator has not filled in the
 * environment, `missing_prompt_placeholder` means they filled it in wrongly in a
 * way that would otherwise run the agent with no prompt at all and report success,
 * and `unknown_stream_format` means they typed `json` where Harbor wanted `jsonl`.
 * "Custom agent misconfigured" for all three sends two of those three people
 * looking in the wrong place.
 */
export type CustomAgentSpecResult =
	| { ok: true; spec: CustomAgentSpec }
	| {
			ok: false;
			reason:
				| "not_configured"
				| "malformed_args"
				| "missing_prompt_placeholder"
				| "unknown_stream_format"
				| "malformed_resume_pattern";
			message: string;
	  };

export class CustomAgentConfigError extends Error {
	readonly reason: string;

	constructor(reason: string, message: string) {
		super(message);
		this.name = "CustomAgentConfigError";
		this.reason = reason;
	}
}

/**
 * Split an argv template into elements.
 *
 * Two accepted spellings, and the JSON one is documented as preferred: a JSON
 * array is unambiguous about where each element ends, which matters for an
 * operator whose agent takes an argument containing a space. The whitespace form
 * exists because most templates are three flags and demanding JSON for those is
 * friction with no payoff.
 *
 * Note what neither form does: interpret quotes, globs, `$VAR`, or `;`. This is
 * not a shell and never becomes one, because the moment it interprets quoting, the
 * prompt substituted into it can escape its element.
 */
function splitTemplate(raw: string): string[] | null {
	const trimmed = raw.trim();
	if (trimmed === "") return [];
	if (trimmed.startsWith("[")) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (!Array.isArray(parsed)) return null;
			if (!parsed.every((element) => typeof element === "string")) return null;
			return parsed as string[];
		} catch {
			return null;
		}
	}
	return trimmed.split(/\s+/);
}

/**
 * Read the custom agent configuration out of an environment.
 *
 * Takes the environment as an argument rather than reading `process.env` directly
 * so it can be tested at its exact boundaries with no mocking and no global
 * mutation, which is the same discipline `setting()` follows in `src/config.ts`.
 */
export function customAgentSpec(
	env: Record<string, string | undefined> = process.env,
): CustomAgentSpecResult {
	const bin = env.HARBOR_CUSTOM_AGENT_BIN?.trim();
	if (!bin) {
		return {
			ok: false,
			reason: "not_configured",
			message:
				"Runtime 'custom' is selected but HARBOR_CUSTOM_AGENT_BIN is not set. Set it to the "
				+ "executable Harbor should run, and HARBOR_CUSTOM_AGENT_ARGS to its argument "
				+ "template containing {prompt}.",
		};
	}

	const argsTemplate = splitTemplate(env.HARBOR_CUSTOM_AGENT_ARGS ?? "");
	if (argsTemplate === null) {
		return {
			ok: false,
			reason: "malformed_args",
			message:
				"HARBOR_CUSTOM_AGENT_ARGS starts with '[' but is not a JSON array of strings. Either "
				+ 'fix the JSON (e.g. ["run","--json","{prompt}"]) or write the arguments as plain '
				+ "whitespace-separated text.",
		};
	}

	if (!argsTemplate.some((element) => element.includes("{prompt}"))) {
		// This is the failure worth being loudest about. Without the placeholder the
		// agent launches, receives no prompt, does nothing and exits zero — so the
		// turn is recorded as completed, the session shows no diff, and the operator
		// concludes the model is useless rather than that a variable is wrong.
		return {
			ok: false,
			reason: "missing_prompt_placeholder",
			message:
				"HARBOR_CUSTOM_AGENT_ARGS contains no {prompt} placeholder, so the prompt would never "
				+ "reach the agent and every turn would exit successfully having done nothing. Add "
				+ "{prompt} as its own argument, or inside one (e.g. --message={prompt}).",
		};
	}

	const rawFormat = (env.HARBOR_CUSTOM_AGENT_FORMAT ?? "text").trim().toLowerCase();
	const format = CUSTOM_STREAM_FORMATS.find((candidate) => candidate === rawFormat);
	if (!format) {
		return {
			ok: false,
			reason: "unknown_stream_format",
			message:
				`HARBOR_CUSTOM_AGENT_FORMAT is "${rawFormat}", which Harbor does not know how to `
				+ `read. Use one of: ${CUSTOM_STREAM_FORMATS.join(", ")}.`,
		};
	}

	const resumeTemplate = splitTemplate(env.HARBOR_CUSTOM_AGENT_RESUME ?? "");
	if (resumeTemplate === null) {
		return {
			ok: false,
			reason: "malformed_args",
			message:
				"HARBOR_CUSTOM_AGENT_RESUME starts with '[' but is not a JSON array of strings.",
		};
	}

	let resumePattern: RegExp | null = null;
	const rawPattern = env.HARBOR_CUSTOM_AGENT_RESUME_PATTERN?.trim();
	if (rawPattern) {
		try {
			resumePattern = new RegExp(rawPattern);
		} catch (error) {
			return {
				ok: false,
				reason: "malformed_resume_pattern",
				message:
					`HARBOR_CUSTOM_AGENT_RESUME_PATTERN is not a valid regular expression: `
					+ `${(error as Error).message}. It must contain one capture group around the `
					+ "session id the agent prints.",
			};
		}
	}

	const keyVariable = env.HARBOR_CUSTOM_AGENT_ENV_KEY?.trim();
	const credentials: AgentCredentialSpec = keyVariable
		? { mode: "env_key", variable: keyVariable, required: true }
		: { mode: "none" };

	// `abandon` is the default, and it is the conservative choice on purpose. Harbor
	// knows nothing about an unknown agent's durability: `replay` would re-send a
	// prompt whose file edits may already have landed, and an agent that is not
	// idempotent then writes the same migration twice. An operator who knows their
	// agent is safe to replay says so explicitly; Harbor does not assume it on their
	// behalf.
	const rawRecovery = (env.HARBOR_CUSTOM_AGENT_RECOVERY ?? "abandon").trim().toLowerCase();
	const recovery =
		rawRecovery === "replay" ? "replay" : rawRecovery === "reattach" ? "reattach" : "abandon";

	return {
		ok: true,
		spec: { bin, argsTemplate, resumeTemplate, format, credentials, recovery, resumePattern },
	};
}

/** The spec, or a throw naming the reason. */
function requireSpec(env: Record<string, string | undefined> = process.env): CustomAgentSpec {
	const result = customAgentSpec(env);
	if (!result.ok) throw new CustomAgentConfigError(result.reason, result.message);
	return result.spec;
}

/**
 * Substitute one placeholder inside argv elements, never across them.
 *
 * The replacement happens per element and after splitting, so the substituted
 * value is contained by the element it lands in. `; rm -rf /`, a newline, an
 * unbalanced quote and a NUL-free binary blob are all just characters in an
 * `execve` argument here — there is no shell in the path and nothing that could
 * reinterpret them as syntax.
 */
function substitute(template: string[], placeholder: string, value: string): string[] {
	return template.map((element) => element.split(placeholder).join(value));
}

/**
 * A JSONL line from an unknown agent, read as generously as is honest.
 *
 * Three shapes are recognised. The first is Harbor's own hook dialect — an agent
 * that already emits `PreToolUse`/`tool_name` gets full tool rows for free, and
 * that path reuses `normalizeClaudeStyle` rather than a second copy of the same
 * field-picking. The second is a small conventional vocabulary documented for
 * custom agents. Anything else yields nothing, which is the fail-open rule: an
 * unrecognised line from somebody's in-house agent must not end their turn.
 */
function jsonlEvents(record: Record<string, unknown>): AgentStreamEvent[] {
	if (typeof record.hook_event_name === "string") {
		const events = activityToStreamEvents(normalizeClaudeStyle(record));
		if (events.length > 0) return events;
	}

	const type = firstString(record.type, record.kind) ?? "";

	if (type === "usage" || isRecord(record.usage)) {
		const raw = isRecord(record.usage) ? record.usage : record;
		const usage: AgentUsage = {
			source: "agent_reported",
			input_tokens: tokenCount(raw.input_tokens) ?? 0,
			output_tokens: tokenCount(raw.output_tokens) ?? 0,
			model: firstString(raw.model, record.model),
		};
		const cacheRead = tokenCount(raw.cache_read_tokens);
		if (cacheRead !== undefined) usage.cache_read_tokens = cacheRead;
		const cacheWrite = tokenCount(raw.cache_write_tokens);
		if (cacheWrite !== undefined) usage.cache_write_tokens = cacheWrite;
		const microUsd =
			tokenCount(raw.micro_usd) ?? microUsdFromDollars(raw.cost_usd ?? raw.cost);
		if (microUsd !== undefined) usage.micro_usd = microUsd;
		return [{ kind: "usage", usage }];
	}

	if (type === "warning" || type === "error") {
		const message = firstString(record.message, record.text, record.error);
		return message ? [{ kind: "warning", message }] : [];
	}

	const tool = firstString(record.tool, record.tool_name);
	if (tool) {
		const rawPhase = firstString(record.phase) ?? "";
		const summary = summarizeTool(
			record.input ?? record.tool_input ?? record.args,
			record.output ?? record.tool_output ?? record.result,
		);
		return [
			{
				kind: "tool_call",
				tool,
				// Anything not explicitly `post` is `pre`: a deny-list again, so an
				// agent that spells its completion phase differently produces a row that
				// understates progress rather than one that claims a tool finished when
				// it may not have.
				phase: rawPhase === "post" ? "post" : "pre",
				summary: summaryLine(summary),
			},
		];
	}

	const text = firstString(record.text, record.message, record.content, record.delta);
	if (text && (type === "" || type === "message" || type === "assistant" || type === "text")) {
		return [{ kind: "message", text }];
	}

	return [];
}

export const customAdapter: AgentAdapter = {
	runtime: "custom",

	/**
	 * A getter, not a fixed value, and that is not a stylistic choice.
	 *
	 * A plain property is evaluated once when this module is first imported, which
	 * in a long-lived control-plane process is before the environment is necessarily
	 * complete and certainly before any test can arrange one. Reading at access time
	 * is the same discipline `setting()` follows in `src/config.ts`, and for the same
	 * stated reason: a module-level read is captured before anything can change it,
	 * which quietly makes every value the import-time default.
	 *
	 * Falls back to `none` when the agent is unconfigured, because the credential
	 * check is not the right place to report a missing binary — `customAgentSpec`
	 * is, with a reason that names the variable.
	 */
	get credentials(): AgentCredentialSpec {
		const result = customAgentSpec();
		return result.ok ? result.spec.credentials : { mode: "none" };
	},

	/** Also a getter, and defaults to `abandon`. See `customAgentSpec`. */
	get recovery(): "reattach" | "replay" | "abandon" {
		const result = customAgentSpec();
		return result.ok ? result.spec.recovery : "abandon";
	},

	/**
	 * Throws `CustomAgentConfigError` when the template is unusable.
	 *
	 * The interface requires a return value here, so a misconfiguration has nowhere
	 * to go but an exception — which is why `customAgentSpec()` is exported and is
	 * meant to be called at admission time, before a sandbox is paid for. This throw
	 * is the backstop for the path that skipped it, and it carries the same typed
	 * reason so the message the user sees is identical either way.
	 */
	command(request: AgentTurnRequest) {
		const spec = requireSpec();

		const args: string[] = [];
		if (request.resume_token && spec.resumeTemplate.length > 0) {
			args.push(...substitute(spec.resumeTemplate, "{resume_token}", request.resume_token));
		}
		args.push(...substitute(spec.argsTemplate, "{prompt}", request.body));

		// `{model}` is substituted wherever the operator put it and left alone when
		// they did not, rather than appended as `--model`. Harbor has no idea what
		// flag this binary uses, and inventing one produces an argument the agent
		// rejects — a turn that fails on argument parsing rather than on the work.
		const withModel = substitute(args, "{model}", request.model ?? "");
		const withWorkspace = substitute(withModel, "{workspace}", request.workspace);

		return { bin: spec.bin, args: withWorkspace, env: baseEnv(request) };
	},

	parseLine(line: string): AgentStreamEvent[] {
		const result = customAgentSpec();
		// An unconfigured custom agent has no stdout to read, but `parseLine` is
		// reachable from a stream that outlives a configuration change. Returning
		// nothing beats throwing inside a stream reader, which would kill a turn over
		// a variable that was edited while it ran.
		const format: CustomStreamFormat = result.ok ? result.spec.format : "text";

		const cleaned = stripAnsi(line).trim();
		if (!cleaned) return [];

		switch (format) {
			case "jsonl": {
				const record = parseJsonLine(cleaned);
				return record ? jsonlEvents(record) : [];
			}
			case "text":
				return [{ kind: "message", text: cleaned }];
		}
		// No `default` branch: adding a third stream format must fail the build here
		// rather than silently fall through to whichever branch came last.
		return assertNever(format, "CustomStreamFormat in parseLine");
	},

	interrupt(interrupt: AgentInterrupt): NodeJS.Signals {
		return signalFor(interrupt);
	},

	/**
	 * Recover a resume token only if the operator told us how.
	 *
	 * There is no guessing here at all — no scanning for anything that looks like a
	 * UUID, no reading the last line. A wrong resume token is worse than none: it
	 * either fails on the next turn or, if the agent is lenient, silently attaches
	 * the user's follow-up to a different conversation. So a missing
	 * `HARBOR_CUSTOM_AGENT_RESUME_PATTERN` means every turn starts fresh, which is
	 * merely limited rather than wrong.
	 *
	 * A pattern that matches nothing returns null, and a pattern that throws while
	 * matching returns null too: this runs after the agent has already finished its
	 * work, and turning a completed turn into a failed one over a bad regex would
	 * discard a diff that is sitting on disk.
	 */
	resumeTokenFrom(stdout: string, _workspace: string): string | null {
		const result = customAgentSpec();
		if (!result.ok || !result.spec.resumePattern) return null;
		try {
			const match = result.spec.resumePattern.exec(stdout);
			if (!match) return null;
			const captured = match[1] ?? match[0];
			return captured.trim() === "" ? null : captured;
		} catch {
			return null;
		}
	},
};
