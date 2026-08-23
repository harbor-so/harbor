// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The provider circuit breaker, backed by a table and shared by every session.
 *
 * The breaker is deliberately **global per (org, provider)** and not per session.
 * A per-session breaker sounds safer and is strictly worse: when a provider's API
 * is down, every session independently rediscovers that fact by burning its own
 * `circuitFailureThreshold` spawns and then sitting out its own cooldown. Fifty
 * sessions produce a hundred and fifty doomed create calls aimed at the dependency
 * least able to absorb them, and each of those calls holds a connection, a
 * reservation and an operator's attention. Shared state means the first session
 * pays the discovery cost and the other forty-nine are refused instantly with an
 * accurate reason and a real `retryAfterMs`.
 *
 * Two rules that look like implementation details and are not:
 *
 *  - **No in-process cache.** It is tempting to memoise the row for a second to
 *    save a query. A per-process cache is a per-process breaker, which is the
 *    per-session mistake with extra steps: four app replicas would each need their
 *    own three failures before any of them refused anything, and a deployment that
 *    scales out would silently get a weaker breaker. Every read goes to the table.
 *
 *  - **Only `CIRCUIT_TRIPPING_ERROR_TYPES` count**, and the classification lives in
 *    `decisions.ts` so the reader and the writer cannot drift into disagreeing
 *    about what "transient" means. An `invalid_config` — a typo in an image name —
 *    must never open the circuit: retrying a typo helps nobody, and an open circuit
 *    then hides any concurrent real outage behind a configuration mistake, telling
 *    every session "provider unavailable, retry in 60s" when the truth is "your
 *    image reference has a typo". That is the difference between a five-minute fix
 *    and a day of it.
 *
 * The window reset lives in the UPDATE rather than in a sweeper, and it uses the
 * same `>=`/`<=` boundary as `evaluateCircuitBreaker`. If the writer and the reader
 * disagreed about when a streak ages out, a breaker could report `closed` on a row
 * whose counter keeps climbing — it would open on some later failure for an outage
 * that ended an hour earlier, and nothing would ever reset it.
 */

import { and, eq, sql as raw } from "drizzle-orm";
import { type RepoOverrides, setting } from "@core/kernel/config.js";
import { db } from "@core/schema/index.js";
import { circuitBreakers, events } from "@core/schema/schema.js";
import {
	type CircuitBreakerState,
	type CircuitDecision,
	classifyCircuitContribution,
	evaluateCircuitBreaker,
} from "./decisions.js";

/**
 * A breaker row that was read, or the reason there is no state to reason about.
 *
 * `absent` and `unreadable` are separate members for the reason every other pair
 * of them in this codebase is: one means "this provider has never failed", the
 * other means "we could not ask". They produce the same decision here — see
 * `readCircuit` — and completely different log lines, and a wall of `unreadable`
 * is a database problem while a wall of `absent` is nothing at all.
 */
export type CircuitStateReading =
	| { source: "row"; state: CircuitBreakerState }
	| { source: "absent" }
	| { source: "unreadable"; detail: string };

export interface CircuitReading {
	decision: CircuitDecision;
	reading: CircuitStateReading;
}

/** The zero state: a provider that has never failed inside the window. */
const closedState = (): CircuitBreakerState => ({
	consecutiveFailures: 0,
	firstFailureAt: null,
	lastFailureAt: null,
	openedAt: null,
	lastErrorType: null,
});

/**
 * Read the row for one (org, provider) pair.
 *
 * Errors are captured rather than thrown so the caller can apply its own policy to
 * an unreadable breaker instead of inheriting a decision from a `catch` several
 * frames away.
 */
export async function readCircuitState(
	orgId: string,
	provider: string,
): Promise<CircuitStateReading> {
	try {
		const [row] = await db
			.select()
			.from(circuitBreakers)
			.where(and(eq(circuitBreakers.orgId, orgId), eq(circuitBreakers.provider, provider)))
			.limit(1);
		if (!row) return { source: "absent" };
		return {
			source: "row",
			state: {
				consecutiveFailures: row.consecutiveFailures,
				firstFailureAt: row.firstFailureAt,
				lastFailureAt: row.lastFailureAt,
				openedAt: row.openedAt,
				lastErrorType: row.lastErrorType,
			},
		};
	} catch (error) {
		return { source: "unreadable", detail: (error as Error).message };
	}
}

/**
 * Read the breaker and evaluate it — the only function the spawn path calls.
 *
 * **An unreadable breaker is treated as CLOSED, and that is fail-open on purpose.**
 * The breaker is a health signal protecting a downstream dependency, not an
 * authority check protecting a tenant boundary, so the asymmetry stated everywhere
 * else in this package applies in its liveness direction: being wrong here costs
 * one doomed provider call, which the very next failure record will account for.
 * Failing closed instead would convert a five-second Postgres blip into "no session
 * anywhere may start a sandbox", which is a total outage caused by a component
 * whose entire job is to prevent one.
 *
 * Contrast `readLeaseState` in `manager.ts`, which fails CLOSED for the opposite
 * reason. Both comments exist because someone reading either in isolation will
 * eventually "fix" it to match the other.
 */
export async function readCircuit(
	orgId: string,
	provider: string,
	now: Date,
	overrides?: RepoOverrides,
): Promise<CircuitReading> {
	const reading = await readCircuitState(orgId, provider);
	const state = reading.source === "row" ? reading.state : closedState();
	return { decision: evaluateCircuitBreaker(state, now, overrides), reading };
}

/**
 * What one recorded failure did to the breaker.
 *
 * `contribution` is the word from `classifyCircuitContribution` rather than a
 * boolean, because this value ends up in a log line next to the error and
 * `counts=false` beside a 500 is a mystery while `ignored` beside `invalid_config`
 * is an explanation.
 */
export interface CircuitFailureRecord {
	contribution: "counted" | "ignored";
	consecutiveFailures: number;
	openedAt: Date | null;
	/** `opened` fires exactly once per streak, so a caller can alert on the edge. */
	transition: "opened" | "still_open" | "below_threshold" | "not_counted";
}

/**
 * Record a provider failure against the shared breaker.
 *
 * The counter arithmetic happens inside one statement rather than as read-modify-
 * write in the application, because the interesting moment for a breaker is
 * precisely the moment when many workers are failing at once. A read-then-write
 * loses increments under exactly that concurrency, and the visible symptom is a
 * breaker that never opens during a real outage — the one condition it exists for
 * — while passing every single-threaded test.
 *
 * A streak whose last failure is older than `circuitWindowMs` restarts at one and
 * clears `openedAt`. Without that reset the counter is cumulative, and a provider
 * that failed twice in March and once in June opens the circuit in June for an
 * outage that never happened.
 */
export async function recordProviderFailure(
	orgId: string,
	provider: string,
	errorType: string,
	now: Date,
	overrides?: RepoOverrides,
): Promise<CircuitFailureRecord> {
	if (classifyCircuitContribution(errorType) === "ignored") {
		// Deliberately not written at all, not even as a timestamp. Touching
		// `lastFailureAt` for an ignored error would keep an aged-out streak alive
		// across the window boundary, so three transient failures spread over an hour
		// with config errors in between would open the circuit.
		const reading = await readCircuitState(orgId, provider);
		return {
			contribution: "ignored",
			consecutiveFailures: reading.source === "row" ? reading.state.consecutiveFailures : 0,
			openedAt: reading.source === "row" ? reading.state.openedAt : null,
			transition: "not_counted",
		};
	}

	const threshold = setting("circuitFailureThreshold", overrides);
	// ISO strings with an explicit cast rather than `Date` objects. A `Date` bound
	// inside a raw fragment reaches the driver without the column mapper that
	// normally encodes it, and the failure is a runtime type error from deep inside
	// the socket writer rather than anything resembling a query problem.
	const at = now.toISOString();
	const windowStart = new Date(now.getTime() - setting("circuitWindowMs", overrides)).toISOString();

	// `<=` mirrors the `>=` in `evaluateCircuitBreaker`: a streak whose last failure
	// is *exactly* one window old has aged out in both places. If the two boundaries
	// disagreed, one failure per window would keep a counter climbing that every
	// reader reports as closed.
	const agedOut = raw`(${circuitBreakers.lastFailureAt} is null or ${circuitBreakers.lastFailureAt} <= ${windowStart}::timestamptz)`;
	const nextCount = raw`(case when ${agedOut} then 1 else ${circuitBreakers.consecutiveFailures} + 1 end)`;

	const [row] = await db
		.insert(circuitBreakers)
		.values({
			orgId,
			provider,
			consecutiveFailures: 1,
			firstFailureAt: now,
			lastFailureAt: now,
			// A threshold of one is a legal configuration, so the first failure has to
			// be able to open the breaker on the insert path too.
			openedAt: threshold <= 1 ? now : null,
			lastErrorType: errorType,
		})
		.onConflictDoUpdate({
			target: [circuitBreakers.orgId, circuitBreakers.provider],
			set: {
				consecutiveFailures: nextCount,
				firstFailureAt: raw`(case when ${agedOut} then ${at}::timestamptz else coalesce(${circuitBreakers.firstFailureAt}, ${at}::timestamptz) end)`,
				lastFailureAt: now,
				lastErrorType: errorType,
				// `coalesce` keeps the ORIGINAL opening instant, because the cooldown is
				// measured from it. Re-stamping it on every subsequent failure means a
				// provider that keeps failing never becomes half-open, so the breaker
				// never probes, never recovers, and stays open until a human notices.
				openedAt: raw`(case
					when ${agedOut} then (case when 1 >= ${threshold} then ${at}::timestamptz else null end)
					when ${nextCount} >= ${threshold} then coalesce(${circuitBreakers.openedAt}, ${at}::timestamptz)
					else ${circuitBreakers.openedAt}
				end)`,
			},
		})
		.returning({
			consecutiveFailures: circuitBreakers.consecutiveFailures,
			openedAt: circuitBreakers.openedAt,
		});

	const consecutiveFailures = row?.consecutiveFailures ?? 1;
	const openedAt = row?.openedAt ?? null;
	const transition =
		openedAt === null
			? "below_threshold"
			: openedAt.getTime() === now.getTime()
				? "opened"
				: "still_open";

	// The trip becomes a durable event, recorded HERE rather than at any caller,
	// because this is the one place that knows the transition fired and a caller
	// can forget. A gauge sampled at scrape time misses a breaker that opens and
	// closes between scrapes entirely — the metrics doc claimed "breaker trips"
	// while emitting only current state, so a short outage overnight left no
	// trace anywhere an alert could see. `transition === "opened"` fires exactly
	// once per streak, which is exactly the edge a counter wants. Best-effort:
	// telemetry must never turn a recorded failure into a thrown one.
	if (transition === "opened") {
		try {
			await db.insert(events).values({
				orgId,
				type: "circuit_opened",
				payload: { provider, error_type: errorType, consecutive_failures: consecutiveFailures },
			});
		} catch (error) {
			console.error("[circuit] trip event failed:", (error as Error).message);
		}
	}

	return { contribution: "counted", consecutiveFailures, openedAt, transition };
}

/**
 * Clear the breaker after a spawn that worked.
 *
 * `openedAt` is authoritative for `evaluateCircuitBreaker`, so whoever proves the
 * provider is healthy must clear it. Without this, the half-open probe that
 * succeeds leaves the row exactly as it was, the next reader still sees an open
 * breaker, and the only thing that ever recovers the circuit is the window ageing
 * out — which means a provider that came back in ten seconds is refused for the
 * full five minutes anyway.
 *
 * Only an existing row is touched. Inserting a zeroed row on every success would
 * add a write to the hot path to record the absence of a problem.
 */
export async function recordProviderSuccess(
	orgId: string,
	provider: string,
): Promise<{ reset: boolean }> {
	const cleared = await db
		.update(circuitBreakers)
		.set({
			consecutiveFailures: 0,
			firstFailureAt: null,
			lastFailureAt: null,
			openedAt: null,
			lastErrorType: null,
		})
		.where(and(eq(circuitBreakers.orgId, orgId), eq(circuitBreakers.provider, provider)))
		.returning({ id: circuitBreakers.id });
	return { reset: cleared.length > 0 };
}
