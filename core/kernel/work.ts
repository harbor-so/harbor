// SPDX-License-Identifier: Apache-2.0
/**
 * The five operations, and the transaction discipline that makes them safe.
 *
 * Everything an agent can do lives here, and the MCP layer above is a thin
 * adapter that parses arguments and formats text. That split is deliberate: the
 * dashboard's REST routes call these same functions, so a task created in the
 * web UI and a task created by an agent go through one code path and cannot
 * diverge.
 *
 * The interesting problem is `claim`, and it is a concurrency problem rather
 * than a business-logic one. Two agents will race, and the only acceptable
 * outcomes are one winner and one informative loser. Harbor does not solve this
 * with a read-then-write check — that has a window between the read and the
 * write in which both agents believe they won. It solves it with a partial
 * unique index in Postgres and by treating the resulting unique violation as
 * the expected path, not an exception to log and swallow.
 */

import { and, desc, eq, gt, gte, inArray, isNull, lt, ne, sql as raw } from "drizzle-orm";
import { setting } from "./config.js";
import { db } from "../schema/index.js";
import { agentPresence, claims, events, projects, sessions, tasks } from "../schema/schema.js";
import type { Task } from "../schema/schema.js";
import type { TaskLine } from "./format.js";
import { publish } from "./bus.js";
import { DEFAULT_RIGHTS } from "./rights.js";
import { linkBaseUrl } from "./urls.js";

export class HarborError extends Error {}

/**
 * The scope a task-backed lease is over.
 *
 * A Linear issue leases its external identity (`linear:ENG-4471`) so that a
 * claim taken here and a claim taken by an agent talking to Linear directly
 * collide on the same key. Everything else — a native task, a GitHub-sourced
 * one — leases its Harbor task id (`harbor:<uuid>`), an opaque atom the exact
 * resolver treats as containing only itself.
 *
 * This is the one place the kernel maps a task to a scope. It never maps the
 * other way: the scope is authoritative for the claim invariant, the task id is
 * a convenience the dashboard joins on.
 */
export function scopeForTask(task: Pick<Task, "id" | "source" | "sourceRef">): string {
	if (task.source === "linear" && task.sourceRef) return `linear:${task.sourceRef}`;
	return `harbor:${task.id}`;
}

function publicBaseUrl(): string {
	return linkBaseUrl();
}

/**
 * How long after its last call an agent still counts as present.
 *
 * Read through `setting()` rather than fixed here, because a deployment whose
 * agents work in long silent stretches needs a wider window and should not have
 * to fork the project to get one. Exported as a function rather than a constant
 * so callers cannot capture a value from before the environment was configured.
 */
export const presenceWindowMs = (): number => setting("presenceWindowMs");

/**
 * Record that an agent is alive, and wake anything listening.
 *
 * Called from the tool layer on every one of the five calls, so presence costs
 * an agent nothing and cannot be forgotten. Failures here are swallowed on
 * purpose: presence is a nicety and must never be the reason a claim fails.
 *
 * The NOTIFY is what makes the dashboard live. Postgres LISTEN/NOTIFY rather
 * than a websocket service or Supabase Realtime because it reuses the one piece
 * of infrastructure Harbor already requires — the same database, the same
 * connection string, nothing new to deploy or pay for — and it keeps working
 * unchanged on hosted Postgres.
 */
export async function touchPresence(
	orgId: string,
	agentId: string,
	action: string,
	taskId?: string,
): Promise<void> {
	try {
		const now = new Date();
		await db
			.insert(agentPresence)
			.values({
				orgId,
				agentId,
				lastSeenAt: now,
				lastAction: action,
				currentTaskId: taskId ?? null,
				firstSeenAt: now,
			})
			.onConflictDoUpdate({
				target: [agentPresence.orgId, agentPresence.agentId],
				set: { lastSeenAt: now, lastAction: action, currentTaskId: taskId ?? null },
			});
		await notifyChange(orgId, action);
	} catch (error) {
		console.error("[presence] ignored:", error);
	}
}

/**
 * Tell listeners something changed in this org.
 *
 * The payload is deliberately just an org id and a verb — never the changed row.
 * NOTIFY payloads are capped at 8000 bytes, and a listener that reads from the
 * database after being woken cannot serve stale or truncated data the way one
 * parsing an embedded row can.
 */
export async function notifyChange(orgId: string, verb: string): Promise<void> {
	try {
		await publish("harbor_changes", JSON.stringify({ orgId, verb }));
	} catch (error) {
		console.error("[notify] ignored:", error);
	}
}

export interface PresentAgent {
	agentId: string;
	lastSeenAt: Date;
	lastAction: string | null;
	currentTaskId: string | null;
	taskTitle: string | null;
}

/** Agents seen within the presence window, most recent first. */
export async function presentAgents(orgId: string): Promise<PresentAgent[]> {
	const cutoff = new Date(Date.now() - presenceWindowMs());
	const rows = await db
		.select({
			agentId: agentPresence.agentId,
			lastSeenAt: agentPresence.lastSeenAt,
			lastAction: agentPresence.lastAction,
			currentTaskId: agentPresence.currentTaskId,
			taskTitle: tasks.title,
		})
		.from(agentPresence)
		.leftJoin(tasks, eq(agentPresence.currentTaskId, tasks.id))
		.where(and(eq(agentPresence.orgId, orgId), gte(agentPresence.lastSeenAt, cutoff)))
		.orderBy(desc(agentPresence.lastSeenAt))
		.limit(50);
	return rows;
}

/**
 * The db handle or a transaction on it.
 *
 * Derived from `db.transaction`'s own callback rather than written out, so it
 * tracks the schema automatically. The alternative — casting a transaction to
 * `typeof db` — compiles only because the cast silences the difference, and the
 * difference is real: a transaction has no `$client`.
 */
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

function leaseExpiry(minutes: number | undefined, now: Date): Date {
	const requested = minutes ?? setting("leaseMinutes");
	const bounded = Math.min(Math.max(requested, 1), setting("maxLeaseMinutes"));
	return new Date(now.getTime() + bounded * 60_000);
}

/**
 * Resolve the short id an agent was shown back to a real row.
 *
 * Agents see `[a1b2]` and will send exactly that back, but they also sometimes
 * send the full UUID they saw elsewhere, so both are accepted. An ambiguous
 * prefix is an error rather than a best guess: claiming the wrong task is worse
 * than being told to be more specific.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHORT_ID = /^[0-9a-f]{4,32}$/;

export async function resolveTaskId(orgId: string, ref: string): Promise<string> {
	const cleaned = ref.trim().replace(/^\[|\]$/g, "").toLowerCase();
	if (UUID.test(cleaned)) return cleaned;

	// Validate the shape before it reaches a LIKE pattern. `%` and `_` are
	// wildcards there, so an empty string or a bare `%` used to match every task
	// in the org and — with exactly one open task — resolve to it silently. The
	// result was that a model hallucinating an empty task_id would claim or
	// complete an arbitrary task instead of getting the "be more specific" error
	// this function promises. Not injection; the fragment binds a parameter. Worse
	// than injection in practice, because it looked like success.
	if (!SHORT_ID.test(cleaned)) {
		throw new HarborError(
			`"${ref}" is not a task id. Use the four-character id shown in list_work, e.g. a1b2.`,
		);
	}

	const matches = await db
		.select({ id: tasks.id })
		.from(tasks)
		.where(
			and(
				eq(tasks.orgId, orgId),
				raw`replace(${tasks.id}::text, '-', '') like ${`${cleaned}%`}`,
			),
		)
		.limit(5);

	if (matches.length === 0) throw new HarborError(`No task matching "${ref}".`);
	if (matches.length > 1) {
		throw new HarborError(
			`"${ref}" matches ${matches.length} tasks. Use more characters of the id.`,
		);
	}
	return matches[0]!.id;
}

/**
 * Release any claim whose lease has run out.
 *
 * Called at the top of `claim` inside the same transaction, and separately by
 * the sweeper. The partial unique index cannot express "and not expired" —
 * a Postgres index predicate may not call `now()` — so an expired-but-unreleased
 * row would otherwise hold the slot until the sweeper next ran, which is up to a
 * minute of a task being wrongly unclaimable. Doing it here means correctness
 * never depends on a background job being alive; the sweeper only exists to keep
 * the event log timely.
 */
/**
 * Read the active claim for a task and hold a row lock until the transaction ends.
 *
 * `release` and `renew` used to read this with a plain `findFirst` and then write
 * keyed on the claim's primary key alone. Under READ COMMITTED that loses
 * updates: a concurrent `claim()` expires the lapsed row, inserts a fresh one for
 * a different agent, and the first transaction's blocked UPDATE re-evaluates its
 * predicate, still matches on primary key, and lands anyway. The result was the
 * one outcome this product exists to prevent — two agents working the same task,
 * with the loser's summary recorded as shipped work in the weekly digest.
 *
 * The precondition is not adversarial. It is an agent whose thirty-minute lease
 * lapsed while it was still working, which is the ordinary case.
 *
 * `FOR UPDATE` serialises the second transaction behind the first, so by the time
 * it reads, the row it locked is the row that actually exists. `claim()` already
 * had this discipline via the unique index; these two never got it.
 */
async function lockActiveClaim(tx: Executor, orgId: string, taskId: string) {
	const [row] = await tx
		.select()
		.from(claims)
		.where(and(eq(claims.orgId, orgId), eq(claims.taskId, taskId), isNull(claims.releasedAt)))
		.for("update")
		.limit(1);
	return row;
}

/**
 * Release every lapsed lease in scope, return its task to the pool, and say so.
 *
 * The one place a lease dies of old age. `claim` calls it on contention, the read
 * paths call it opportunistically, and the background loop calls it on a timer —
 * three callers, one set of writes, so a lease released by any of them leaves the
 * same evidence. Before this was shared, `claim` released the row without
 * reopening the task and without an event, which is how a task could sit
 * `claimed` and held by nobody.
 *
 * All three writes are one fact and commit together: a claim released with its
 * task still `claimed` and no `claim_expired` event reads in the dashboard as a
 * task open to nobody, which is worse than the stale lease it replaced.
 *
 * `orgId` bounds it because two of the three callers are reads. A `list_work` for
 * one tenant must not write rows belonging to another — the work is unbounded, it
 * is not that caller's to do, and it turns one org's traffic into another org's
 * lock contention. The loop passes no org and sweeps everything, which is what a
 * backstop is for.
 *
 * `contendedTaskId` only changes the recorded reason. "Released on contention"
 * and "swept" are the same release, but the first says somebody was waiting and
 * the second says nobody was, and that is the difference between a lease that was
 * too short and an agent that died.
 */
async function sweepLapsedLeases(
	tx: Executor,
	now: Date,
	opts: { orgId?: string; contendedTaskId?: string } = {},
): Promise<number> {
	const conditions = [isNull(claims.releasedAt), lt(claims.expiresAt, now)];
	if (opts.orgId) conditions.push(eq(claims.orgId, opts.orgId));

	const expired = await tx
		.update(claims)
		.set({ releasedAt: now })
		.where(and(...conditions))
		.returning({
			orgId: claims.orgId,
			taskId: claims.taskId,
			agentId: claims.agentId,
			scope: claims.scope,
		});

	for (const row of expired) {
		// The org comes off the claim itself, not a task join — a lease can be over a
		// scope with no task row, and those must still be swept and logged.
		if (row.taskId) {
			await tx
				.update(tasks)
				.set({ status: "open", updatedAt: now })
				.where(and(eq(tasks.id, row.taskId), eq(tasks.status, "claimed")));
		}
		const contended = opts.contendedTaskId !== undefined && row.taskId === opts.contendedTaskId;
		await tx.insert(events).values({
			orgId: row.orgId,
			taskId: row.taskId,
			agentId: row.agentId,
			type: "claim_expired",
			payload: {
				reason: contended ? "lease elapsed, released on contention" : "lease elapsed, swept",
				scope: row.scope,
			},
		});
	}

	return expired.length;
}

/**
 * The backlog, and who holds what — self-healing on read.
 *
 * Two independent defences against a lapsed lease reading as held, because they
 * fail differently and the failure is the one thing the lease exists to prevent.
 *
 * **The sweep** releases the rows, so the dashboard, the timeline and every other
 * reader converge too — not just this caller. It runs here because the deployment
 * that most needs it is the one that cannot run a loop: the Next.js app is
 * serverless-shaped and starts none, so on a dashboard-only deployment this and
 * `claim` are the *only* things that ever expire a lease. Without it a crashed
 * agent holds its scope until somebody happens to contend for that exact task,
 * which is indistinguishable from the lease model not working.
 *
 * **The join predicate** is the one that does not depend on a write succeeding.
 * The sweep is a write inside what a caller reasonably expects to be a read; it
 * can be rolled back, refused on a read-only replica, or lost to a serialisation
 * failure. `gt(claims.expiresAt, now)` costs nothing and means the answer is
 * right even when the write did not happen. A read that lies about who holds a
 * lease is how two agents end up on one task.
 */
export async function listWork(
	orgId: string,
	filter: { project?: string; status?: string } = {},
): Promise<TaskLine[]> {
	const now = new Date();

	const conditions = [eq(tasks.orgId, orgId)];
	if (filter.status) conditions.push(eq(tasks.status, filter.status));
	if (filter.project) {
		conditions.push(raw`lower(${projects.name}) = ${filter.project.toLowerCase()}`);
	}

	// One transaction, so the rows read are the rows the sweep just settled. Split
	// across two, a lease expiring in between reads as held by an agent this very
	// call released.
	const rows = await db.transaction(async (tx) => {
		await sweepLapsedLeases(tx, now, { orgId });

		return tx
			.select({
				id: tasks.id,
				title: tasks.title,
				status: tasks.status,
				scope: tasks.scope,
				source: tasks.source,
				sourceRef: tasks.sourceRef,
				project: projects.name,
				claimAgent: claims.agentId,
				claimExpires: claims.expiresAt,
				claimIntent: claims.intent,
			})
			.from(tasks)
			.leftJoin(projects, eq(tasks.projectId, projects.id))
			.leftJoin(
				claims,
				and(eq(claims.taskId, tasks.id), isNull(claims.releasedAt), gt(claims.expiresAt, now)),
			)
			.where(and(...conditions))
			.orderBy(desc(tasks.updatedAt))
			.limit(200);
	});

	return rows.map((row) => ({
		id: row.id,
		title: row.title,
		status: row.status,
		project: row.project,
		scope: row.scope,
		source: row.source,
		sourceRef: row.sourceRef,
		claim:
			row.claimAgent && row.claimExpires
				? {
						agentId: row.claimAgent,
						expiresAt: row.claimExpires,
						intent: row.claimIntent ?? undefined,
					}
				: null,
	}));
}

/**
 * A losing claim is data, not an error — and to be useful to the agent that
 * lost, it has to say more than "no". The conflict carries who holds the scope,
 * why (their intent, verbatim), when it frees, a live session link if one
 * exists, and somewhere else to go. The tool description tells the model this is
 * a fork in the road, not a failure to retry.
 */
export interface ClaimConflict {
	agentId: string;
	intent: string | null;
	claimedAt: Date;
	expiresAt: Date;
	/** The `/s/<key>` page if the holder is driving one, so the loser can watch. */
	sessionUrl: string | null;
	/** Up to N unclaimed tasks in the same project the loser can pick up instead. */
	suggestedAlternatives: Array<{ id: string; title: string }>;
}

export type ClaimResult =
	| {
			ok: true;
			taskId: string;
			title: string;
			expiresAt: Date;
			/**
			 * The claim row this call inserted. Callers that go on to spawn MUST pass
			 * this to `ensureSandbox` rather than re-reading the active claim: a
			 * re-read races the release/expiry of the very row it is looking for, and
			 * a null from that race used to collapse into "no lease asserted" — which
			 * `readLeaseState` treats as authorised. The id from the insert cannot be
			 * anybody else's claim.
			 */
			claimId: string;
	  }
	| { ok: false; taskId: string; title: string; conflict: ClaimConflict };

/**
 * Attempt to take a task, atomically.
 *
 * The insert is the lock. If another agent got there first, Postgres raises a
 * unique violation on `one_active_lease_per_scope` and we come back to read who
 * won — rather than checking first and inserting second, which would leave a
 * window where two agents both pass the check.
 *
 * A conflict is a normal, expected result and is returned as data, never thrown.
 * It also writes a `claim_conflict` event, which is the single number this
 * product is judged by: every one of those rows is a duplicate day of work that
 * did not happen.
 */
export interface ClaimOptions {
	leaseMinutes?: number;
	/** Why this agent is doing this work. Becomes part of the permanent record. */
	intent?: string;
	/** A spec, doc or thread backing the intent. */
	intentRef?: string;
}

export async function claim(
	orgId: string,
	taskRef: string,
	agentId: string,
	opts: ClaimOptions = {},
): Promise<ClaimResult> {
	// The old positional numeric form (a bare `leaseMinutes`) is gone. It could not
	// carry an intent, and intent is now mandatory — a signature whose only callers
	// would all fail the first check is worse than no signature. Every caller passes
	// options.
	const leaseMinutes = opts.leaseMinutes;

	// Intent is required at mint. Enforced here, before any row is touched, because
	// this is the kernel — the MCP schema and the dashboard both reach the lease
	// through this function, so making it structurally impossible to hold a lease
	// without a reason has to live below all of them, not in one caller's validator.
	const intent = opts.intent?.trim() ?? "";
	const minIntent = setting("minIntentChars");
	if (intent.length < minIntent) {
		throw new HarborError(
			`A claim needs an intent of at least ${minIntent} characters — one sentence on why `
				+ `you are taking this work and what outcome you are after. Other agents read it `
				+ `before picking adjacent work, and it is what the team reads months later.`,
		);
	}

	const taskId = await resolveTaskId(orgId, taskRef);
	const now = new Date();

	return db.transaction(async (tx) => {
		const task = await tx.query.tasks.findFirst({
			where: and(eq(tasks.id, taskId), eq(tasks.orgId, orgId)),
		});
		if (!task) throw new HarborError(`No task matching "${taskRef}".`);

		const scope = scopeForTask(task);

		// Org-scoped rather than just this task. Expiring the contended lease is what
		// makes the insert below succeed; expiring the rest is nearly free once the
		// transaction is open, and it means a deployment with no background loop
		// converges on every claim instead of one task at a time. `contendedTaskId`
		// keeps this task's event saying somebody was waiting for it.
		await sweepLapsedLeases(tx, now, { orgId, contendedTaskId: taskId });

		const expiresAt = leaseExpiry(leaseMinutes, now);

		// ON CONFLICT rather than try/catch, and the difference is not stylistic.
		// A unique violation raised inside a Postgres transaction aborts the whole
		// transaction — every subsequent statement fails with 25P02 — so the
		// natural-looking "catch the violation, then read who holds it" is
		// impossible: the read is exactly what cannot run. Letting Postgres absorb
		// the conflict keeps the transaction alive so the same one can look up the
		// holder and write the conflict event.
		//
		// The conflict target has to repeat the index predicate, because the index
		// is partial; without it Postgres cannot match `one_active_lease_per_scope`
		// and raises the violation after all. The target is `(org_id, scope)` — the
		// scope is the invariant now, not the task id.
		const inserted = await tx
			.insert(claims)
			.values({
				orgId,
				scope,
				taskId,
				agentId,
				rights: [...DEFAULT_RIGHTS],
				expiresAt,
				intent,
				intentRef: opts.intentRef ?? null,
			})
			.onConflictDoNothing({
				target: [claims.orgId, claims.scope],
				// `where`, not `targetWhere` — the latter is the onConflictDoUpdate
				// spelling and is silently ignored here, which emits a bare
				// `on conflict (org_id, scope)` that Postgres cannot match to a partial
				// index (42P10).
				where: isNull(claims.releasedAt),
			})
			.returning({ id: claims.id });

		if (inserted.length > 0) {
			await tx
				.update(tasks)
				.set({ status: "claimed", updatedAt: now })
				.where(eq(tasks.id, taskId));
			await tx.insert(events).values({
				orgId,
				taskId,
				agentId,
				type: "claimed",
				payload: {
					scope,
					expiresAt: expiresAt.toISOString(),
					intent,
					intentRef: opts.intentRef ?? null,
				},
			});
			return { ok: true, taskId, title: task.title, expiresAt, claimId: inserted[0]!.id };
		}

		const holder = await tx.query.claims.findFirst({
			where: and(eq(claims.orgId, orgId), eq(claims.scope, scope), isNull(claims.releasedAt)),
		});
		// Someone held it a moment ago or the insert would have landed. If they
		// released in between, say so rather than invent a name to blame.
		if (!holder) {
			throw new HarborError("Task was claimed and released concurrently; retry.");
		}

		// The conflict is only useful if the loser can act on it. Read the holder's
		// live session (if any) and a few unclaimed tasks in the same project, in the
		// same transaction, so the payload is a fork in the road rather than a dead end.
		const [holderSession] = await tx
			.select({ key: sessions.key })
			.from(sessions)
			.where(and(eq(sessions.orgId, orgId), eq(sessions.taskId, taskId)))
			.orderBy(desc(sessions.createdAt))
			.limit(1);

		const alternatives = task.projectId
			? await tx
					.select({ id: tasks.id, title: tasks.title })
					.from(tasks)
					.leftJoin(claims, and(eq(claims.taskId, tasks.id), isNull(claims.releasedAt)))
					.where(
						and(
							eq(tasks.orgId, orgId),
							eq(tasks.projectId, task.projectId),
							eq(tasks.status, "open"),
							ne(tasks.id, taskId),
							isNull(claims.id),
						),
					)
					.orderBy(desc(tasks.updatedAt))
					.limit(setting("suggestedAlternativesCount"))
			: [];

		const conflict: ClaimConflict = {
			agentId: holder.agentId,
			intent: holder.intent,
			claimedAt: holder.claimedAt,
			expiresAt: holder.expiresAt,
			sessionUrl: holderSession ? `${publicBaseUrl()}/s/${holderSession.key}` : null,
			suggestedAlternatives: alternatives,
		};

		await tx.insert(events).values({
			orgId,
			taskId,
			agentId,
			type: "claim_conflict",
			payload: {
				scope,
				heldBy: holder.agentId,
				holderIntent: holder.intent,
				expiresAt: holder.expiresAt.toISOString(),
				sessionUrl: conflict.sessionUrl,
			},
		});

		return { ok: false, taskId, title: task.title, conflict };
	});
}

/**
 * Give a task back, or finish it.
 *
 * A summary means "done" and feeds the weekly digest; no summary means the agent
 * gave up and the task returns to `open` for someone else. Distinguishing them
 * matters because a digest that reports abandoned work as completed is worse
 * than no digest.
 */
export async function release(
	orgId: string,
	taskRef: string,
	agentId: string,
	completionSummary?: string,
): Promise<{ taskId: string; title: string; completed: boolean }> {
	const taskId = await resolveTaskId(orgId, taskRef);
	const now = new Date();

	return db.transaction(async (tx) => {
		const task = await tx.query.tasks.findFirst({
			where: and(eq(tasks.id, taskId), eq(tasks.orgId, orgId)),
		});
		if (!task) throw new HarborError(`No task matching "${taskRef}".`);

		const held = await lockActiveClaim(tx, orgId, taskId);
		if (!held) throw new HarborError(`Task [${taskRef}] is not currently claimed.`);
		// Releasing somebody else's claim is refused rather than allowed-with-a-warning:
		// a confused agent freeing another agent's in-flight work is the exact
		// collision Harbor exists to prevent.
		if (held.agentId !== agentId) {
			throw new HarborError(
				`Task [${taskRef}] is held by ${held.agentId}, not ${agentId}. Not released.`,
			);
		}

		const completed = Boolean(completionSummary?.trim());
		// `isNull(releasedAt)` stays in the WHERE even though the row was just
		// locked and read. Belt and braces on the one write that decides whether a
		// piece of work counts as shipped: if the predicate ever stops holding, the
		// zero-row check below turns it into a refusal instead of a lost update.
		const updated = await tx
			.update(claims)
			.set({ releasedAt: now, completionSummary: completionSummary ?? null })
			.where(and(eq(claims.id, held.id), isNull(claims.releasedAt)))
			.returning({ id: claims.id });
		if (updated.length === 0) {
			throw new HarborError(
				`Task [${taskRef}] was taken by another agent while you were working. `
					+ "Stop work on it; nothing was recorded.",
			);
		}

		await tx
			.update(tasks)
			.set({ status: completed ? "completed" : "open", updatedAt: now })
			.where(eq(tasks.id, taskId));
		await tx.insert(events).values({
			orgId,
			taskId,
			agentId,
			type: completed ? "completed" : "released",
			payload: completed ? { summary: completionSummary } : {},
		});

		return { taskId, title: task.title, completed };
	});
}

export async function renewClaim(
	orgId: string,
	taskRef: string,
	agentId: string,
	leaseMinutes?: number,
): Promise<{ taskId: string; expiresAt: Date }> {
	const taskId = await resolveTaskId(orgId, taskRef);
	const now = new Date();

	return db.transaction(async (tx) => {
		// No task pre-load. renew used to fetch the task scoped to the org purely to
		// close a cross-org hole — `resolveTaskId` short-circuits full UUIDs without a
		// round trip, so a caller with org A's key could pass org B's task UUID. Now
		// that `claims` carries `org_id` and the lock filters on it, a cross-org UUID
		// simply matches no active claim and is refused here, with no extra query.
		const held = await lockActiveClaim(tx, orgId, taskId);
		if (!held) throw new HarborError(`Task [${taskRef}] has no active claim to renew.`);
		if (held.agentId !== agentId) {
			throw new HarborError(`Task [${taskRef}] is held by ${held.agentId}, not ${agentId}.`);
		}
		// A lapsed lease is deliberately still renewable by its own holder while the
		// row survives: the agent is demonstrably alive and mid-flight, and handing
		// its work to someone else because a heartbeat was late helps nobody.
		const expiresAt = leaseExpiry(leaseMinutes, now);
		const renewed = await tx
			.update(claims)
			.set({ expiresAt })
			.where(and(eq(claims.id, held.id), isNull(claims.releasedAt)))
			.returning({ id: claims.id });
		if (renewed.length === 0) {
			throw new HarborError(
				`Task [${taskRef}] was taken by another agent. Stop work on it.`,
			);
		}

		await tx.insert(events).values({
			orgId,
			taskId,
			agentId,
			type: "claim_renewed",
			payload: { expiresAt: expiresAt.toISOString() },
		});
		return { taskId, expiresAt };
	});
}

/**
 * Revoke a lease and everything narrowed from it.
 *
 * Nothing delegates yet, so in practice this releases a single lease today — but
 * the moment a lease hands a subscope to a child, revoking the parent has to take
 * the children with it, or a revoked capability keeps working through a lease the
 * parent no longer trusts. The relationship is walked with a recursive CTE over
 * `parent_lease_id` so an arbitrarily deep delegation tree collapses in one pass,
 * and `org_id` scopes the whole walk so one tenant can never revoke another's.
 *
 * "Revoke" is a release (`released_at` set), not a delete: the row and its intent
 * stay in the history the digest and the verifier read.
 */
export async function revokeLease(
	orgId: string,
	leaseId: string,
): Promise<{ revoked: number }> {
	const now = new Date();
	return db.transaction(async (tx) => {
		const rows = await tx.execute<{ id: string }>(raw`
			with recursive subtree as (
				select id from ${claims} where id = ${leaseId} and ${claims.orgId} = ${orgId}
				union all
				select c.id from ${claims} c join subtree s on c.parent_lease_id = s.id
			)
			select id from subtree
		`);
		const ids = Array.from(rows, (row) => row.id);
		if (ids.length === 0) return { revoked: 0 };

		const updated = await tx
			.update(claims)
			.set({ releasedAt: now })
			.where(and(eq(claims.orgId, orgId), inArray(claims.id, ids), isNull(claims.releasedAt)))
			.returning({ id: claims.id });
		return { revoked: updated.length };
	});
}

export async function createTask(
	orgId: string,
	input: {
		title: string;
		description?: string;
		project?: string;
		scope?: string;
		source?: string;
		sourceRef?: string;
	},
): Promise<{ id: string; title: string; project?: string }> {
	const now = new Date();
	return db.transaction(async (tx) => {
		let projectId: string | null = null;
		let projectName: string | undefined;

		if (input.project) {
			const existing = await tx
				.select({ id: projects.id, name: projects.name })
				.from(projects)
				.where(
					and(
						eq(projects.orgId, orgId),
						raw`lower(${projects.name}) = ${input.project.toLowerCase()}`,
					),
				)
				.limit(1);

			if (existing[0]) {
				projectId = existing[0].id;
				projectName = existing[0].name;
			} else {
				// Auto-create rather than reject. An agent that must first discover
				// whether a project exists needs a sixth tool to ask, and the whole
				// design goal is five.
				const [created] = await tx
					.insert(projects)
					.values({ orgId, name: input.project })
					.returning({ id: projects.id, name: projects.name });
				projectId = created!.id;
				projectName = created!.name;
			}
		}

		const [task] = await tx
			.insert(tasks)
			.values({
				orgId,
				projectId,
				title: input.title,
				description: input.description ?? null,
				scope: input.scope ?? null,
				source: input.source ?? "native",
				sourceRef: input.sourceRef ?? null,
				createdAt: now,
				updatedAt: now,
			})
			.returning({ id: tasks.id, title: tasks.title });

		await tx.insert(events).values({
			orgId,
			taskId: task!.id,
			type: "task_created",
			payload: { source: input.source ?? "native" },
		});

		return { id: task!.id, title: task!.title, project: projectName };
	});
}

/**
 * Release every lapsed lease across every org, on a timer.
 *
 * A backstop and not the mechanism — `claim` and `listWork` both sweep their own
 * org in the request path, so a lease normally dies the next time anyone reads or
 * contends. This exists for the org nobody is looking at, and for the deployment
 * that runs the MCP server: a task whose agent died should read as `open` within
 * a minute, not whenever somebody next opens the dashboard.
 *
 * Unscoped on purpose. It is the one caller that is not serving a tenant, so it
 * is the one caller allowed to do unbounded work.
 */
export async function sweepExpiredClaims(): Promise<number> {
	const now = new Date();
	return db.transaction((tx) => sweepLapsedLeases(tx, now));
}
