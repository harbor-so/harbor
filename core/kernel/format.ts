// SPDX-License-Identifier: Apache-2.0
/**
 * How Harbor talks to agents.
 *
 * This module is the product's entire value proposition made mechanical.
 * Linear's MCP server exposes ~23 tools over a human-shaped object model —
 * issues, cycles, projects, labels, comments, states — and an agent pays for
 * that schema before it does anything useful. Harbor answers the same question in
 * a handful of lines of text.
 *
 * The rules, each of which is a token decision:
 *
 *   - Line-oriented text, never JSON. Field names are the single largest waste
 *     in a JSON response and they repeat on every row.
 *   - Short public ids (`a1b2`), never UUIDs. A UUID is ~20 tokens an agent has
 *     to carry around and can transpose; a four-character prefix is one.
 *   - Relative times (`22m`), never ISO 8601 — about one token instead of ten,
 *     on a value the model was going to convert to "22 minutes" anyway.
 *   - Say what the agent must decide, and nothing else. A conflict response
 *     names the holder and the expiry because those change what the agent does
 *     next; it does not include the task's description, which does not.
 */

/**
 * The first four characters of a UUID, which is what agents see and type.
 *
 * Collision within one org's open task list is possible in principle and has
 * not mattered in practice at the scale Harbor targets; `resolveTaskId` treats an
 * ambiguous prefix as an error rather than guessing, so the failure mode is a
 * clear message rather than the wrong task being claimed.
 */
export function shortId(uuid: string): string {
	return uuid.replace(/-/g, "").slice(0, 4);
}

/** `45s`, `22m`, `3h`, `2d`. Always one unit — the next one down changes nothing. */
export function relTime(ms: number): string {
	const abs = Math.max(0, ms);
	const seconds = Math.round(abs / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}

/** Collapse whitespace and clamp on a word boundary. */
export function clamp(text: string, maxChars: number): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= maxChars) return collapsed;
	const cut = collapsed.slice(0, maxChars - 1);
	const boundary = cut.lastIndexOf(" ");
	return `${boundary > maxChars * 0.6 ? cut.slice(0, boundary) : cut}…`;
}

export interface TaskLine {
	id: string;
	title: string;
	status: string;
	project?: string | null;
	scope?: string | null;
	source?: string;
	sourceRef?: string | null;
	claim?: { agentId: string; expiresAt: Date; intent?: string } | null;
}

/**
 * One task, one line.
 *
 *   [a1b2] Fix auth token refresh bug — open — project: backend
 *   [c3d4] Add rate limiting — claimed by claude-code:wt-2 (expires in 22m) — project: backend
 *
 * `scope` is appended only when set, because it is the field that tells the next
 * agent whether this work overlaps its own, and omitting it when absent costs
 * nothing.
 */
export function formatTask(task: TaskLine, now: Date = new Date()): string {
	const parts: string[] = [`[${shortId(task.id)}] ${clamp(task.title, 72)}`];

	if (task.claim) {
		const remaining = task.claim.expiresAt.getTime() - now.getTime();
		parts.push(
			remaining > 0
				? `claimed by ${task.claim.agentId} (expires in ${relTime(remaining)})`
				: `claim expired ${relTime(-remaining)} ago — claimable`,
		);
	} else {
		parts.push(task.status);
	}

	// The intent rides on the same line as the holder. It is the field that tells
	// the next agent whether the work in flight overlaps its own, and putting it
	// behind a second call would mean nobody ever reads it.
	if (task.claim?.intent) parts.push(`why: ${clamp(task.claim.intent, 64)}`);
	if (task.project) parts.push(`project: ${task.project}`);
	if (task.scope) parts.push(`scope: ${clamp(task.scope, 48)}`);
	if (task.source && task.source !== "native") {
		parts.push(task.sourceRef ? `${task.source}:${task.sourceRef}` : task.source);
	}

	return parts.join(" — ");
}

/**
 * A task list, with an explicit empty case.
 *
 * "No open work" is a real answer and has to read as one. An empty string would
 * leave an agent guessing whether the call failed, and a guessing agent retries.
 */
export function formatTaskList(tasks: TaskLine[], now: Date = new Date()): string {
	if (tasks.length === 0) return "No tasks match.";
	return tasks.map((task) => formatTask(task, now)).join("\n");
}

/** Rough token count for budget assertions. Four chars per token is close enough. */
export function approxTokens(text: string): number {
	return Math.ceil(text.length / 4);
}
