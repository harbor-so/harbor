// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The provider boundary for activity ingest, kept as small as the connector one.
 *
 * A normalizer turns one host's raw hook payload into Harbor's canonical
 * `NormalizedActivity` rows and nothing else — no database, no auth, no HTTP. That
 * split is what makes it testable with a captured payload and a plain assertion,
 * and it is why the ingest route can stay a thin adapter over `recordActivity`.
 */

import type { ActivityKind } from "../../core/schema/schema.js";

/** Context the route knows that the raw payload may not carry itself. */
export interface NormalizeContext {
	/**
	 * The hook event, when the host cannot name it in its own payload. Command-hook
	 * tools (Codex, Cursor) run one script per event, so the wiring passes the event
	 * as a query param rather than the model having to infer it.
	 */
	event?: string;
	/** A caller-supplied stable agent id, e.g. from `HARBOR_AGENT_ID`. */
	agent?: string;
}

/**
 * One canonical activity row, before it is scoped to an org and written.
 *
 * `agentId` is optional here: most hosts do not know Harbor's agent-id convention,
 * so `recordActivity` derives `${runtime}:${runtimeSessionId}` when a normalizer
 * cannot supply one.
 */
export interface NormalizedActivity {
	kind: ActivityKind;
	tool?: string;
	phase?: "pre" | "post";
	runtimeSessionId?: string;
	agentId?: string;
	payload?: Record<string, unknown>;
}

export interface ActivityNormalizer {
	/** Canonical runtime label this normalizer parses for. */
	runtime: string;
	normalize(payload: unknown, ctx?: NormalizeContext): NormalizedActivity[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Cap a string so a single command or output can never dominate the row. */
export function clip(value: unknown, max = 2000): string | undefined {
	if (typeof value !== "string") return undefined;
	if (value.length <= max) return value;
	return `${value.slice(0, max)}… (+${value.length - max} chars)`;
}

/** The agent id a payload explicitly carries, if a forwarder injected one. */
export function explicitAgentId(payload: Record<string, unknown>, ctx?: NormalizeContext): string | undefined {
	const fromPayload = payload.harbor_agent_id;
	if (typeof fromPayload === "string" && fromPayload.trim()) return fromPayload.trim();
	if (ctx?.agent?.trim()) return ctx.agent.trim();
	return undefined;
}

/**
 * Pull a small, bounded summary out of a tool's input/output.
 *
 * The goal is a row a human can scan — the command that ran, the file touched,
 * how long it took — not a transcript. Everything here is best-effort: an unknown
 * tool shape simply yields fewer fields rather than an error.
 */
export function summarizeTool(input: unknown, output: unknown): Record<string, unknown> {
	const summary: Record<string, unknown> = {};
	if (isRecord(input)) {
		const command = clip(input.command, 2000);
		if (command) summary.command = command;
		const filePath = input.file_path ?? input.path ?? input.filePath;
		if (typeof filePath === "string") summary.file_path = filePath;
		if (typeof input.url === "string") summary.url = input.url;
		if (typeof input.pattern === "string") summary.pattern = input.pattern;
	}
	if (typeof output === "string") {
		const clipped = clip(output, 2000);
		if (clipped) summary.output = clipped;
	} else if (isRecord(output)) {
		const text = output.stdout ?? output.output ?? output.result ?? output.content;
		const clipped = clip(text, 2000);
		if (clipped) summary.output = clipped;
	}
	return summary;
}
