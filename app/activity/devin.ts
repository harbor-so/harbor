// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Devin is a cloud agent, and that makes its activity coarser than every other
 * runtime here. Claude Code, Codex, Cursor and opencode push a hook per tool
 * call, so their feeds carry `pre`/`post` pairs, file paths and per-tool args.
 * Devin exposes none of that: its read API is a message log plus a `status_enum`,
 * so a Devin `tool_call` is always the literal tool `"devin"` and its payload is
 * prose, not a structured tool input. That is honest to what the API gives, and
 * it matches the "deliberately coarse" discipline `ACTIVITY_KINDS` is built on —
 * the fine detail Devin does not expose was never going to be a `kind` explosion.
 *
 * The functions here are pure: a whole Devin session (or one message, or one
 * status pair) in, canonical `NormalizedActivity[]` out — no database, no HTTP.
 * The `devinNormalizer` maps a *whole* session (used by the generic
 * `/api/hooks/devin` route for manual replay), while the poll loop
 * (src/devin/poll.ts) reuses `mapDevinStatusTransition` and `mapDevinMessage`
 * against its stored cursor so a tick emits only what is new. Same mapping, two
 * callers — the poller is the authoritative one, the endpoint is for replay.
 */

import { clip, isRecord, type ActivityNormalizer, type NormalizedActivity } from "./types.js";

/**
 * The `status_enum` values that mean a session is over. The poll loop also
 * excludes an internal `expired` (set when a session stops being reachable), but
 * that is a Harbor state, not one Devin reports, so it lives with the poller.
 */
export const DEVIN_TERMINAL_STATUSES = ["finished", "suspended"] as const;

/** Devin reports these when the session is alive but not making progress. */
const DEVIN_WAITING_STATUSES = ["blocked", "waiting_for_user", "waiting_for_approval"] as const;

function isTerminal(status: string): boolean {
	return (DEVIN_TERMINAL_STATUSES as readonly string[]).includes(status);
}

function isWaiting(status: string): boolean {
	return (DEVIN_WAITING_STATUSES as readonly string[]).includes(status);
}

/** True when a message came from the human, false when it is Devin's own output. */
function isUserMessage(msg: Record<string, unknown>): boolean {
	const role = [msg.type, msg.role, msg.origin, msg.sender].find(
		(value): value is string => typeof value === "string",
	);
	if (!role) return false;
	const lowered = role.toLowerCase();
	// Devin's own narration is the common case; only an explicit user marker flips
	// the row to a prompt. "user_message", "user", "human" all read as the human.
	return lowered.includes("user") || lowered.includes("human");
}

/** The prose body of a Devin message, under whatever key this payload used. */
function messageText(msg: Record<string, unknown>): string | undefined {
	const raw = [msg.message, msg.content, msg.text, msg.body].find(
		(value): value is string => typeof value === "string",
	);
	return clip(raw, 2000);
}

/**
 * One Devin message → one canonical row.
 *
 * A user message is a `prompt`; Devin's own message is a coarse `tool_call` with
 * the literal tool `"devin"`, because the API does not say which tool it ran —
 * only that it acted and what it said about it.
 */
export function mapDevinMessage(msg: unknown, sessionId: string): NormalizedActivity {
	const record = isRecord(msg) ? msg : {};
	const text = messageText(record);
	if (isUserMessage(record)) {
		return {
			kind: "prompt",
			runtimeSessionId: sessionId,
			payload: text ? { text } : {},
		};
	}
	return {
		kind: "tool_call",
		tool: "devin",
		phase: "post",
		runtimeSessionId: sessionId,
		payload: text ? { output: text } : {},
	};
}

/**
 * A `status_enum` change → the lifecycle rows it implies (0, 1 or 2).
 *
 * `prev === undefined` is the first time Harbor sees the session, so it opens with
 * a `session_start`; a first observation that is already terminal therefore yields
 * both a start and an end. A move into a waiting state is a `stop` (Devin is idle,
 * exactly like opencode's `session.idle`); a move into a terminal state is a
 * `session_end`. A resume back to `working` is deliberately silent — it is noise,
 * not an event worth a row.
 */
export function mapDevinStatusTransition(
	prev: string | undefined,
	next: string,
	sessionId: string,
	structuredOutput?: unknown,
): NormalizedActivity[] {
	if (prev === next) return [];

	const rows: NormalizedActivity[] = [];
	if (prev === undefined) {
		rows.push({ kind: "session_start", runtimeSessionId: sessionId, payload: { status_enum: next } });
	}

	if (isTerminal(next)) {
		const payload: Record<string, unknown> =
			next === "finished" && structuredOutput !== undefined
				? { status_enum: next, structured_output: structuredOutput }
				: { status_enum: next };
		rows.push({ kind: "session_end", runtimeSessionId: sessionId, payload });
	} else if (isWaiting(next)) {
		rows.push({ kind: "stop", runtimeSessionId: sessionId, payload: { status_enum: next } });
	}

	return rows;
}

/** The subset of a Devin session this normalizer reads. */
interface DevinSessionShape {
	session_id?: unknown;
	status_enum?: unknown;
	status?: unknown;
	messages?: unknown;
	structured_output?: unknown;
}

/** The `status_enum` Devin reports, falling back to the coarser `status`. */
export function devinStatusOf(session: DevinSessionShape): string | undefined {
	if (typeof session.status_enum === "string") return session.status_enum;
	if (typeof session.status === "string") return session.status;
	return undefined;
}

/**
 * A whole Devin session → its full activity, start to (if reached) end. Stateless
 * by design: the endpoint replays an entire session, the poller does the
 * incremental version itself with the helpers above.
 */
function normalize(payload: unknown): NormalizedActivity[] {
	if (!isRecord(payload)) return [];
	const sessionId =
		typeof payload.session_id === "string" ? payload.session_id : undefined;
	if (!sessionId) return [];

	const status = devinStatusOf(payload);
	const rows: NormalizedActivity[] = [];
	if (status) {
		rows.push(...mapDevinStatusTransition(undefined, status, sessionId, payload.structured_output));
	}
	const messages = Array.isArray(payload.messages) ? payload.messages : [];
	// A start bookends the session, so put the messages between the start row and
	// any terminal row rather than after both.
	const startRow = status ? rows.shift() : undefined;
	const messageRows = messages.map((msg) => mapDevinMessage(msg, sessionId));
	return [...(startRow ? [startRow] : []), ...messageRows, ...rows];
}

export const devinNormalizer: ActivityNormalizer = {
	runtime: "devin",
	normalize,
};
