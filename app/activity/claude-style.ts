// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Claude Code and Codex speak the same hook dialect.
 *
 * Both name events `PreToolUse`/`PostToolUse`/`SessionStart`/… and put the tool
 * name in `tool_name` with input in `tool_input`. Rather than maintain two copies
 * that drift, both normalizers delegate here; the only thing that differs between
 * the two hosts is the `runtime` label the route stamps on, which this function
 * never sees.
 */

import type { ActivityKind } from "../../core/schema/schema.js";
import {
	clip,
	explicitAgentId,
	isRecord,
	summarizeTool,
	type NormalizeContext,
	type NormalizedActivity,
} from "./types.js";

/** Map a PascalCase hook event to a canonical (kind, phase). Null = ignore. */
function classify(event: string): { kind: ActivityKind; phase?: "pre" | "post" } | null {
	switch (event) {
		case "PreToolUse":
		case "PermissionRequest":
			return { kind: "tool_call", phase: "pre" };
		case "PostToolUse":
		case "PostToolUseFailure":
		case "PostToolBatch":
			return { kind: "tool_call", phase: "post" };
		case "SessionStart":
			return { kind: "session_start" };
		case "SessionEnd":
			return { kind: "session_end" };
		case "Stop":
		case "StopFailure":
			return { kind: "stop" };
		case "SubagentStart":
		case "SubagentStop":
			return { kind: "subagent" };
		case "UserPromptSubmit":
			return { kind: "prompt" };
		default:
			// Unknown / observability-only events (FileChanged, Notification, …) are
			// dropped rather than stored as junk. Harbor tracks what an agent did, not
			// every signal its host can emit.
			return null;
	}
}

export function normalizeClaudeStyle(payload: unknown, ctx?: NormalizeContext): NormalizedActivity[] {
	if (!isRecord(payload)) return [];

	const event =
		(typeof payload.hook_event_name === "string" ? payload.hook_event_name : undefined) ??
		ctx?.event;
	if (!event) return [];

	const classified = classify(event);
	if (!classified) return [];

	const runtimeSessionId =
		typeof payload.session_id === "string" ? payload.session_id : undefined;
	const agentId = explicitAgentId(payload, ctx);

	const summary: Record<string, unknown> = {};
	if (typeof payload.cwd === "string") summary.cwd = payload.cwd;
	if (typeof payload.permission_mode === "string") summary.permission_mode = payload.permission_mode;

	if (classified.kind === "tool_call") {
		Object.assign(summary, summarizeTool(payload.tool_input, payload.tool_output ?? payload.tool_response));
		const error = clip(payload.error ?? payload.error_message, 1000);
		if (error) summary.error = error;
	} else if (classified.kind === "prompt") {
		const prompt = clip(payload.prompt, 1000);
		if (prompt) summary.prompt = prompt;
	} else if (classified.kind === "session_start") {
		if (typeof payload.source === "string") summary.source = payload.source;
	} else if (classified.kind === "stop") {
		if (typeof payload.status === "string") summary.status = payload.status;
	} else if (classified.kind === "subagent") {
		if (typeof payload.agent_type === "string") summary.agent_type = payload.agent_type;
	}

	return [
		{
			kind: classified.kind,
			phase: classified.phase,
			tool: typeof payload.tool_name === "string" ? payload.tool_name : undefined,
			runtimeSessionId,
			agentId,
			payload: summary,
		},
	];
}
