// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The loop that drives sessions forward, and why it is a loop of one-shot calls.
 *
 * `runSessionTurn` deliberately returns after at most one prompt rather than
 * looping internally. This file is the caller that decides the cadence, and
 * keeping the two separate is what makes the property that matters testable:
 * what two runners do to each other. A function that loops internally can only be
 * tested by racing two of them and hoping the interleaving you care about occurs.
 *
 * Safe on every replica. `runSessionTurn` takes `pg_try_advisory_lock` per
 * session and returns `lock_not_acquired` immediately if another holds it, so
 * replicas cooperate without electing a leader — the same discipline as the
 * automation scheduler, and the reason Harbor has no singleton anywhere.
 */

import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { hostname } from "node:os";
import { db } from "@core/schema/index.js";
import { sessionPrompts, sessions } from "@core/schema/schema.js";
import { defaultSandboxGateway, runSessionTurn } from "./session-runner.js";

/**
 * Identifies this process in the lease it takes, so the dashboard can say *which*
 * runner holds a session rather than "a runner". On one box that is noise; across
 * a fleet during an incident it is the difference between a two-minute diagnosis
 * and an hour.
 */
function runnerLabel(): string {
	return `${hostname()}:${process.pid}`;
}

/**
 * How many sessions one tick will advance.
 *
 * Bounded so a backlog of two hundred sessions does not turn one tick into a
 * ten-minute blocking operation that starves the next. The unprocessed remainder
 * is picked up on the following tick — sessions are durable and nothing is lost
 * by being slow, whereas a tick that never finishes stops the sweep behind it.
 */
function sessionsPerTick(): number {
	// harbor-lint-allow-constant: a batch size, not a tunable — it trades tick
	// latency against throughput within one process and has no deployment-specific
	// right answer. Raising it does not make a slow provider faster.
	const BATCH = 20;
	return BATCH;
}

/**
 * Advance every session that has queued work.
 *
 * The candidate query is deliberately narrow: sessions with at least one queued
 * prompt, not all open sessions. On a deployment with a thousand archived rooms,
 * scanning all of them every tick to discover that none has work is the query that
 * eventually shows up in a slow-query log and is blamed on Postgres.
 */
export async function tickSessions(now = new Date()): Promise<{
  delivered: number;
  idle: number;
  refused: number;
}> {
	const waiting = await db
		.selectDistinct({ sessionId: sessionPrompts.sessionId, orgId: sessionPrompts.orgId })
		.from(sessionPrompts)
		.innerJoin(sessions, eq(sessions.id, sessionPrompts.sessionId))
		.where(
			and(
				eq(sessionPrompts.status, "queued"),
				// A paused session keeps its queue — the prompts are not lost — but does
				// not consume it. Pausing is how a budget breach and a human stop button
				// both stop work without discarding what people typed.
				isNull(sessions.pausedReason),
			),
		)
		.limit(sessionsPerTick());

	let delivered = 0;
	let idle = 0;
	let refused = 0;

	for (const row of waiting) {
		try {
			const outcome = await runSessionTurn({
				orgId: row.orgId,
				sessionId: row.sessionId,
				agentId: runnerLabel(),
				gateway: defaultSandboxGateway(),
				now,
			});

			switch (outcome.kind) {
				case "delivered":
					delivered += 1;
					break;
				case "idle":
					idle += 1;
					break;
				case "refused":
					refused += 1;
					// Refusals are logged individually rather than counted silently. Each
					// one names a specific, actionable condition — the circuit is open, the
					// budget is exhausted, the lease is held elsewhere — and a count tells
					// an operator that something is wrong without telling them what.
					console.error(
						`[sessions] ${row.sessionId} refused: ${outcome.reason}`,
					);
					break;
			}
		} catch (error) {
			// One session's failure must not stop the batch. The alternative — letting
			// it throw — means a single wedged session halts every other session in the
			// deployment, and the symptom is "Harbor stopped working" rather than "one
			// session is broken".
			refused += 1;
			console.error(`[sessions] ${row.sessionId} threw:`, error);
		}
	}

	return { delivered, idle, refused };
}
