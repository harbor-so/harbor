// SPDX-License-Identifier: Apache-2.0
/**
 * The configuration must be coherent out of the box.
 *
 * The first test here is the most important regression test in the repository.
 * Before it existed, `validateConfig()` threw on its own shipped defaults —
 * `sandboxBootTimeoutMs` was smaller than the two hook budgets it must contain,
 * and `sandboxInactivityTimeoutMs` was smaller than the turn timeout it must
 * exceed. The consequences were total: the sandbox supervisor exited 78 before
 * doing anything, the MCP server exited 1, and `/api/health` answered 503 —
 * a fresh install of the product could not run at all, and the test suite was
 * green the whole time because nothing ever called `validateConfig()` with the
 * real environment.
 *
 * So this suite validates the *shipped* configuration, not a fixture: it
 * scrubs every HARBOR_* variable and asserts the defaults stand on their own.
 * Every coherence rule then gets one focused violation case, because a
 * validator whose error paths are untested is a validator whose messages rot.
 */

import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, SETTINGS, describeConfig, setting, validateConfig } from "./config.js";

/**
 * Run a function with every HARBOR_* variable removed, restoring the previous
 * environment afterwards even on throw. `setting()` reads process.env at call
 * time (deliberately — see its doc comment), so this is a complete reset.
 */
function withScrubbedEnv<T>(extra: Record<string, string>, fn: () => T): T {
	const saved = new Map<string, string | undefined>();
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("HARBOR_")) {
			saved.set(key, process.env[key]);
			delete process.env[key];
		}
	}
	for (const [key, value] of Object.entries(extra)) {
		if (!saved.has(key)) saved.set(key, process.env[key]);
		process.env[key] = value;
	}
	try {
		return fn();
	} finally {
		for (const [key, value] of saved.entries()) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

afterEach(() => {
	// withScrubbedEnv restores eagerly; nothing to do. Present so a future test
	// that mutates env directly has a place to hang its cleanup.
});

describe("validateConfig on the shipped defaults", () => {
	it("passes with no HARBOR_* environment at all — a fresh install must boot", () => {
		withScrubbedEnv({}, () => {
			expect(() => validateConfig()).not.toThrow();
		});
	});

	it("passes with the exact values .env.example ships", () => {
		// .env.example is what a self-hoster copies verbatim. If this test fails,
		// the quickstart is broken even though the defaults are fine.
		withScrubbedEnv(
			{
				HARBOR_MAX_SPEND_PER_DAY_MICRO_USD: "50000000",
				HARBOR_SANDBOX_BOOT_TIMEOUT_MS: "480000",
				HARBOR_SETUP_TIMEOUT_MS: "300000",
				HARBOR_START_TIMEOUT_MS: "120000",
				HARBOR_SANDBOX_INACTIVITY_TIMEOUT_MS: "2100000",
			},
			() => {
				expect(() => validateConfig()).not.toThrow();
			},
		);
	});

	it("boot timeout default actually covers the hook budgets it is derived from", () => {
		withScrubbedEnv({}, () => {
			expect(setting("sandboxBootTimeoutMs")).toBeGreaterThanOrEqual(
				setting("setupTimeoutMs") + setting("startTimeoutMs"),
			);
		});
	});

	it("inactivity default actually exceeds the turn timeout it is derived from", () => {
		withScrubbedEnv({}, () => {
			expect(setting("sandboxInactivityTimeoutMs")).toBeGreaterThan(
				setting("agentTurnTimeoutMs"),
			);
		});
	});

	it("turn timeout default fits inside the default lease", () => {
		withScrubbedEnv({}, () => {
			expect(setting("agentTurnTimeoutMs")).toBeLessThanOrEqual(
				setting("leaseMinutes") * 60_000,
			);
		});
	});

	it("image freshness cutoff default is at least the build interval it is derived from", () => {
		withScrubbedEnv({}, () => {
			expect(setting("imageMaxAgeMs")).toBeGreaterThanOrEqual(setting("imageBuildIntervalMs"));
		});
	});

	it("image build timeout default covers a plain boot", () => {
		withScrubbedEnv({}, () => {
			expect(setting("imageBuildTimeoutMs")).toBeGreaterThanOrEqual(
				setting("sandboxBootTimeoutMs"),
			);
		});
	});
});

describe("each coherence rule fires on its own violation, by name", () => {
	const expectProblem = (env: Record<string, string>, ...fragments: string[]) => {
		withScrubbedEnv(env, () => {
			let message = "";
			try {
				validateConfig();
			} catch (error) {
				expect(error).toBeInstanceOf(ConfigError);
				message = (error as Error).message;
			}
			expect(message).not.toBe("");
			for (const fragment of fragments) {
				expect(message).toContain(fragment);
			}
		});
	};

	it("stale heartbeat below the interval", () => {
		expectProblem(
			{ HARBOR_SANDBOX_STALE_HEARTBEAT_MS: "10000", HARBOR_SANDBOX_HEARTBEAT_INTERVAL_MS: "15000" },
			"HARBOR_SANDBOX_STALE_HEARTBEAT_MS",
			"HARBOR_SANDBOX_HEARTBEAT_INTERVAL_MS",
			"healthy sandbox",
		);
	});

	it("stale heartbeat below twice the interval", () => {
		expectProblem(
			{ HARBOR_SANDBOX_STALE_HEARTBEAT_MS: "20000", HARBOR_SANDBOX_HEARTBEAT_INTERVAL_MS: "15000" },
			"less than twice",
		);
	});

	it("boot timeout below setup + start", () => {
		expectProblem(
			{ HARBOR_SANDBOX_BOOT_TIMEOUT_MS: "180000" },
			"HARBOR_SANDBOX_BOOT_TIMEOUT_MS",
			"HARBOR_SETUP_TIMEOUT_MS",
			"HARBOR_START_TIMEOUT_MS",
		);
	});

	it("inactivity at or below the turn timeout", () => {
		expectProblem(
			{ HARBOR_SANDBOX_INACTIVITY_TIMEOUT_MS: "900000" },
			"HARBOR_SANDBOX_INACTIVITY_TIMEOUT_MS",
			"HARBOR_AGENT_TURN_TIMEOUT_MS",
			"reaped as idle",
		);
	});

	it("turn timeout longer than the lease — the two-agents-on-one-task condition", () => {
		expectProblem(
			{ HARBOR_AGENT_TURN_TIMEOUT_MS: "3600000" },
			"HARBOR_AGENT_TURN_TIMEOUT_MS",
			"HARBOR_LEASE_MINUTES",
			"two agents",
		);
	});

	it("lease below one minute", () => {
		expectProblem(
			{ HARBOR_LEASE_MINUTES: "0", HARBOR_AGENT_TURN_TIMEOUT_MS: "1" },
			"HARBOR_LEASE_MINUTES",
			"at least 1",
		);
	});

	it("max lease below the default lease", () => {
		expectProblem(
			{ HARBOR_MAX_LEASE_MINUTES: "10" },
			"HARBOR_MAX_LEASE_MINUTES",
			"HARBOR_LEASE_MINUTES",
		);
	});

	it("deadline sweep interval at or above the inactivity timeout", () => {
		expectProblem(
			{ HARBOR_DEADLINE_SWEEP_INTERVAL_MS: "2100000" },
			"HARBOR_DEADLINE_SWEEP_INTERVAL_MS",
			"HARBOR_SANDBOX_INACTIVITY_TIMEOUT_MS",
		);
	});

	it("retention below the snapshot cap", () => {
		expectProblem(
			{ HARBOR_EVENT_RETENTION_COUNT: "100", HARBOR_MAX_SNAPSHOT_EVENTS: "500" },
			"HARBOR_EVENT_RETENTION_COUNT",
			"HARBOR_MAX_SNAPSHOT_EVENTS",
		);
	});

	it("image freshness cutoff below the build interval — the silently-disabled feature", () => {
		expectProblem(
			{ HARBOR_IMAGE_MAX_AGE_MS: "60000", HARBOR_IMAGE_BUILD_INTERVAL_MS: "1800000" },
			"HARBOR_IMAGE_MAX_AGE_MS",
			"HARBOR_IMAGE_BUILD_INTERVAL_MS",
			"the moment it is published",
		);
	});

	it("image build timeout below a plain boot", () => {
		expectProblem(
			{ HARBOR_IMAGE_BUILD_TIMEOUT_MS: "10000" },
			"HARBOR_IMAGE_BUILD_TIMEOUT_MS",
			"HARBOR_SANDBOX_BOOT_TIMEOUT_MS",
		);
	});

	it("image retention below one", () => {
		expectProblem(
			{ HARBOR_IMAGE_RETENTION_COUNT: "0" },
			"HARBOR_IMAGE_RETENTION_COUNT",
			"at least 1",
		);
	});

	it("aggregates several problems into one error rather than reporting the first", () => {
		withScrubbedEnv(
			{
				HARBOR_SANDBOX_BOOT_TIMEOUT_MS: "180000",
				HARBOR_SANDBOX_INACTIVITY_TIMEOUT_MS: "900000",
			},
			() => {
				try {
					validateConfig();
					expect.unreachable("validateConfig should have thrown");
				} catch (error) {
					const message = (error as Error).message;
					expect(message).toContain("HARBOR_SANDBOX_BOOT_TIMEOUT_MS");
					expect(message).toContain("HARBOR_SANDBOX_INACTIVITY_TIMEOUT_MS");
				}
			},
		);
	});
});

describe("setting() resolution", () => {
	it("environment beats the default", () => {
		withScrubbedEnv({ HARBOR_LEASE_MINUTES: "5" }, () => {
			expect(setting("leaseMinutes")).toBe(5);
		});
	});

	it("repository override beats the environment", () => {
		withScrubbedEnv({ HARBOR_LEASE_MINUTES: "5" }, () => {
			expect(setting("leaseMinutes", { leaseMinutes: 7 })).toBe(7);
		});
	});

	it("a non-integer value is refused by name, not coerced", () => {
		withScrubbedEnv({ HARBOR_LEASE_MINUTES: "soon" }, () => {
			expect(() => setting("leaseMinutes")).toThrow(/HARBOR_LEASE_MINUTES/);
		});
	});

	it("an empty environment value falls through to the default", () => {
		withScrubbedEnv({ HARBOR_LEASE_MINUTES: "" }, () => {
			expect(setting("leaseMinutes")).toBe(SETTINGS.leaseMinutes.fallback);
		});
	});

	it("image building is off by default and enabled per repo through repos.config", () => {
		withScrubbedEnv({}, () => {
			// Off for the fleet unless an operator opts in.
			expect(setting("imageBuildEnabled")).toBe(false);
			// A single repo turns it on via its config jsonb, without an env change.
			expect(setting("imageBuildEnabled", { imageBuildEnabled: true })).toBe(true);
		});
	});

	it("the empty imageBaseImage default means 'use sandboxImage', resolved by the caller", () => {
		withScrubbedEnv({}, () => {
			// The empty string is the sentinel the builder reads as "fall back to sandboxImage".
			expect(setting("imageBaseImage")).toBe("");
			expect(setting("imageBaseImage", { imageBaseImage: "acme/base:1" })).toBe("acme/base:1");
		});
	});
});

describe("describeConfig", () => {
	it("covers every registered setting with value, source and derivation", () => {
		withScrubbedEnv({ HARBOR_LEASE_MINUTES: "45" }, () => {
			const described = describeConfig();
			const keys = described.map((entry) => entry.key);
			expect(new Set(keys)).toEqual(new Set(Object.keys(SETTINGS)));
			for (const entry of described) {
				expect(entry.env).toMatch(/^HARBOR_/);
				expect(entry.derivation.length).toBeGreaterThan(20);
				expect(["default", "environment", "repository"]).toContain(entry.source);
			}
			const lease = described.find((entry) => entry.key === "leaseMinutes");
			expect(lease?.value).toBe(45);
			expect(lease?.source).toBe("environment");
		});
	});

	it("every derivation explains itself rather than restating the number", () => {
		// A derivation that is just the value ("30000") is the failure mode the
		// config header warns about. Twenty characters of prose is a cheap floor.
		for (const spec of Object.values(SETTINGS)) {
			expect(spec.derivation.trim().length).toBeGreaterThan(20);
			expect(spec.derivation).not.toMatch(/^\d+$/);
		}
	});
});
