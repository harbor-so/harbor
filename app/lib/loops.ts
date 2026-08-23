// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Every background loop in the product, in one registry.
 *
 * This file exists because of a specific, expensive failure: the sweeps were
 * written, documented, tested — and never scheduled. `sweepDeadlines`,
 * `tickSessions` and `compactSession` had zero production callers, so a
 * shipping deployment had no inactivity reaping (every sandbox billed until
 * the host died), no session queue advancement outside the request path, and
 * unbounded event growth. The test suite was green the whole time, because
 * each sweep was tested by calling it — nothing asserted that anything *would*
 * call it.
 *
 * The registry is the fix, in the only shape a test can enforce: a closed list
 * a test compares against the set of sweeps that exist. Adding a sweep without
 * registering it here fails `loops.test.ts` by name. `startBackgroundLoops`
 * then starts exactly the registry, so "registered" and "scheduled" cannot
 * drift apart.
 *
 * The MCP server is the process that owns these loops; the Next.js app
 * deliberately runs none (it is serverless-shaped and may have zero warm
 * instances at any moment). Every loop is safe on every replica — each one
 * either takes an advisory lock, is a compare-and-set over shared rows, or is
 * idempotent by construction — so running the MCP server twice doubles the
 * timeliness, not the actions.
 */

import { type SettingKey, setting, validateConfig } from "@core/kernel/config.js";
import { databaseUrl } from "@core/schema/index.js";
import { describeDatabaseTls } from "@core/schema/tls.js";
import { tickDevinPoll } from "../devin/poll.js";
import { warnScmAttributionAtStartup } from "../git/credentials.js";
import { sweepDeferredPullRequests } from "../git/pull-request.js";
import { tickImageBuilds } from "../images/scheduler.js";
import { sweepProviderOrphans } from "../sandbox/orphans.js";
import { sweepDeadlines } from "../sandbox/manager.js";
import { tickAutomations } from "../triggers/automations.js";
import { compactEligibleSessions } from "./session-events.js";
import { tickSessions } from "./session-tick.js";
import { warnAboutAddressing } from "@core/kernel/urls.js";
import { sweepExpiredClaims } from "@core/kernel/work.js";

/**
 * Closed set, on purpose: `backgroundLoops()` returns exactly one spec per
 * member, and the completeness test enumerates this list. A new loop starts
 * here, as a name, so forgetting every other step still fails a test.
 */
export const LOOP_NAMES = [
	"claims",
	"automations",
	"deadlines",
	"sessions",
	"compaction",
	"pull_requests",
	"orphans",
	"devin",
	"images",
] as const;
export type LoopName = (typeof LOOP_NAMES)[number];

export interface LoopSpec {
	name: LoopName;
	/**
	 * Resolved via `setting()` at start rather than captured as a number, so the
	 * registry itself contains no timing literal the config lint would have to
	 * chase.
	 */
	intervalSetting: SettingKey;
	run: (now: Date) => Promise<unknown>;
}

export function backgroundLoops(): LoopSpec[] {
	return [
		{
			// A backstop, not the mechanism — claim() already expires a stale holder
			// before it inserts. This buys timeliness: a dead agent's task reads as
			// open within a minute instead of at the next contention.
			name: "claims",
			intervalSetting: "claimSweepIntervalMs",
			run: () => sweepExpiredClaims(),
		},
		{
			// Rides the claim sweep's interval deliberately: both are periodic
			// reconciliations whose timeliness matters and whose exact cadence does
			// not, and a second knob would be a second thing to get wrong.
			name: "automations",
			intervalSetting: "claimSweepIntervalMs",
			run: () => tickAutomations(),
		},
		{
			// Inactivity, stale heartbeats, boot timeouts, execution timeouts. This
			// is the single largest lever on cost in the product: without it an
			// abandoned sandbox bills until the host dies.
			name: "deadlines",
			intervalSetting: "deadlineSweepIntervalMs",
			run: (now) => sweepDeadlines(now),
		},
		{
			// Advances sessions with queued prompts. This is the latency a prompt
			// waits when no request-path tick picked it up — the most user-visible
			// interval in the system.
			name: "sessions",
			intervalSetting: "sessionTickIntervalMs",
			run: (now) => tickSessions(now),
		},
		{
			// Bounds event growth. ADR 0001's claim that "old events are compacted
			// rather than accumulated" is only true while this runs.
			name: "compaction",
			intervalSetting: "compactionSweepIntervalMs",
			run: (now) => compactEligibleSessions(now),
		},
		{
			// Pull requests whose identity lookup was INDETERMINATE — the source-
			// control host was unreachable, not the user unknown. That distinction is
			// the whole reason `openPullRequest` has a `deferred` outcome, and it buys
			// nothing unless something tries again: without this loop a ten-second
			// blip permanently costs a session its pull request, and the branch sits
			// pushed with nobody told to look at it. Refusals are NOT retried here;
			// `sweepDeferredPullRequests` marks those terminal.
			name: "pull_requests",
			intervalSetting: "claimSweepIntervalMs",
			run: () => sweepDeferredPullRequests(),
		},
		{
			// The backstop for crash windows the saga cannot close on its own: a
			// container whose row is unreachable is invisible to everything else.
			name: "orphans",
			intervalSetting: "orphanSweepIntervalMs",
			run: (now) => sweepProviderOrphans(now),
		},
		{
			// Devin is a cloud agent with no hooks, so its activity is pulled, not
			// pushed. This polls each tracked Devin session and feeds what changed
			// through the same activity path every other runtime pushes to.
			name: "devin",
			intervalSetting: "devinPollIntervalMs",
			run: (now) => tickDevinPoll(now),
		},
		{
			// Rebuilds per-repo prebuilt images on a cadence so sessions boot from a
			// warm image with dependencies baked in. Off unless a repo opts in, and a
			// no-op tick is one indexed scan, so it is cheap to run frequently. The
			// advisory lock inside makes it safe on every replica.
			name: "images",
			intervalSetting: "imageTickIntervalMs",
			run: (now) => tickImageBuilds(now),
		},
	];
}

export interface RunningLoops {
	stop(): void;
}

/**
 * Start every registered loop. One `setInterval` per spec, each tick wrapped so
 * a throwing pass is logged and the loop lives to run again — a sweep that dies
 * on its first bad pass is the "never scheduled" bug with extra steps. Timers
 * are unref'd so they never hold the process open, and `stop()` exists so tests
 * can run the scheduler with fake timers and tear it down.
 */
export function startBackgroundLoops(
	options: { onError?: (name: LoopName, error: unknown) => void } = {},
): RunningLoops {
	const onError =
		options.onError ?? ((name, error) => console.error(`[loops] ${name} tick failed:`, error));

	const timers = backgroundLoops().map((spec) =>
		setInterval(() => {
			spec.run(new Date()).catch((error) => onError(spec.name, error));
		}, setting(spec.intervalSetting) as number).unref(),
	);

	return {
		stop() {
			for (const timer of timers) clearInterval(timer);
		},
	};
}

/** What one loop did on one tick. `error` is a message, never an Error — this crosses HTTP. */
export interface LoopTickResult {
	name: LoopName;
	ok: boolean;
	result?: unknown;
	error?: string;
}

/**
 * Run every registered loop exactly once, for a deployment that cannot hold a timer.
 *
 * `startBackgroundLoops` assumes a process that stays up. The Next.js dashboard is
 * serverless-shaped and deliberately starts nothing, so on a dashboard-only
 * deployment no sweep has ever run: no inactivity reaping, no deadline
 * enforcement, no compaction, and — the one that breaks the product's central
 * promise — no expired leases. `claim` and `listWork` now sweep their own org in
 * the request path, which covers the org somebody is actively using; this covers
 * the rest, driven by whatever cron the platform already has.
 *
 * Reads the same registry as the timer path, so a loop cannot be scheduled in one
 * and forgotten in the other — which is the failure `loops.ts` exists to prevent,
 * and it would be a poor joke to reintroduce it here.
 *
 * Every loop runs even if an earlier one throws, and failures come back per loop
 * rather than as one 500. A compaction bug must not stop leases being swept, and
 * an operator staring at a cron log needs to know *which* sweep is failing.
 */
export async function runLoopsOnce(now: Date = new Date()): Promise<LoopTickResult[]> {
	const specs = backgroundLoops();
	const results: LoopTickResult[] = [];

	// Sequential, not `Promise.all`. These share one Postgres pool and several take
	// advisory locks; running six at once on a small deployment turns a maintenance
	// tick into a connection-pool spike in the middle of the request path.
	for (const spec of specs) {
		try {
			results.push({ name: spec.name, ok: true, result: await spec.run(now) });
		} catch (error) {
			results.push({
				name: spec.name,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return results;
}

/**
 * Everything a serving process must do once at boot, before taking traffic.
 *
 * `validateConfig` throws on an incoherent combination — the caller exits, by
 * design. `warnScmAttributionAtStartup` is the deploy-time half of ADR 0004's
 * loud-degradation guarantee: a deployment with no SCM OAuth configured falls
 * back to bot-attributed pull requests, and the ADR promises that this is said
 * at startup, naming the property lost, not discovered in a PR's byline weeks
 * later. It was dead code until this call existed — the function, its test and
 * the ADR all asserted a warning nothing ever emitted.
 */
export function runStartupChecks(): {
	attributionWarning: string | null;
	warnings: string[];
} {
	validateConfig();
	// Addressing and database TLS join the same boot check for the same reason the
	// attribution warning is here: all three are misconfigurations that produce a
	// working-looking deployment. An unset HARBOR_PUBLIC_URL refuses every spawn, a
	// transaction-pooled DSN freezes the dashboard, and `sslmode=require` silently
	// skips certificate verification. None of them logs anything on its own.
	return {
		attributionWarning: warnScmAttributionAtStartup(),
		warnings: [...warnAboutAddressing(), ...describeDatabaseTls(databaseUrl()).warnings],
	};
}
