// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Cursor (1.7+) has its own hook vocabulary: camelCase event names, and a
 * separate hook per shell / file / MCP action rather than one generic tool event.
 * Its hooks run commands only, so the shared forwarder curls the stdin JSON with
 * the event as a `?event=` query param — the payload itself does not always name
 * the event that fired.
 */

import type { ActivityKind } from "../../core/schema/schema.js";
import {
	clip,
	explicitAgentId,
	isRecord,
	summarizeTool,
	type ActivityNormalizer,
	type NormalizeContext,
	type NormalizedActivity,
} from "./types.js";

interface CursorMap {
	kind: ActivityKind;
	phase?: "pre" | "post";
	/** A synthetic tool name for events that are implicitly one tool. */
	tool?: string;
}

function classify(event: string): CursorMap | null {
	switch (event) {
		case "preToolUse":
			return { kind: "tool_call", phase: "pre" };
		case "postToolUse":
		case "postToolUseFailure":
			return { kind: "tool_call", phase: "post" };
		case "beforeShellExecution":
			return { kind: "tool_call", phase: "pre", tool: "shell" };
		case "afterShellExecution":
			return { kind: "tool_call", phase: "post", tool: "shell" };
		case "beforeMCPExecution":
			return { kind: "tool_call", phase: "pre" };
		case "afterMCPExecution":
			return { kind: "tool_call", phase: "post" };
		case "beforeReadFile":
			return { kind: "tool_call", phase: "pre", tool: "read" };
		case "afterFileEdit":
			return { kind: "tool_call", phase: "post", tool: "edit" };
		case "beforeSubmitPrompt":
			return { kind: "prompt" };
		case "subagentStart":
		case "subagentStop":
			return { kind: "subagent" };
		case "sessionStart":
			return { kind: "session_start" };
		case "sessionEnd":
			return { kind: "session_end" };
		case "stop":
			return { kind: "stop" };
		default:
			return null;
	}
}

function normalize(payload: unknown, ctx?: NormalizeContext): NormalizedActivity[] {
	if (!isRecord(payload)) return [];

	const event =
		ctx?.event ?? (typeof payload.hook_event_name === "string" ? payload.hook_event_name : undefined);
	if (!event) return [];

	const mapped = classify(event);
	if (!mapped) return [];

	const runtimeSessionId =
		typeof payload.session_id === "string" ? payload.session_id : undefined;

	const summary: Record<string, unknown> = {};
	if (typeof payload.cwd === "string") summary.cwd = payload.cwd;
	if (typeof payload.duration === "number") summary.duration_ms = payload.duration;
	if (typeof payload.file_path === "string") summary.file_path = payload.file_path;
	if (typeof payload.command === "string") {
		const command = clip(payload.command, 2000);
		if (command) summary.command = command;
	}
	Object.assign(summary, summarizeTool(payload.tool_input, payload.tool_output));
	if (Array.isArray(payload.edits)) summary.edits = payload.edits.length;
	const prompt = clip(payload.prompt, 1000);
	if (mapped.kind === "prompt" && prompt) summary.prompt = prompt;

	return [
		{
			kind: mapped.kind,
			phase: mapped.phase,
			tool: (typeof payload.tool_name === "string" ? payload.tool_name : undefined) ?? mapped.tool,
			runtimeSessionId,
			agentId: explicitAgentId(payload, ctx),
			payload: summary,
		},
	];
}

export const cursorNormalizer: ActivityNormalizer = {
	runtime: "cursor",
	normalize,
};
