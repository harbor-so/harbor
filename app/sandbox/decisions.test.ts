// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Zero mocks, zero database, exact boundaries.
 *
 * This suite is the reason `decisions.ts` has no I/O in it. Every assertion below
 * is a millisecond either side of a threshold, or a cell in a matrix of policy
 * inputs — the two shapes of bug that actually reach production in lifecycle
 * code, and both of them unaffordable to cover against a function that reads a
 * clock and a database. Nothing here sleeps, nothing here stubs, and the whole
 * file runs in single-digit milliseconds, which is what makes it plausible that
 * somebody will keep adding to it.
 *
 * Thresholds are read back through `setting()` rather than written as literals,
 * so the boundaries stay correct when a default is retuned, and so a test cannot
 * accidentally become the second place a timeout is defined.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { setting, type RepoOverrides } from "@core/kernel/config.js";
import { PROVIDER_ERROR_TYPES, SANDBOX_STATUSES } from "../contracts/index.js";
import {
	classifyCircuitContribution,
	classifyLiveness,
	classifyProviderError,
	evaluateCircuitBreaker,
	evaluateConnectingTimeout,
	evaluateDestruction,
	evaluateExecutionTimeout,
	evaluateHeartbeatHealth,
	evaluateInactivityTimeout,
	evaluateSpawnDecision,
	isDeadSandboxStatus,
	isKnownSandboxStatus,
	isOpenAttemptStatus,
	isReconnectBlockedStatus,
	resolveBootMode,
	type CircuitBreakerState,
	type CircuitDecision,
	type DestructionAuthority,
	type LeaseState,
	type SpawnDecisionInput,
} from "./decisions.js";

/** A fixed instant. Every test is written relative to it; nothing reads a clock. */
const NOW = new Date("2026-01-01T12:00:00.000Z");

/** `ago(5)` is five milliseconds before NOW. Reads the way the assertions think. */
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

// ---------------------------------------------------------------------------
// The import boundary
// ---------------------------------------------------------------------------

describe("module boundary", () => {
	/**
	 * The purity of this module is a property somebody can break in one line, by
	 * importing `db` "just to look up the repo's overrides". The moment that
	 * happens every test above needs a database, the suite slows by three orders of
	 * magnitude, and the boundary assertions become impossible to write. Asserting
	 * the import list mechanically is the only version of "keep this pure" that
	 * survives contact with a hurry.
	 */
	const source = readFileSync(new URL("./decisions.ts", import.meta.url), "utf8");
	const specifiers = [...source.matchAll(/\bfrom\s+"([^"]+)"/g)].map((match) => match[1]!);

	it("imports only from contracts and config", () => {
		expect(new Set(specifiers)).toEqual(
			new Set(["@core/kernel/config.js", "../contracts/index.js"]),
		);
	});

	it("imports nothing from the manager, the database or any driver", () => {
		// The schema lives at `core/schema/` since the licence-zone split; the deny-list
		// has to name where the database actually is now, or it matches nothing and
		// quietly stops being a guard at all.
		for (const specifier of specifiers) {
			expect(specifier).not.toMatch(/manager|core\/schema\/|drizzle|postgres|node:/);
		}
	});

	it("has no dynamic import and no require, which would evade the check above", () => {
		expect(source).not.toMatch(/\brequire\s*\(/);
		expect(source).not.toMatch(/\bimport\s*\(/);
	});
});

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

describe("liveness is a deny-list", () => {
	it("treats a status invented six months from now as LIVE, not dead", () => {
		// The whole point of the deny-list. An allow-list would return dead here, and
		// every sandbox in the new status would be silently abandoned mid-session.
		expect(isDeadSandboxStatus("hibernating")).toBe(false);
		expect(classifyLiveness("hibernating")).toEqual({
			liveness: "live",
			reason: "unrecognised_status",
		});
	});

	it("distinguishes a known-live status from an unrecognised one", () => {
		expect(classifyLiveness("busy")).toEqual({ liveness: "live", reason: "not_deny_listed" });
	});

	it("reports the three deny-listed statuses as dead", () => {
		expect(isDeadSandboxStatus("stopped")).toBe(true);
		expect(isDeadSandboxStatus("stale")).toBe(true);
		expect(isDeadSandboxStatus("failed")).toBe(true);
	});

	it("classifies every declared status without throwing", () => {
		for (const status of SANDBOX_STATUSES) {
			expect(["live", "dead"]).toContain(classifyLiveness(status).liveness);
			expect(isKnownSandboxStatus(status)).toBe(true);
		}
		expect(isKnownSandboxStatus("hibernating")).toBe(false);
	});

	it("keeps `failed` reconnectable even though it is dead", () => {
		// A slow boot can outlive the connecting watchdog and turn up with a working
		// bridge. Refusing it discards a sandbox that is demonstrably alive and makes
		// the user pay for a second cold boot while the first keeps billing.
		expect(isDeadSandboxStatus("failed")).toBe(true);
		expect(isReconnectBlockedStatus("failed")).toBe(false);
	});

	it("blocks reconnection to boxes we ourselves terminated", () => {
		expect(isReconnectBlockedStatus("stopped")).toBe(true);
		expect(isReconnectBlockedStatus("stale")).toBe(true);
		expect(isReconnectBlockedStatus("ready")).toBe(false);
		expect(isReconnectBlockedStatus("hibernating")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

const breaker = (patch: Partial<CircuitBreakerState> = {}): CircuitBreakerState => ({
	consecutiveFailures: 0,
	firstFailureAt: null,
	lastFailureAt: null,
	openedAt: null,
	lastErrorType: null,
	...patch,
});

describe("evaluateCircuitBreaker", () => {
	const threshold = () => setting("circuitFailureThreshold");
	const windowMs = () => setting("circuitWindowMs");
	const cooldownMs = () => setting("circuitCooldownMs");

	it("is closed for a provider that has never failed", () => {
		expect(evaluateCircuitBreaker(breaker(), NOW)).toEqual({ state: "closed" });
	});

	it("is closed one failure below the threshold", () => {
		const state = breaker({
			consecutiveFailures: threshold() - 1,
			lastFailureAt: ago(1_000),
			lastErrorType: "transient",
		});
		expect(evaluateCircuitBreaker(state, NOW)).toEqual({ state: "closed" });
	});

	it("opens at exactly the threshold", () => {
		const state = breaker({
			consecutiveFailures: threshold(),
			lastFailureAt: ago(1_000),
			openedAt: ago(1_000),
			lastErrorType: "transient",
		});
		const decision = evaluateCircuitBreaker(state, NOW);
		expect(decision.state).toBe("open");
		if (decision.state !== "open") throw new Error("unreachable");
		expect(decision.reason).toBe("failure_threshold");
		expect(decision.retryAfterMs).toBe(cooldownMs() - 1_000);
	});

	it("stays open above the threshold", () => {
		const state = breaker({
			consecutiveFailures: threshold() + 1,
			lastFailureAt: ago(1_000),
			openedAt: ago(1_000),
			lastErrorType: "unknown",
		});
		expect(evaluateCircuitBreaker(state, NOW).state).toBe("open");
	});

	it("counts a failure one millisecond inside the window", () => {
		const state = breaker({
			consecutiveFailures: threshold(),
			lastFailureAt: ago(windowMs() - 1),
			openedAt: ago(windowMs() - 1),
			lastErrorType: "transient",
		});
		// Inside the window, and long past the cooldown, so a probe is due.
		expect(evaluateCircuitBreaker(state, NOW)).toEqual({ state: "half_open" });
	});

	it("stops counting a failure exactly one window old", () => {
		const state = breaker({
			consecutiveFailures: threshold() * 10,
			lastFailureAt: ago(windowMs()),
			openedAt: ago(windowMs()),
			lastErrorType: "transient",
		});
		expect(evaluateCircuitBreaker(state, NOW)).toEqual({ state: "closed" });
	});

	it("stops counting a failure older than the window", () => {
		const state = breaker({
			consecutiveFailures: threshold() * 10,
			lastFailureAt: ago(windowMs() + 1),
			openedAt: ago(windowMs() + 1),
			lastErrorType: "transient",
		});
		expect(evaluateCircuitBreaker(state, NOW)).toEqual({ state: "closed" });
	});

	it("is still open one millisecond before the cooldown elapses", () => {
		const state = breaker({
			consecutiveFailures: threshold(),
			lastFailureAt: ago(cooldownMs() - 1),
			openedAt: ago(cooldownMs() - 1),
			lastErrorType: "transient",
		});
		const decision = evaluateCircuitBreaker(state, NOW);
		expect(decision.state).toBe("open");
		if (decision.state !== "open") throw new Error("unreachable");
		expect(decision.retryAfterMs).toBe(1);
	});

	it("goes half-open at exactly the cooldown", () => {
		const state = breaker({
			consecutiveFailures: threshold(),
			lastFailureAt: ago(cooldownMs()),
			openedAt: ago(cooldownMs()),
			lastErrorType: "transient",
		});
		expect(evaluateCircuitBreaker(state, NOW)).toEqual({ state: "half_open" });
	});

	it("never reports a retry further out than the cooldown, even with a skewed clock", () => {
		// A row written by a machine whose clock runs ahead. Unclamped, the caller
		// would schedule its retry for the skew plus the cooldown.
		const state = breaker({
			consecutiveFailures: threshold(),
			lastFailureAt: new Date(NOW.getTime() + 3_600_000),
			openedAt: new Date(NOW.getTime() + 3_600_000),
			lastErrorType: "transient",
		});
		const decision = evaluateCircuitBreaker(state, NOW);
		expect(decision.state).toBe("open");
		if (decision.state !== "open") throw new Error("unreachable");
		expect(decision.retryAfterMs).toBe(cooldownMs());
	});

	it("refuses to open on a permanent error however high the count", () => {
		// The failure this prevents: an image name with a typo takes the provider out
		// for the whole organisation, and every session is told to retry in a minute
		// while the actual fix is one config field.
		for (const errorType of ["invalid_config", "not_found", "unauthorized"] as const) {
			const state = breaker({
				consecutiveFailures: threshold() * 100,
				lastFailureAt: ago(1_000),
				openedAt: ago(1_000),
				lastErrorType: errorType,
			});
			expect(evaluateCircuitBreaker(state, NOW)).toEqual({ state: "closed" });
		}
	});

	it("opens on every tripping error type", () => {
		for (const errorType of ["transient", "rate_limited", "quota_exceeded", "unknown"] as const) {
			const state = breaker({
				consecutiveFailures: threshold(),
				lastFailureAt: ago(1),
				openedAt: ago(1),
				lastErrorType: errorType,
			});
			expect(evaluateCircuitBreaker(state, NOW).state).toBe("open");
		}
	});

	it("treats an error type this build has never heard of as tripping", () => {
		// Deny-list again: only a *known permanent* error suppresses the breaker, so
		// a provider inventing a new error shape cannot silently disable it.
		const state = breaker({
			consecutiveFailures: threshold(),
			lastFailureAt: ago(1),
			openedAt: ago(1),
			lastErrorType: "teapot_overheated",
		});
		expect(evaluateCircuitBreaker(state, NOW).state).toBe("open");
	});

	it("cools down a row whose writer crashed before setting openedAt", () => {
		const state = breaker({
			consecutiveFailures: threshold(),
			lastFailureAt: ago(cooldownMs()),
			openedAt: null,
			lastErrorType: "transient",
		});
		expect(evaluateCircuitBreaker(state, NOW)).toEqual({ state: "half_open" });
	});

	it("honours a per-repository threshold override", () => {
		const overrides: RepoOverrides = { circuitFailureThreshold: 1 };
		const state = breaker({
			consecutiveFailures: 1,
			lastFailureAt: ago(1),
			lastErrorType: "transient",
		});
		expect(evaluateCircuitBreaker(state, NOW).state).toBe("closed");
		expect(evaluateCircuitBreaker(state, NOW, overrides).state).toBe("open");
	});
});

describe("classifyCircuitContribution", () => {
	it("ignores exactly the permanent error types and counts everything else", () => {
		const counted = PROVIDER_ERROR_TYPES.filter(
			(type) => classifyCircuitContribution(type) === "counts",
		);
		expect(new Set(counted)).toEqual(
			new Set(["transient", "rate_limited", "quota_exceeded", "unknown"]),
		);
	});

	it("counts an unrecognised string", () => {
		expect(classifyCircuitContribution("teapot_overheated")).toBe("counts");
	});
});

// ---------------------------------------------------------------------------
// Spawn admission
// ---------------------------------------------------------------------------

const CLOSED: CircuitDecision = { state: "closed" };
const HALF_OPEN: CircuitDecision = { state: "half_open" };
const OPEN: CircuitDecision = {
	state: "open",
	reason: "failure_threshold",
	retryAfterMs: 12_345,
	failures: 3,
	lastErrorType: "transient",
};

const spawnInput = (patch: Partial<SpawnDecisionInput> = {}): SpawnDecisionInput => ({
	circuit: CLOSED,
	lease: "held",
	existingSandbox: null,
	orphan: null,
	budgetRemainingMicroUsd: 1_000_000,
	sessionPausedReason: null,
	queueDepth: 0,
	...patch,
});

describe("evaluateSpawnDecision — the lease × circuit × budget matrix", () => {
	const leases: LeaseState[] = ["held", "not_held", "unknown"];
	const circuits: Array<[string, CircuitDecision]> = [
		["closed", CLOSED],
		["half_open", HALF_OPEN],
		["open", OPEN],
	];
	const budgets: Array<[string, number]> = [
		["remaining", 1],
		["exhausted", 0],
	];

	for (const lease of leases) {
		for (const [circuitName, circuit] of circuits) {
			for (const [budgetName, budgetRemainingMicroUsd] of budgets) {
				it(`lease=${lease} circuit=${circuitName} budget=${budgetName}`, () => {
					const decision = evaluateSpawnDecision(
						spawnInput({ lease, circuit, budgetRemainingMicroUsd }),
					);

					// Authority is evaluated before anything else, so an unreadable or
					// foreign lease produces the same refusal regardless of the rest.
					if (lease === "unknown") {
						expect(decision).toMatchObject({
							decision: "refuse",
							reason: "lease_state_unknown",
						});
						return;
					}
					if (lease === "not_held") {
						expect(decision).toMatchObject({ decision: "refuse", reason: "lease_not_held" });
						return;
					}
					// Budget outranks the circuit: it is the durable reason, and telling a
					// user to retry in a minute when they are out of money is a lie.
					if (budgetName === "exhausted") {
						expect(decision).toMatchObject({ decision: "refuse", reason: "budget_exhausted" });
						return;
					}
					if (circuitName === "open") {
						expect(decision).toMatchObject({
							decision: "refuse",
							reason: "circuit_open",
							retryAfterMs: OPEN.retryAfterMs,
						});
						return;
					}
					// Closed and half-open both spawn: the half-open attempt is the probe,
					// and it is the lease, not this function, that makes it exactly one.
					expect(decision).toEqual({ decision: "spawn" });
				});
			}
		}
	}
});

describe("evaluateSpawnDecision — authority fails closed", () => {
	it("separates 'somebody else holds it' from 'we could not tell'", () => {
		const unknown = evaluateSpawnDecision(spawnInput({ lease: "unknown" }));
		const notHeld = evaluateSpawnDecision(spawnInput({ lease: "not_held" }));
		expect(unknown).toMatchObject({ reason: "lease_state_unknown" });
		expect(notHeld).toMatchObject({ reason: "lease_not_held" });
		// Same action, different reasons — one pages the DBA, the other the scheduler.
		expect(unknown).not.toEqual(notHeld);
	});

	it("refuses an unknown lease even when everything else is perfect", () => {
		const decision = evaluateSpawnDecision(
			spawnInput({ lease: "unknown", orphan: { externalId: "ctr-1" } }),
		);
		expect(decision).toMatchObject({ decision: "refuse", reason: "lease_state_unknown" });
	});
});

describe("evaluateSpawnDecision — budget", () => {
	it("spawns on the last micro-dollar and refuses at zero and below", () => {
		expect(evaluateSpawnDecision(spawnInput({ budgetRemainingMicroUsd: 1 }))).toEqual({
			decision: "spawn",
		});
		expect(evaluateSpawnDecision(spawnInput({ budgetRemainingMicroUsd: 0 }))).toMatchObject({
			reason: "budget_exhausted",
		});
		expect(evaluateSpawnDecision(spawnInput({ budgetRemainingMicroUsd: -1 }))).toMatchObject({
			reason: "budget_exhausted",
		});
	});

	it("refuses a fractional budget rather than rounding it", () => {
		// Micro-USD is an integer everywhere. A float here means an upstream bug, and
		// the safe direction to fail on a spend cap is closed.
		expect(evaluateSpawnDecision(spawnInput({ budgetRemainingMicroUsd: 0.4 }))).toMatchObject({
			decision: "refuse",
			reason: "budget_exhausted",
		});
	});
});

describe("evaluateSpawnDecision — queue depth", () => {
	it("admits one below the cap, refuses at the cap and above", () => {
		const cap = setting("maxQueueDepth");
		expect(evaluateSpawnDecision(spawnInput({ queueDepth: cap - 1 }))).toEqual({
			decision: "spawn",
		});
		expect(evaluateSpawnDecision(spawnInput({ queueDepth: cap }))).toMatchObject({
			reason: "queue_full",
		});
		expect(evaluateSpawnDecision(spawnInput({ queueDepth: cap + 1 }))).toMatchObject({
			reason: "queue_full",
		});
	});

	it("honours a per-repository cap", () => {
		const overrides: RepoOverrides = { maxQueueDepth: 2 };
		expect(evaluateSpawnDecision(spawnInput({ queueDepth: 2, overrides }))).toMatchObject({
			reason: "queue_full",
		});
		expect(evaluateSpawnDecision(spawnInput({ queueDepth: 1, overrides }))).toEqual({
			decision: "spawn",
		});
	});
});

describe("evaluateSpawnDecision — pause, policy and existing boxes", () => {
	it("reports a budget pause as budget_exhausted, not session_paused", () => {
		expect(
			evaluateSpawnDecision(spawnInput({ sessionPausedReason: "budget_exhausted" })),
		).toMatchObject({ decision: "refuse", reason: "budget_exhausted" });
	});

	it("reports any other pause as session_paused and says which", () => {
		const decision = evaluateSpawnDecision(spawnInput({ sessionPausedReason: "paused_by_owner" }));
		expect(decision).toMatchObject({ decision: "refuse", reason: "session_paused" });
		if (decision.decision !== "refuse") throw new Error("unreachable");
		expect(decision.detail).toContain("paused_by_owner");
	});

	it("keeps an undetermined policy distinguishable from a denial in the detail", () => {
		const denied = evaluateSpawnDecision(
			spawnInput({ policy: { outcome: "denied", detail: "repo is archived" } }),
		);
		const undetermined = evaluateSpawnDecision(
			spawnInput({ policy: { outcome: "undetermined", detail: "policy service timed out" } }),
		);
		expect(denied).toMatchObject({ reason: "policy_denied", detail: "repo is archived" });
		expect(undetermined).toMatchObject({ reason: "policy_denied" });
		if (undetermined.decision !== "refuse") throw new Error("unreachable");
		expect(undetermined.detail).toContain("could not be evaluated");
	});

	it("refuses a second box for a session that already has a live one", () => {
		for (const status of SANDBOX_STATUSES.filter((s) => !isDeadSandboxStatus(s))) {
			const decision = evaluateSpawnDecision(
				spawnInput({ existingSandbox: { status, externalId: "ctr-1" } }),
			);
			expect(decision).toMatchObject({ decision: "refuse", reason: "already_active" });
		}
	});

	it("spawns over a dead box", () => {
		for (const status of SANDBOX_STATUSES.filter(isDeadSandboxStatus)) {
			expect(
				evaluateSpawnDecision(spawnInput({ existingSandbox: { status, externalId: "ctr-1" } })),
			).toEqual({ decision: "spawn" });
		}
	});

	it("treats an unrecognised existing status as live, and so refuses", () => {
		// Fail-open on liveness, seen from the admission side: an unknown status means
		// we may already have a box, and spawning a second one gives the session two
		// working copies of the same branch.
		expect(
			evaluateSpawnDecision(
				spawnInput({ existingSandbox: { status: "hibernating", externalId: "ctr-1" } }),
			),
		).toMatchObject({ decision: "refuse", reason: "already_active" });
	});
});

describe("evaluateSpawnDecision — orphan adoption", () => {
	it("adopts an orphan rather than spawning", () => {
		expect(evaluateSpawnDecision(spawnInput({ orphan: { externalId: "ctr-9" } }))).toEqual({
			decision: "adopt",
			externalId: "ctr-9",
			reason: "reconciled_orphan",
		});
	});

	it("adopts even with the circuit open, no budget and the session paused", () => {
		// The box already exists and is already billing. Refusing to adopt strands it
		// with no row pointing at it, so nothing will ever stop it.
		const decision = evaluateSpawnDecision(
			spawnInput({
				orphan: { externalId: "ctr-9" },
				circuit: OPEN,
				budgetRemainingMicroUsd: 0,
				sessionPausedReason: "budget_exhausted",
				queueDepth: 10_000,
			}),
		);
		expect(decision).toMatchObject({ decision: "adopt", externalId: "ctr-9" });
	});

	it("does not adopt for a caller with no authority", () => {
		for (const lease of ["not_held", "unknown"] as const) {
			expect(
				evaluateSpawnDecision(spawnInput({ lease, orphan: { externalId: "ctr-9" } })),
			).toMatchObject({ decision: "refuse" });
		}
	});
});

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

describe("evaluateInactivityTimeout", () => {
	const thresholdMs = () => setting("sandboxInactivityTimeoutMs");

	it("is active one millisecond before the threshold", () => {
		const decision = evaluateInactivityTimeout(
			{ status: "idle", lastActivityAt: ago(thresholdMs() - 1), createdAt: ago(thresholdMs()) },
			NOW,
		);
		expect(decision).toMatchObject({ verdict: "active", idleMs: thresholdMs() - 1 });
	});

	it("expires exactly at the threshold", () => {
		const decision = evaluateInactivityTimeout(
			{ status: "idle", lastActivityAt: ago(thresholdMs()), createdAt: ago(thresholdMs()) },
			NOW,
		);
		expect(decision).toMatchObject({ verdict: "expired", idleMs: thresholdMs() });
	});

	it("expires past the threshold", () => {
		expect(
			evaluateInactivityTimeout(
				{
					status: "ready",
					lastActivityAt: ago(thresholdMs() + 1),
					createdAt: ago(thresholdMs() + 1),
				},
				NOW,
			).verdict,
		).toBe("expired");
	});

	it("measures a box that never did anything from its creation", () => {
		// Exempting it — which a null check returning 'active' would do — makes a box
		// that booted and was never used live forever, the purest form of waste.
		expect(
			evaluateInactivityTimeout(
				{ status: "ready", lastActivityAt: null, createdAt: ago(thresholdMs()) },
				NOW,
			).verdict,
		).toBe("expired");
	});

	it("ignores boxes that are not live yet or are already gone", () => {
		for (const status of ["requested", "spawning", "stopping", "stopped", "stale", "failed"]) {
			expect(
				evaluateInactivityTimeout(
					{ status, lastActivityAt: ago(thresholdMs() * 10), createdAt: ago(thresholdMs() * 10) },
					NOW,
				),
			).toEqual({ verdict: "not_applicable", reason: "not_live" });
		}
	});

	it("does not reap a status it does not recognise", () => {
		expect(
			evaluateInactivityTimeout(
				{ status: "hibernating", lastActivityAt: ago(thresholdMs() * 10), createdAt: ago(1) },
				NOW,
			),
		).toEqual({ verdict: "not_applicable", reason: "unrecognised_status" });
	});

	it("honours a per-repository timeout", () => {
		const overrides: RepoOverrides = { sandboxInactivityTimeoutMs: 60_000 };
		const sandbox = { status: "idle", lastActivityAt: ago(60_000), createdAt: ago(60_000) };
		expect(evaluateInactivityTimeout(sandbox, NOW).verdict).toBe("active");
		expect(evaluateInactivityTimeout(sandbox, NOW, overrides).verdict).toBe("expired");
	});
});

describe("evaluateHeartbeatHealth", () => {
	const thresholdMs = () => setting("sandboxStaleHeartbeatMs");

	it("is healthy one millisecond before the stale threshold", () => {
		expect(
			evaluateHeartbeatHealth(
				{ status: "busy", lastHeartbeatAt: ago(thresholdMs() - 1), readyAt: ago(600_000) },
				NOW,
			),
		).toMatchObject({ verdict: "healthy", ageMs: thresholdMs() - 1 });
	});

	it("is stale exactly at the threshold", () => {
		expect(
			evaluateHeartbeatHealth(
				{ status: "busy", lastHeartbeatAt: ago(thresholdMs()), readyAt: ago(600_000) },
				NOW,
			),
		).toMatchObject({ verdict: "stale", ageMs: thresholdMs() });
	});

	it("is stale past the threshold", () => {
		expect(
			evaluateHeartbeatHealth(
				{ status: "ready", lastHeartbeatAt: ago(thresholdMs() + 1), readyAt: ago(600_000) },
				NOW,
			).verdict,
		).toBe("stale");
	});

	it("measures a box that has never heartbeat from when it reported ready", () => {
		expect(
			evaluateHeartbeatHealth(
				{ status: "ready", lastHeartbeatAt: null, readyAt: ago(thresholdMs()) },
				NOW,
			).verdict,
		).toBe("stale");
		expect(
			evaluateHeartbeatHealth(
				{ status: "ready", lastHeartbeatAt: null, readyAt: ago(thresholdMs() - 1) },
				NOW,
			).verdict,
		).toBe("healthy");
	});

	it("declines to judge a box that has not finished booting", () => {
		// It is not supposed to be heartbeating during a four-minute npm ci. That box
		// belongs to the connecting watchdog, which measures the thing that is late.
		for (const status of ["requested", "spawning"]) {
			expect(
				evaluateHeartbeatHealth({ status, lastHeartbeatAt: null, readyAt: null }, NOW),
			).toEqual({ verdict: "unknown", reason: "not_yet_ready" });
		}
	});

	it("declines to judge a live box with no ready timestamp", () => {
		expect(
			evaluateHeartbeatHealth({ status: "ready", lastHeartbeatAt: null, readyAt: null }, NOW),
		).toEqual({ verdict: "unknown", reason: "not_yet_ready" });
	});

	it("declines to judge an unrecognised status — liveness fails open", () => {
		expect(
			evaluateHeartbeatHealth(
				{ status: "hibernating", lastHeartbeatAt: ago(thresholdMs() * 10), readyAt: ago(1) },
				NOW,
			),
		).toEqual({ verdict: "unknown", reason: "unrecognised_status" });
	});

	it("says nothing about a terminal box", () => {
		expect(
			evaluateHeartbeatHealth(
				{ status: "stopped", lastHeartbeatAt: ago(thresholdMs() * 10), readyAt: ago(1) },
				NOW,
			),
		).toEqual({ verdict: "not_applicable", reason: "terminal_status" });
	});
});

describe("evaluateConnectingTimeout", () => {
	const thresholdMs = () => setting("sandboxBootTimeoutMs");

	it("is still connecting one millisecond before the boot timeout", () => {
		expect(
			evaluateConnectingTimeout(
				{ status: "spawning", createdAt: ago(thresholdMs() - 1), readyAt: null },
				NOW,
			),
		).toMatchObject({ verdict: "connecting", elapsedMs: thresholdMs() - 1 });
	});

	it("times out exactly at the boot timeout", () => {
		expect(
			evaluateConnectingTimeout(
				{ status: "spawning", createdAt: ago(thresholdMs()), readyAt: null },
				NOW,
			),
		).toMatchObject({ verdict: "timed_out", elapsedMs: thresholdMs() });
	});

	it("times out past the boot timeout", () => {
		expect(
			evaluateConnectingTimeout(
				{ status: "requested", createdAt: ago(thresholdMs() + 1), readyAt: null },
				NOW,
			).verdict,
		).toBe("timed_out");
	});

	it("never times out a box that has already reported ready", () => {
		// readyAt is the fact; the status is a cache of it. A status that has not
		// caught up must not resurrect a timeout for a box that is already serving.
		expect(
			evaluateConnectingTimeout(
				{ status: "spawning", createdAt: ago(thresholdMs() * 10), readyAt: ago(1) },
				NOW,
			),
		).toEqual({ verdict: "not_applicable", reason: "already_ready" });
		expect(
			evaluateConnectingTimeout(
				{ status: "ready", createdAt: ago(thresholdMs() * 10), readyAt: null },
				NOW,
			),
		).toEqual({ verdict: "not_applicable", reason: "already_ready" });
	});

	it("says nothing about terminal or unrecognised statuses", () => {
		expect(
			evaluateConnectingTimeout(
				{ status: "failed", createdAt: ago(thresholdMs() * 10), readyAt: null },
				NOW,
			),
		).toEqual({ verdict: "not_applicable", reason: "terminal_status" });
		expect(
			evaluateConnectingTimeout(
				{ status: "hibernating", createdAt: ago(thresholdMs() * 10), readyAt: null },
				NOW,
			),
		).toEqual({ verdict: "not_applicable", reason: "unrecognised_status" });
	});
});

describe("evaluateExecutionTimeout", () => {
	const thresholdMs = () => setting("agentTurnTimeoutMs");

	it("reports nothing to time when no turn is running", () => {
		expect(evaluateExecutionTimeout(null, NOW)).toEqual({ verdict: "not_running" });
	});

	it("is running one millisecond before the limit, with the remainder", () => {
		expect(evaluateExecutionTimeout(ago(thresholdMs() - 1), NOW)).toEqual({
			verdict: "running",
			elapsedMs: thresholdMs() - 1,
			remainingMs: 1,
			thresholdMs: thresholdMs(),
		});
	});

	it("times out exactly at the limit", () => {
		expect(evaluateExecutionTimeout(ago(thresholdMs()), NOW)).toMatchObject({
			verdict: "timed_out",
			elapsedMs: thresholdMs(),
		});
	});

	it("times out past the limit", () => {
		expect(evaluateExecutionTimeout(ago(thresholdMs() + 1), NOW).verdict).toBe("timed_out");
	});

	it("honours a per-repository turn limit", () => {
		const overrides: RepoOverrides = { agentTurnTimeoutMs: 1_000 };
		expect(evaluateExecutionTimeout(ago(1_000), NOW).verdict).toBe("running");
		expect(evaluateExecutionTimeout(ago(1_000), NOW, overrides).verdict).toBe("timed_out");
	});
});

// ---------------------------------------------------------------------------
// Boot mode
// ---------------------------------------------------------------------------

describe("resolveBootMode", () => {
	const capable = { supportsSandboxTimeout: true, supportsSnapshots: true, supportsRestore: true };
	/** A BootModeInput with the two fast-path inputs absent unless a test sets them. */
	const input = (over: Partial<Parameters<typeof resolveBootMode>[0]> = {}) => ({
		snapshotRef: null,
		repoImageRef: null,
		capabilities: capable,
		...over,
	});

	it("is fresh by default, because both fast paths are off by default", () => {
		expect(resolveBootMode(input({ snapshotRef: "snap-1" }))).toEqual({
			mode: "fresh",
			reason: "snapshots_disabled",
		});
	});

	it("restores only with the flag, a ref and a capable provider", () => {
		const overrides: RepoOverrides = { enableSnapshots: true };
		expect(resolveBootMode(input({ snapshotRef: "snap-1", overrides }))).toEqual({
			mode: "snapshot_restore",
			reason: "snapshot_available",
		});
		expect(resolveBootMode(input({ snapshotRef: null, overrides }))).toEqual({
			mode: "fresh",
			reason: "no_snapshot_ref",
		});
		expect(
			resolveBootMode(
				input({ snapshotRef: "snap-1", capabilities: { ...capable, supportsRestore: false }, overrides }),
			),
		).toEqual({ mode: "fresh", reason: "provider_cannot_restore" });
	});

	it("boots a fresh repo image even with snapshots off — it is an independent optimisation", () => {
		expect(resolveBootMode(input({ repoImageRef: "harbor-repo-x:sha" }))).toEqual({
			mode: "repo_image",
			reason: "repo_image_fresh",
		});
	});

	it("prefers a session's own snapshot over a generic repo image when both are usable", () => {
		const overrides: RepoOverrides = { enableSnapshots: true };
		expect(
			resolveBootMode(input({ snapshotRef: "snap-1", repoImageRef: "harbor-repo-x:sha", overrides })),
		).toEqual({ mode: "snapshot_restore", reason: "snapshot_available" });
	});

	it("falls back to the repo image when a restore is requested but not usable", () => {
		const overrides: RepoOverrides = { enableSnapshots: true };
		// Snapshots on but no ref: the repo image is the next-best warm start.
		expect(
			resolveBootMode(input({ snapshotRef: null, repoImageRef: "harbor-repo-x:sha", overrides })),
		).toEqual({ mode: "repo_image", reason: "repo_image_fresh" });
	});

	it("resolves only the modes the caller pre-gated — never build", () => {
		const overrides: RepoOverrides = { enableSnapshots: true };
		const modes = [
			resolveBootMode(input({ snapshotRef: "snap-1", overrides })).mode,
			resolveBootMode(input({ repoImageRef: "harbor-repo-x:sha" })).mode,
			resolveBootMode(input({ snapshotRef: "snap-1" })).mode,
		];
		for (const mode of modes) expect(["fresh", "snapshot_restore", "repo_image"]).toContain(mode);
	});
});

// ---------------------------------------------------------------------------
// Provider error classification
// ---------------------------------------------------------------------------

describe("classifyProviderError", () => {
	it("maps HTTP statuses", () => {
		expect(classifyProviderError({ status: 401 })).toBe("unauthorized");
		expect(classifyProviderError({ status: 403 })).toBe("unauthorized");
		expect(classifyProviderError({ status: 402 })).toBe("quota_exceeded");
		expect(classifyProviderError({ status: 404 })).toBe("not_found");
		expect(classifyProviderError({ status: 429 })).toBe("rate_limited");
		expect(classifyProviderError({ status: 408 })).toBe("transient");
		expect(classifyProviderError({ status: 422 })).toBe("invalid_config");
		expect(classifyProviderError({ status: 500 })).toBe("transient");
		expect(classifyProviderError({ status: 503 })).toBe("transient");
	});

	it("reads a status off the shapes SDKs actually throw", () => {
		expect(classifyProviderError({ statusCode: 429 })).toBe("rate_limited");
		expect(classifyProviderError({ response: { status: 503 } })).toBe("transient");
		expect(classifyProviderError(Object.assign(new Error("boom"), { status: 404 }))).toBe(
			"not_found",
		);
	});

	it("does not mistake a Node errno string for an HTTP status", () => {
		expect(classifyProviderError({ code: "ECONNREFUSED", message: "connect ECONNREFUSED" })).toBe(
			"transient",
		);
	});

	it("falls back to message shapes", () => {
		expect(classifyProviderError(new Error("Rate limit exceeded, slow down"))).toBe("rate_limited");
		expect(classifyProviderError(new Error("insufficient credit on this account"))).toBe(
			"quota_exceeded",
		);
		expect(classifyProviderError(new Error("no such image: harbor-sandbox:latest"))).toBe(
			"not_found",
		);
		expect(classifyProviderError(new Error("invalid region 'moon'"))).toBe("invalid_config");
		expect(classifyProviderError(new Error("service unavailable"))).toBe("transient");
		expect(classifyProviderError("socket hang up")).toBe("transient");
	});

	it("defaults to unknown — which counts towards the breaker", () => {
		// The uncomfortable default is the right one: an error shape nobody has ever
		// classified is the strongest evidence available that something is wrong, and
		// a non-tripping default would let a new provider error format silently
		// disable the breaker.
		expect(classifyProviderError(new Error("the flarn is bespoke"))).toBe("unknown");
		expect(classifyProviderError(null)).toBe("unknown");
		expect(classifyProviderError(undefined)).toBe("unknown");
		expect(classifyProviderError({})).toBe("unknown");
		expect(classifyCircuitContribution(classifyProviderError({}))).toBe("counts");
	});

	it("only ever returns a declared provider error type", () => {
		const samples: unknown[] = [
			{ status: 401 },
			{ status: 404 },
			{ status: 500 },
			new Error("quota"),
			"nonsense",
			42,
			null,
		];
		for (const sample of samples) {
			expect(PROVIDER_ERROR_TYPES).toContain(classifyProviderError(sample));
		}
	});
});

describe("evaluateDestruction — destruction fails closed", () => {
	it("covers the whole truth table, and the defer directions carry their reasons", () => {
		// The full matrix, spelled out rather than looped, because each row is a
		// distinct policy somebody will one day want to "fix": unknown defers
		// (unreadable authority is not proof of abandonment), held defers
		// (somebody authorised is mid-flight), not_held and no_task destroy.
		expect(evaluateDestruction("unknown")).toEqual({
			verdict: "defer",
			reason: "lease_unknown",
		});
		expect(evaluateDestruction("held")).toEqual({ verdict: "defer", reason: "lease_held" });
		expect(evaluateDestruction("not_held")).toEqual({ verdict: "destroy" });
		expect(evaluateDestruction("no_task")).toEqual({ verdict: "destroy" });
	});

	it("is total over every declared authority value", () => {
		const authorities: DestructionAuthority[] = ["no_task", "held", "not_held", "unknown"];
		for (const authority of authorities) {
			const decision = evaluateDestruction(authority);
			expect(["destroy", "defer"]).toContain(decision.verdict);
		}
	});
});

describe("isReconnectBlockedStatus is total over the status set", () => {
	it("blocks exactly stopped and stale, admits every other declared status", () => {
		const blocked = SANDBOX_STATUSES.filter((status) => isReconnectBlockedStatus(status));
		expect(blocked.sort()).toEqual(["stale", "stopped"]);
		// `failed` deliberately reconnects — the slow boot that outruns its
		// watchdog and then comes up working. See the function's doc comment.
		expect(isReconnectBlockedStatus("failed")).toBe(false);
	});

	it("fails OPEN on a status this build does not know", () => {
		// Transport question, not authority: the fence still gates every
		// privileged write, so admitting an unknown status costs nothing the
		// fence does not already protect against.
		expect(isReconnectBlockedStatus("hibernating")).toBe(false);
	});
});

describe("isOpenAttemptStatus is total over the status set", () => {
	it("treats exactly `requested` as an open attempt", () => {
		const open = SANDBOX_STATUSES.filter((status) => isOpenAttemptStatus(status));
		expect(open).toEqual(["requested"]);
	});

	it("an unknown status is NOT an open attempt — resuming it would attach a provider call", () => {
		expect(isOpenAttemptStatus("hibernating")).toBe(false);
	});
});
