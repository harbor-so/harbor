// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The pull side of Devin tracking.
 *
 * Every other runtime pushes hooks; Devin has none, so this loop GETs each
 * tracked session and turns what changed since the last poll into the same
 * `activity` rows a hook would have produced. Three properties, each a deliberate
 * choice:
 *
 * **One replica polls, not all of them.** Like `tickAutomations`, the tick takes a
 * single Postgres advisory lock on a constant. Without it every replica would poll
 * every session on every interval, multiplying calls to a rate-limited third-party
 * API by the replica count for no benefit.
 *
 * **A session is polled only when something changed.** Devin's `updated_at` is the
 * cursor: an unchanged value means the tick does nothing but bump `lastPolledAt`.
 * An idle session that runs for an hour therefore costs one cheap GET per interval,
 * not a re-ingest of its whole message log every time.
 *
 * **The cursor advances AFTER the write, not before.** This is the opposite of
 * `tickAutomations`, and on purpose: there, advancing after a crash re-fires an
 * expensive sandbox spawn, so it advances first and eats a skipped run. Here a
 * crash between the write and the cursor update re-ingests a handful of cheap feed
 * rows — an at-least-once duplicate — whereas advancing first would leave a
 * permanent hole in the activity timeline. A duplicate row is cheaper than a hole.
 */

import { eq, notInArray, sql as raw } from "drizzle-orm";
import { setting } from "@core/kernel/config.js";
import { db } from "@core/schema/index.js";
import { artifacts, devinSessions } from "@core/schema/schema.js";
import { recordActivity } from "../lib/activity.js";
import { globalLock, withLock } from "@core/kernel/locks.js";
import type { NormalizedActivity } from "../activity/types.js";
import {
	DEVIN_TERMINAL_STATUSES,
	devinStatusOf,
	mapDevinMessage,
	mapDevinStatusTransition,
} from "../activity/devin.js";
import { DevinApiError, getDevinSession, type DevinSession } from "./client.js";
import { devinTokenFor } from "./token.js";

/** The `status` values excluded from the poll set: Devin's terminal states plus
 *  the `expired` we set when a session stops being reachable. */
const POLL_EXCLUDED_STATUSES = [...DEVIN_TERMINAL_STATUSES, "expired"] as const;

export interface DevinPollResult {
	/** Sessions fetched and diffed this tick. */
	polled: number;
	/** Sessions short-circuited (nothing changed) or skipped (no token). */
	skipped: number;
	/** Activity rows written this tick. */
	recorded: number;
	/** Sessions that reached a terminal or expired state this tick. */
	finished: number;
}

const EMPTY: DevinPollResult = { polled: 0, skipped: 0, recorded: 0, finished: 0 };

/**
 * One tick. Safe to call from every replica: only the lock-holder does work.
 *
 * A lost race is not a failure and not a retry — the replica that holds the lock
 * is doing the work, so returning EMPTY is the honest answer. See
 * `src/lib/locks.ts` for why the lock is taken on a reserved connection.
 */
export async function tickDevinPoll(now = new Date()): Promise<DevinPollResult> {
	const outcome = await withLock(globalLock("harbor:devin-poll"), () => runDuePolls(now));
	return outcome.acquired ? outcome.result : EMPTY;
}

async function runDuePolls(now: Date): Promise<DevinPollResult> {
	const due = await db
		.select()
		.from(devinSessions)
		.where(notInArray(devinSessions.status, POLL_EXCLUDED_STATUSES as unknown as string[]))
		// Oldest-polled first, never-polled before that, so a batch rotates fairly
		// and a backlog larger than the cap drains over successive ticks.
		.orderBy(raw`${devinSessions.lastPolledAt} asc nulls first`)
		.limit(setting("devinPollMaxPerTick"));

	const result: DevinPollResult = { ...EMPTY };
	// One token lookup per org, not per session — a busy org has many sessions.
	const tokenByOrg = new Map<string, string | null>();

	for (const row of due) {
		try {
			const outcome = await pollOne(row, now, tokenByOrg);
			result.polled += outcome.polled;
			result.skipped += outcome.skipped;
			result.recorded += outcome.recorded;
			result.finished += outcome.finished;
		} catch (error) {
			// One unreachable or malformed session must not abort the batch: log it,
			// bump its cursor so it rotates to the back, and keep going.
			console.error(`[devin] poll failed for session ${row.devinSessionId}:`, error);
			await bumpPolled(row.id, now);
			result.skipped += 1;
		}
	}

	return result;
}

async function tokenFor(
	orgId: string,
	cache: Map<string, string | null>,
): Promise<string | null> {
	if (cache.has(orgId)) return cache.get(orgId) ?? null;
	const token = await devinTokenFor(orgId);
	cache.set(orgId, token);
	return token;
}

async function pollOne(
	row: typeof devinSessions.$inferSelect,
	now: Date,
	tokenByOrg: Map<string, string | null>,
): Promise<DevinPollResult> {
	const token = await tokenFor(row.orgId, tokenByOrg);
	if (!token) {
		// No credential for this org. Bump the cursor so this row does not starve the
		// rest of the batch by sitting at the front of the queue every tick.
		console.warn(`[devin] no API token for org ${row.orgId}; skipping session ${row.devinSessionId}.`);
		await bumpPolled(row.id, now);
		return { ...EMPTY, skipped: 1 };
	}

	let session: DevinSession;
	try {
		session = await getDevinSession(token, row.devinSessionId);
	} catch (error) {
		if (error instanceof DevinApiError && error.isPermanent) {
			// Deleted session or revoked token: retrying forever is pointless, so drop
			// it out of the poll set. The row is kept for its PR-artifact provenance.
			await db
				.update(devinSessions)
				.set({ status: "expired", lastPolledAt: now })
				.where(eq(devinSessions.id, row.id));
			return { ...EMPTY, skipped: 1, finished: 1 };
		}
		throw error;
	}

	const remoteUpdatedAt = session.updated_at ? new Date(session.updated_at) : null;
	const unchanged =
		remoteUpdatedAt !== null &&
		row.lastUpdatedAt !== null &&
		remoteUpdatedAt.getTime() === row.lastUpdatedAt.getTime();
	if (unchanged) {
		await bumpPolled(row.id, now);
		return { ...EMPTY, skipped: 1 };
	}

	const status = devinStatusOf(session);
	const messages = Array.isArray(session.messages) ? session.messages : [];
	const newMessages = messages.slice(row.lastMessageCount);

	// A start row bookends before the messages; a stop/end row after them.
	const transitions = status
		? mapDevinStatusTransition(row.lastStatus ?? undefined, status, row.devinSessionId, session.structured_output)
		: [];
	const starts = transitions.filter((r) => r.kind === "session_start");
	const ends = transitions.filter((r) => r.kind !== "session_start");
	const rows: NormalizedActivity[] = [
		...starts,
		...newMessages.map((msg) => mapDevinMessage(msg, row.devinSessionId)),
		...ends,
	];

	let recorded = 0;
	if (rows.length > 0) {
		const { recorded: n } = await recordActivity(row.orgId, "devin", rows);
		recorded = n;
	}

	const pr = await recordPullRequest(row, session);

	const terminal = status ? (POLL_EXCLUDED_STATUSES as readonly string[]).includes(status) : false;
	await db
		.update(devinSessions)
		.set({
			lastMessageCount: messages.length,
			lastStatus: status ?? row.lastStatus,
			lastUpdatedAt: remoteUpdatedAt ?? row.lastUpdatedAt,
			lastPolledAt: now,
			status: status ?? row.status,
			prUrl: pr?.url ?? row.prUrl,
			prArtifactId: pr?.artifactId ?? row.prArtifactId,
		})
		.where(eq(devinSessions.id, row.id));

	return { polled: 1, skipped: 0, recorded, finished: terminal ? 1 : 0 };
}

/**
 * Record the session's pull request as an artifact, once.
 *
 * The URL must be the SCM web URL (GitHub's `html_url`), because that is the join
 * key the source-control webhook uses to stamp `merged_at` via
 * `markPullRequestMerged`. The poller deliberately never sets `merged_at` itself:
 * merged is a fact only a verified webhook may write, so recording the artifact is
 * all this does — the existing GitHub connector marks it merged for free, and the
 * merged-PR metric then counts a Devin session exactly like an in-house one.
 */
async function recordPullRequest(
	row: typeof devinSessions.$inferSelect,
	session: DevinSession,
): Promise<{ artifactId: string; url: string } | null> {
	const url = session.pull_request?.url;
	if (!url || row.prArtifactId || !row.sessionId) return null;

	const [artifact] = await db
		.insert(artifacts)
		.values({
			orgId: row.orgId,
			sessionId: row.sessionId,
			kind: "pull_request",
			title: session.pull_request?.title ?? "Devin pull request",
			url,
			payload: { devinSessionId: row.devinSessionId, structured_output: session.structured_output },
		})
		.returning({ id: artifacts.id });

	return artifact ? { artifactId: artifact.id, url } : null;
}

/** Advance only the poll timestamp — the no-op cursor move for a skip. */
async function bumpPolled(id: string, now: Date): Promise<void> {
	await db.update(devinSessions).set({ lastPolledAt: now }).where(eq(devinSessions.id, id));
}
