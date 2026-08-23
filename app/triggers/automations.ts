// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Automations — sessions that start without a human present.
 *
 * Three properties, and each is a correction of what the obvious version does.
 *
 * **The scheduler is not a singleton.** There is no coordinator process and no
 * leader election. Every app replica runs the same tick, takes a Postgres
 * advisory lock, and whichever gets it does the work; the rest return
 * immediately. A dedicated scheduler is a serial bottleneck and a single point of
 * failure with no sharding story, and the moment you have one you also have the
 * question of what happens when it dies mid-tick.
 *
 * **Failure pauses the automation, it does not retry forever.** Three consecutive
 * failures and it switches itself off with a reason. An automation that fails is
 * usually going to keep failing, and an hourly one against a broken repository
 * spawns twenty-four sandboxes a day — each costing money, each producing an
 * error nobody reads — until somebody notices the bill. Auto-pause turns an
 * unbounded cost into a bounded one and a visible state.
 *
 * **`nextRunAt` is advanced BEFORE the work runs.** If it were advanced after,
 * a crash mid-run leaves the automation due, and it fires again on the next tick,
 * and again — a crash loop that spawns a sandbox per tick. Advancing first means
 * a crash costs one skipped run, which is the cheaper of the two failures by a
 * wide margin.
 */

import { and, eq, isNull, lte, or, sql as raw } from "drizzle-orm";
import { db } from "@core/schema/index.js";
import { automationRuns, automations, sessions } from "@core/schema/schema.js";
import { setting } from "@core/kernel/config.js";
import { globalLock, withLock } from "@core/kernel/locks.js";
import { createSession } from "../lib/sessions.js";
import { enqueueSessionPrompt } from "../lib/session-runner.js";
import { environmentRepoIds } from "../lib/secrets.js";
import { budgetStatusSafe } from "./budget-bridge.js";
import { nextRun } from "./cron.js";

/**
 * How many failures before an automation switches itself off.
 *
 * Read through `setting()` for the same reason every other threshold is: a team
 * whose automation legitimately fails on a flaky dependency once a day should be
 * able to raise it without forking.
 */
function failureLimit(): number {
	return setting("circuitFailureThreshold");
}

/**
 * One tick. Called on an interval by the server, and safe to call from every
 * replica simultaneously.
 *
 * The advisory lock is taken on a constant rather than per automation, because
 * the tick is short and contention between replicas is the thing being avoided —
 * per-automation locks would let two replicas each process half the due set,
 * which is correct but means the "did anything run" question has no single
 * answer in the logs.
 */
export async function tickAutomations(now = new Date()): Promise<{
	ran: number;
	skipped: number;
	paused: number;
}> {
	// The lock is taken on a reserved connection rather than a pooled one, which is
	// not a detail — see `src/lib/locks.ts` for why, and for the failure it avoids:
	// automations that run exactly once after a deploy and then silently never
	// again, on work that by definition nobody is watching.
	const outcome = await withLock(globalLock("harbor:automations"), () =>
		runDueAutomations(now),
	);
	return outcome.acquired ? outcome.result : { ran: 0, skipped: 0, paused: 0 };
}

async function runDueAutomations(now: Date): Promise<{
	ran: number;
	skipped: number;
	paused: number;
}> {
	const due = await db
		.select()
		.from(automations)
		.where(
			and(
				// Only cron automations are due on a clock. Event-driven automations
				// (`webhook`, `sentry`) fire from `POST /api/triggers/...` when a delivery
				// arrives and carry no `nextRunAt`, so without this filter they match
				// `isNull(nextRunAt)` on every tick — the tick would then stamp
				// `lastRunAt = now` and write an UPDATE for each of them once a minute
				// forever, showing a "last run" that advances although the automation
				// never ran. Restricting the clock to `cron` is the whole fix.
				eq(automations.source, "cron"),
				eq(automations.enabled, true),
				isNull(automations.pausedReason),
				or(isNull(automations.nextRunAt), lte(automations.nextRunAt, now)),
			),
		)
		.limit(100);

	let ran = 0;
	let skipped = 0;
	let paused = 0;

	for (const automation of due) {
		// Advance the schedule FIRST. See the module header for why this ordering
		// is the difference between one skipped run and a crash loop that spawns a
		// sandbox per tick.
		const scheduled = advanceSchedule(automation, now);
		await db
			.update(automations)
			.set({ nextRunAt: scheduled, lastRunAt: now })
			.where(eq(automations.id, automation.id));

		// A first-ever tick computes `nextRunAt` and runs nothing. Without this,
		// creating an hourly automation fires it immediately, which surprises the
		// person who created it and is not what "hourly" means.
		if (!automation.nextRunAt) {
			skipped += 1;
			continue;
		}

		const outcome = await runAutomation(automation.id);
		if (outcome === "ran") ran += 1;
		else skipped += 1;
		if (outcome === "paused") paused += 1;
	}

	return { ran, skipped, paused };
}

function advanceSchedule(
	automation: typeof automations.$inferSelect,
	now: Date,
): Date | null {
	if (automation.source !== "cron") return null;

	const spec = (automation.spec as { expression?: string; timezone?: string } | null) ?? {};
	if (!spec.expression) return null;

	try {
		return nextRun(spec.expression, now, spec.timezone ?? "UTC");
	} catch {
		// A stored expression that no longer parses — the parser got stricter, or
		// somebody edited the row directly. Returning null stops it firing rather
		// than throwing and taking every other due automation in this tick with it.
		return null;
	}
}

/**
 * Turn one already-created `automation_runs` row into a session and a queued
 * prompt, and do the success/failure bookkeeping that drives auto-pause.
 *
 * Extracted from `runAutomation` so the cron path, the manual "Run now" button
 * and an inbound event all share one fire path — the place where a bug would
 * otherwise be fixed in one caller and left in the others. Everything specific to
 * *how the run was admitted* (enabled/paused checks, delivery idempotency) lives
 * in the caller; this function assumes the run row already exists and is the
 * authority for spending it.
 *
 * `extraContext` is the normalised event that triggered an inbound run — the
 * Sentry stack frame, the webhook body — appended to the automation's own prompt
 * so the agent sees what fired it. Cron and manual runs pass nothing and behave
 * exactly as before.
 */
async function executeRun(
	automation: typeof automations.$inferSelect,
	runId: string,
	extraContext?: string,
): Promise<"ran" | "skipped" | "paused"> {
	try {
		// Budget is checked before anything is created, not after. An automation
		// firing into an exhausted budget should cost one database read, not a
		// session row and a sandbox that is refused a moment later. Event deliveries
		// are pre-checked in `deliverEvent` before a run row is even inserted, so for
		// them this is a transactional backstop against a race rather than the gate.
		const budget = await budgetStatusSafe(automation.orgId);
		if (budget.exhausted) {
			throw new Error(
				`Daily spend cap reached (${(budget.spentMicroUsd / 1_000_000).toFixed(2)} of `
					+ `${(budget.capMicroUsd / 1_000_000).toFixed(2)} USD). Running work continues; `
					+ "new automation runs are refused until the UTC day rolls over.",
			);
		}

		const repoIds =
			automation.targetKind === "environment"
				? await environmentRepoIds(automation.orgId, automation.targetId)
				: [automation.targetId];

		if (repoIds.length === 0) {
			throw new Error(
				"The target environment contains no repositories. It was probably emptied "
					+ "after this automation was created.",
			);
		}

		const session = await createSession({
			orgId: automation.orgId,
			title: automation.name,
			// Provenance, not ownership — a session has no owner. `automation:<id>`
			// rather than a person, because attributing scheduled work to whoever
			// happened to create the automation months ago is a lie the git history
			// would then repeat.
			createdBy: `automation:${automation.id}`,
		});

		await db
			.update(sessions)
			.set({
				repoId: automation.targetKind === "repo" ? automation.targetId : null,
				environmentId: automation.targetKind === "environment" ? automation.targetId : null,
				runtime: automation.runtime,
			})
			.where(eq(sessions.id, session.id));

		// The capped front door. An automation is THE amplification path the
		// queue-depth cap's own doc comment names — a retrying hourly job enqueues
		// without bound — and a refusal here must THROW so it lands in the catch
		// below, increments consecutiveFailures, and eventually pauses the
		// automation itself. Swallowing the refusal would keep the schedule firing
		// into a full queue forever, which is the loop the cap exists to break.
		const queued = await enqueueSessionPrompt({
			orgId: automation.orgId,
			sessionId: session.id,
			author: `automation:${automation.name}`,
			// `agent`, so the session runner's priority ordering puts a human's
			// one-word correction ahead of a scheduled forty-minute job.
			authorKind: "agent",
			body: withContext(automation.prompt, extraContext),
		});
		if (!queued.ok) throw new Error(queued.message);

		await db
			.update(automationRuns)
			.set({ status: "succeeded", sessionId: session.id, endedAt: new Date() })
			.where(eq(automationRuns.id, runId));

		// Success resets the counter. Without this a flaky automation that fails
		// twice a week eventually accumulates three failures across three months and
		// pauses itself, which reads as random.
		await db
			.update(automations)
			.set({ consecutiveFailures: 0 })
			.where(eq(automations.id, automation.id));

		return "ran";
	} catch (error) {
		const message = (error as Error).message;

		await db
			.update(automationRuns)
			.set({ status: "failed", error: message, endedAt: new Date() })
			.where(eq(automationRuns.id, runId));

		const failures = automation.consecutiveFailures + 1;
		const limit = failureLimit();
		const shouldPause = failures >= limit;

		await db
			.update(automations)
			.set({
				consecutiveFailures: failures,
				pausedReason: shouldPause
					? `Paused after ${failures} consecutive failures. Last error: ${message}`
					: null,
			})
			.where(eq(automations.id, automation.id));

		return shouldPause ? "paused" : "skipped";
	}
}

/**
 * Append the event that triggered a run to the automation's own prompt.
 *
 * Bounded to `queuePrompt`'s 8000-character limit here rather than letting the
 * queue reject the whole run: an oversized Sentry stack trace must not turn a
 * legitimate alert into a failed run that counts toward auto-pause. The
 * automation's instructions come first and are never truncated — the event is
 * context, not the task — and a clipped event is marked so the agent knows it is
 * reading a fragment.
 */
function withContext(prompt: string, extraContext?: string): string {
	if (!extraContext) return prompt;
	const MAX = 8000;
	const joined = `${prompt}\n\n---\n${extraContext}`;
	if (joined.length <= MAX) return joined;
	const room = MAX - prompt.length - "\n\n---\n\n…(truncated)".length;
	if (room <= 0) return prompt.slice(0, MAX);
	return `${prompt}\n\n---\n${extraContext.slice(0, room)}\n…(truncated)`;
}

/**
 * Run one automation from the scheduler or the manual "Run now" button.
 *
 * Exported because "run it now" is the first thing anybody does after creating
 * an automation, and making them wait an hour to find out whether it works is a
 * good way to have them never create a second one. Deliberately does NOT check
 * `enabled`/`pausedReason`: Run-now on a paused automation is a legitimate "is it
 * fixed yet" test, and the cron tick's own query already excludes those rows.
 */
export async function runAutomation(
	automationId: string,
): Promise<"ran" | "skipped" | "paused"> {
	const automation = await db.query.automations.findFirst({
		where: eq(automations.id, automationId),
	});
	if (!automation) return "skipped";

	const [run] = await db
		.insert(automationRuns)
		.values({ orgId: automation.orgId, automationId: automation.id, status: "running" })
		.returning();

	return executeRun(automation, run!.id);
}

/**
 * Run one automation from an inbound event delivery, exactly once per delivery.
 *
 * The `dedupeKey` — a Sentry event id, a sender's delivery header, or a hash of
 * the raw body — is written onto the run row under the partial unique index on
 * `(automation_id, dedupe_key)`. A retried delivery (every one of Slack, Sentry
 * and generic webhook senders retries a non-2xx) inserts the same key, conflicts,
 * returns no row, and this function reports `"duplicate"` without spending a
 * sandbox or a token. That is the whole idempotency guarantee, and it lives in
 * the index rather than in a read-then-write check that would race under exactly
 * the concurrent-retry conditions it exists to defend against.
 *
 * enabled/paused/budget/conditions are the caller's job (`deliverEvent`), checked
 * before we get here so a filtered or over-budget delivery never creates a run
 * row and never counts toward auto-pause — an event source can be hit hundreds of
 * times a day and must not switch itself off over a transient cap.
 */
export async function runAutomationForEvent(
	automation: typeof automations.$inferSelect,
	options: { dedupeKey: string; extraContext?: string },
): Promise<"ran" | "skipped" | "paused" | "duplicate"> {
	const [run] = await db
		.insert(automationRuns)
		.values({
			orgId: automation.orgId,
			automationId: automation.id,
			status: "running",
			dedupeKey: options.dedupeKey,
		})
		.onConflictDoNothing({
			target: [automationRuns.automationId, automationRuns.dedupeKey],
			// The index is partial, so the arbiter must carry the same predicate —
			// Postgres will not match a bare `(automation_id, dedupe_key)` conflict
			// target against a `WHERE dedupe_key is not null` index without it.
			where: raw`${automationRuns.dedupeKey} is not null`,
		})
		.returning();

	if (!run) return "duplicate";

	return executeRun(automation, run.id, options.extraContext);
}

/** Clear the pause and the counter. The only way back from auto-pause, on purpose. */
export async function resumeAutomation(orgId: string, automationId: string): Promise<void> {
	await db
		.update(automations)
		.set({ pausedReason: null, consecutiveFailures: 0 })
		.where(and(eq(automations.orgId, orgId), eq(automations.id, automationId)));
}

export async function listAutomations(orgId: string) {
	return db
		.select()
		.from(automations)
		.where(eq(automations.orgId, orgId))
		.orderBy(automations.name);
}

export async function recentRuns(orgId: string, automationId: string, limit = 20) {
	return db
		.select()
		.from(automationRuns)
		.where(
			and(eq(automationRuns.orgId, orgId), eq(automationRuns.automationId, automationId)),
		)
		.orderBy(raw`${automationRuns.startedAt} desc`)
		.limit(limit);
}
