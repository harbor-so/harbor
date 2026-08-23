// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The one write path for passively-captured tool calls.
 *
 * Mirrors the split in `work.ts`: this holds the logic, the API route above is a
 * thin adapter that authenticates and parses. Three things happen here and the
 * order matters only for the first:
 *
 *   1. Every row is scoped to an org and given an agent id — either one a
 *      forwarder supplied, or the derived `${runtime}:${sessionId}` fallback, so a
 *      host that knows nothing about Harbor's naming still produces a stable
 *      identity.
 *   2. Each agent's rows are linked to the task it currently holds a claim on, so
 *      a `Bash` call lines up with the work it happened under. Best-effort: an
 *      agent with no active claim simply has null `taskId`.
 *   3. Presence and the live feed are touched, so activity lights up the dashboard
 *      the same way a claim does — reusing the machinery in `work.ts` rather than
 *      inventing a second one.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import { setting } from "@core/kernel/config.js";
import { db } from "@core/schema/index.js";
import { activity, claims, tasks } from "@core/schema/schema.js";
import type { NormalizedActivity } from "../activity/types.js";
import { notifyChange, touchPresence } from "@core/kernel/work.js";

function boundPayload(payload: Record<string, unknown> | undefined): Record<string, unknown> | null {
	if (!payload) return null;
	// A single row's payload can never grow the table into a log pipeline.
	// Normalizers already clip individual strings; this is the backstop for a
	// pathological payload that is wide rather than deep — many small fields —
	// which no per-field cap sees.
	const cap = setting("maxActivityPayloadChars");
	const serialized = JSON.stringify(payload);
	if (serialized.length <= cap) return payload;
	return { truncated: true, preview: `${serialized.slice(0, cap)}…` };
}

/** A short human label for presence, e.g. "tool_call:Bash" or "session_start". */
function actionLabel(row: NormalizedActivity): string {
	return row.tool ? `${row.kind}:${row.tool}` : row.kind;
}

export interface RecordActivityResult {
	recorded: number;
}

export async function recordActivity(
	orgId: string,
	runtime: string,
	rows: NormalizedActivity[],
): Promise<RecordActivityResult> {
	if (rows.length === 0) return { recorded: 0 };

	const now = new Date();

	// Resolve every distinct agent id first, then map each to its active claim in a
	// single query rather than one lookup per row.
	const withAgent = rows.map((row) => ({
		row,
		agentId: row.agentId?.trim() || `${runtime}:${row.runtimeSessionId ?? "unknown"}`,
	}));
	const agentIds = [...new Set(withAgent.map((r) => r.agentId))];

	const activeClaims = await db
		.select({ agentId: claims.agentId, taskId: claims.taskId })
		.from(claims)
		.innerJoin(tasks, eq(claims.taskId, tasks.id))
		.where(
			and(eq(tasks.orgId, orgId), isNull(claims.releasedAt), inArray(claims.agentId, agentIds)),
		);
	const taskByAgent = new Map(activeClaims.map((c) => [c.agentId, c.taskId]));

	await db.insert(activity).values(
		withAgent.map(({ row, agentId }) => ({
			orgId,
			agentId,
			taskId: taskByAgent.get(agentId) ?? null,
			runtime,
			runtimeSessionId: row.runtimeSessionId ?? null,
			kind: row.kind,
			tool: row.tool ?? null,
			phase: row.phase ?? null,
			payload: boundPayload(row.payload),
			createdAt: now,
		})),
	);

	// Presence once per agent, keyed to its last row in this batch. Failures inside
	// touchPresence are already swallowed there; presence must never be why an
	// ingest 500s.
	const lastByAgent = new Map<string, NormalizedActivity>();
	for (const { row, agentId } of withAgent) lastByAgent.set(agentId, row);
	for (const [agentId, row] of lastByAgent) {
		await touchPresence(orgId, agentId, actionLabel(row), taskByAgent.get(agentId) ?? undefined);
	}
	await notifyChange(orgId, "activity");

	return { recorded: withAgent.length };
}
