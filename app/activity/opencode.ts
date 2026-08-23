// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * opencode plugins are JS/TS and can `fetch()` directly, so the plugin does the
 * posting itself and controls the body. It sends the opencode event name plus the
 * `(input, output)` fields those hooks receive; this normalizer maps that small,
 * plugin-defined shape onto Harbor's canonical rows.
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

function classify(event: string): { kind: ActivityKind; phase?: "pre" | "post" } | null {
	switch (event) {
		case "tool.execute.before":
			return { kind: "tool_call", phase: "pre" };
		case "tool.execute.after":
			return { kind: "tool_call", phase: "post" };
		case "session.created":
			return { kind: "session_start" };
		case "session.idle":
			return { kind: "stop" };
		case "session.deleted":
			return { kind: "session_end" };
		default:
			return null;
	}
}

function normalize(payload: unknown, ctx?: NormalizeContext): NormalizedActivity[] {
	if (!isRecord(payload)) return [];

	const event =
		(typeof payload.event === "string" ? payload.event : undefined) ?? ctx?.event;
	if (!event) return [];

	const mapped = classify(event);
	if (!mapped) return [];

	const runtimeSessionId =
		(typeof payload.sessionID === "string" ? payload.sessionID : undefined) ??
		(typeof payload.session_id === "string" ? payload.session_id : undefined);

	const summary: Record<string, unknown> = {};
	if (typeof payload.directory === "string") summary.cwd = payload.directory;
	Object.assign(summary, summarizeTool(payload.args ?? payload.tool_input, payload.output));
	const error = clip(payload.error, 1000);
	if (error) summary.error = error;

	return [
		{
			kind: mapped.kind,
			phase: mapped.phase,
			tool: typeof payload.tool === "string" ? payload.tool : undefined,
			runtimeSessionId,
			agentId: explicitAgentId(payload, ctx),
			payload: summary,
		},
	];
}

export const opencodeNormalizer: ActivityNormalizer = {
	runtime: "opencode",
	normalize,
};
