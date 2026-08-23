// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The record shape a verifier layer will write to — and nothing more.
 *
 * This file deliberately does NOT verify anything. There is no verifier here, no
 * test runner, no policy engine. The autonomy ramp that decides when an agent may
 * proceed without review is, later, a query over the pass/fail history of each
 * scope — and a query has nothing to read until the history exists. So the record
 * is defined and started accumulating now, from the one producer that exists (the
 * `stop` hook, recording whether a session ended cleanly), while the thing that
 * consumes it is still unbuilt.
 *
 * What this file refuses to do: invent a verifier, or let `verifierHistory` become
 * load-bearing before there is a real verifier feeding it. It returns numbers;
 * nothing acts on them yet, and that is on purpose.
 */

import { and, desc, eq, gte, sql as raw } from "drizzle-orm";
import { db } from "@core/schema/index.js";
import { events } from "@core/schema/schema.js";

/**
 * Closed set. A verifier either passed, failed, or could not run — there is no
 * fourth outcome, and a caller inventing one is a change every reader must see.
 */
export const VERIFIER_RESULTS = ["pass", "fail", "unavailable"] as const;
export type VerifierResult = (typeof VERIFIER_RESULTS)[number];

export interface VerifierOutcome {
	orgId: string;
	/** The lease the verified work was done under. */
	leaseId: string;
	/** The scope of that lease, denormalised so history queries never join claims. */
	scope: string;
	/** Which verifier ran — a test suite name, a linter, "session-clean-exit". */
	verifier: string;
	result: VerifierResult;
	/** How long the verifier took, milliseconds. */
	durationMs: number;
	/** Anything the verifier wants to keep: failing tests, an exit code, a diff. */
	details?: Record<string, unknown>;
	/** The task, when the lease was over one. */
	taskId?: string | null;
}

/**
 * Persist one verifier outcome as an event.
 *
 * An event, not a table of its own: the outcome is a fact about a moment, the
 * same shape the digest already reads over, and giving it a bespoke table would
 * mean a second migration and a second consumer for no gain the history query
 * cannot get from `events`.
 */
export async function writeVerifierOutcome(outcome: VerifierOutcome): Promise<void> {
	await db.insert(events).values({
		orgId: outcome.orgId,
		taskId: outcome.taskId ?? null,
		agentId: null,
		type: "verifier_outcome",
		payload: {
			leaseId: outcome.leaseId,
			scope: outcome.scope,
			verifier: outcome.verifier,
			result: outcome.result,
			durationMs: outcome.durationMs,
			details: outcome.details ?? {},
		},
	});
}

export interface ScopePassRate {
	scope: string;
	total: number;
	passed: number;
	failed: number;
	unavailable: number;
	/** passed / total, or null when nothing has run for this scope in the window. */
	passRate: number | null;
}

/**
 * The pass rate for one scope over a trailing window.
 *
 * Nothing calls this yet. It exists so the query the autonomy ramp will run is
 * written and tested against real rows before anything depends on its answer.
 */
export async function verifierHistory(
	orgId: string,
	scope: string,
	windowMs: number,
): Promise<ScopePassRate> {
	const cutoff = new Date(Date.now() - windowMs);
	const rows = await db
		.select({ result: raw<string>`${events.payload}->>'result'` })
		.from(events)
		.where(
			and(
				eq(events.orgId, orgId),
				eq(events.type, "verifier_outcome"),
				raw`${events.payload}->>'scope' = ${scope}`,
				gte(events.createdAt, cutoff),
			),
		)
		.orderBy(desc(events.createdAt));

	let passed = 0;
	let failed = 0;
	let unavailable = 0;
	for (const row of rows) {
		// The three known results are counted; anything else is ignored rather than
		// silently folded into a bucket, so a corrupt row cannot skew the rate.
		if (row.result === "pass") passed++;
		else if (row.result === "fail") failed++;
		else if (row.result === "unavailable") unavailable++;
	}
	const total = passed + failed + unavailable;
	return {
		scope,
		total,
		passed,
		failed,
		unavailable,
		passRate: total === 0 ? null : passed / total,
	};
}
