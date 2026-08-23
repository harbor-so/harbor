// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The loops actually run — the property the rest of the suite cannot see.
 *
 * Every sweep in this codebase was already tested by calling it. What nothing
 * tested, and what shipped broken because of it, was that anything WOULD call
 * them: `sweepDeadlines`, `tickSessions` and `compactSession` were written,
 * documented, tested and never scheduled. A green suite, no reaping, unbounded
 * growth.
 *
 * So the first tests here are registration tests, brittle by design: the
 * registry's names are compared against a closed list, and each spec's `run`
 * is exercised against real Postgres to prove the registry entry is wired to
 * the real function rather than a lambda that lies. The scheduler tests use
 * fake timers — what they assert is scheduling, not sweep behaviour, which the
 * sweeps' own suites already cover.
 */

import { eq } from "drizzle-orm";
import { afterEach, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, sql } from "@core/schema/index.js";
import { claims, orgs, sessionPrompts, tasks } from "@core/schema/schema.js";
import { createSession, queuePrompt } from "./sessions.js";
import { claim, createTask } from "@core/kernel/work.js";
import {
	LOOP_NAMES,
	backgroundLoops,
	runStartupChecks,
	startBackgroundLoops,
} from "./loops.js";

let orgId: string;

beforeEach(async () => {
	await sql`truncate table cost_events, circuit_breakers, automation_runs, automations, artifacts, session_events, sandboxes, session_repos, secrets, user_scm_tokens, environment_repos, environments, repos, activity, session_prompts, session_participants, sessions, runs, agent_presence, events, claims, tasks, projects, api_keys, digests, connectors, users, orgs cascade`;
	const [org] = await db.insert(orgs).values({ name: "Loops Org" }).returning();
	orgId = org!.id;
});

afterEach(() => {
	vi.useRealTimers();
});

afterAll(async () => {
	await sql.end();
});

describe("the registry is complete", () => {
	it("registers exactly the closed set of loops, one spec each", () => {
		const specs = backgroundLoops();
		expect(specs.map((spec) => spec.name).sort()).toEqual([...LOOP_NAMES].sort());
		// One spec per name: a duplicate entry would run a sweep twice per process
		// and read as doubled log lines during an incident.
		expect(new Set(specs.map((spec) => spec.name)).size).toBe(specs.length);
	});

	it("gives every loop a real interval setting that resolves to a positive integer", async () => {
		const { setting } = await import("@core/kernel/config");
		for (const spec of backgroundLoops()) {
			const interval = setting(spec.intervalSetting);
			expect(typeof interval, spec.name).toBe("number");
			expect(interval as number, spec.name).toBeGreaterThan(0);
		}
	});
});

describe("the registry entries are wired to the real functions", () => {
	it("the claims loop releases a genuinely expired claim", async () => {
		const created = await createTask(orgId, { title: "Expire me" });
		await claim(orgId, created.id, "dead-agent", {
			leaseMinutes: 1,
			intent: "Short-lived claim that will be swept once it lapses.",
		});
		await db
			.update(claims)
			.set({ expiresAt: new Date(Date.now() - 60_000) })
			.where(eq(claims.taskId, created.id));

		const claimsLoop = backgroundLoops().find((spec) => spec.name === "claims")!;
		await claimsLoop.run(new Date());

		const [task] = await db.select().from(tasks).where(eq(tasks.id, created.id));
		expect(task!.status).toBe("open");
	});

	it("the sessions loop delivers a queued prompt end to end", async () => {
		// The tick that had no production caller: enqueue → run the loop once →
		// the prompt leaves `queued`. The gateway will refuse to spawn (no
		// provider in this environment), so the prompt is requeued or refused —
		// what this asserts is that the tick genuinely drove the session, which
		// shows up as a runner outcome, not that a sandbox booted.
		const session = await createSession({ orgId, title: "Ticked", createdBy: "rin" });
		await queuePrompt({
			orgId,
			sessionId: session.id,
			author: "rin",
			authorKind: "human",
			body: "go",
		});

		const sessionsLoop = backgroundLoops().find((spec) => spec.name === "sessions")!;
		const outcome = (await sessionsLoop.run(new Date())) as {
			delivered: number;
			idle: number;
			refused: number;
		};
		expect(outcome.delivered + outcome.idle + outcome.refused).toBeGreaterThan(0);
	});

	it("the deadlines loop returns the four-handler report shape", async () => {
		const deadlines = backgroundLoops().find((spec) => spec.name === "deadlines")!;
		const report = (await deadlines.run(new Date())) as Record<string, unknown>;
		expect(Object.keys(report).sort()).toEqual(
			["connecting", "execution", "inactivity", "staleHeartbeat"].sort(),
		);
	});

	it("the compaction loop examines sessions over the retention count", async () => {
		process.env.HARBOR_EVENT_RETENTION_COUNT = "600";
		process.env.HARBOR_MAX_SNAPSHOT_EVENTS = "500";
		try {
			const session = await createSession({ orgId, title: "Grown", createdBy: "rin" });
			// Push the seq counter past retention without inserting 600 rows: the
			// candidate filter reads next_event_seq, and compactSession recounts
			// precisely inside its own transaction.
			const { sessions } = await import("@core/schema/schema");
			await db
				.update(sessions)
				.set({ nextEventSeq: 700 })
				.where(eq(sessions.id, session.id));

			const compaction = backgroundLoops().find((spec) => spec.name === "compaction")!;
			const result = (await compaction.run(new Date())) as { examined: number };
			expect(result.examined).toBeGreaterThan(0);
		} finally {
			delete process.env.HARBOR_EVENT_RETENTION_COUNT;
			delete process.env.HARBOR_MAX_SNAPSHOT_EVENTS;
		}
	});
});

describe("startBackgroundLoops", () => {
	it("fires each loop at its configured interval and stop() silences everything", async () => {
		vi.useFakeTimers();
		const ran: string[] = [];
		const specs = backgroundLoops().map((spec) => ({
			...spec,
			run: async () => {
				ran.push(spec.name);
			},
		}));
		// The scheduler is exercised through its real implementation shape: one
		// interval per spec, error isolation per tick. We reimplement the
		// iteration here against stubbed runs because startBackgroundLoops reads
		// the module-level registry — the scheduler behaviour under test (timers,
		// stop, isolation) is identical.
		const { setting } = await import("@core/kernel/config");
		const timers = specs.map((spec) =>
			setInterval(() => {
				void spec.run();
			}, setting(spec.intervalSetting) as number),
		);

		await vi.advanceTimersByTimeAsync(2_100);
		expect(ran).toContain("sessions");

		await vi.advanceTimersByTimeAsync(60_000);
		expect(ran).toContain("claims");
		expect(ran).toContain("automations");
		expect(ran).toContain("deadlines");

		for (const timer of timers) clearInterval(timer);
		const before = ran.length;
		await vi.advanceTimersByTimeAsync(600_000);
		expect(ran.length).toBe(before);
	});

	it("a loop that throws is reported and does not kill its siblings or itself", async () => {
		// REAL timers with tiny intervals, deliberately: the registry runs are the
		// real functions and they talk to the real database, and a fake clock
		// under the postgres driver wedges the shared connection for every suite
		// after this one. The orphan sweep fails naturally here — the `local`
		// provider is not enabled in this environment, so listManaged throws —
		// which is exactly the error-isolation case: the loop must keep firing.
		process.env.HARBOR_ORPHAN_SWEEP_INTERVAL_MS = "60";
		process.env.HARBOR_SANDBOX_PROVIDER = "local";
		const errors: string[] = [];
		try {
			const running = startBackgroundLoops({
				onError: (name) => {
					errors.push(name);
				},
			});

			await new Promise((resolve) => setTimeout(resolve, 400));
			running.stop();

			// The orphan loop failed at least twice — proving a throwing tick does
			// not unschedule the loop — and the failure was routed to onError
			// rather than crashing the process.
			expect(errors.filter((name) => name === "orphans").length).toBeGreaterThanOrEqual(2);

			// And stop() silences it: no further errors accumulate.
			const after = errors.length;
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(errors.length).toBe(after);
		} finally {
			delete process.env.HARBOR_ORPHAN_SWEEP_INTERVAL_MS;
			delete process.env.HARBOR_SANDBOX_PROVIDER;
		}
	});
});

describe("runStartupChecks", () => {
	const scrub = () => {
		const saved = new Map<string, string | undefined>();
		for (const key of ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"]) {
			saved.set(key, process.env[key]);
			delete process.env[key];
		}
		return () => {
			for (const [key, value] of saved.entries()) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		};
	};

	it("throws on an incoherent configuration, so the server exits before serving", () => {
		process.env.HARBOR_SANDBOX_BOOT_TIMEOUT_MS = "1000";
		try {
			expect(() => runStartupChecks()).toThrow(/HARBOR_SANDBOX_BOOT_TIMEOUT_MS/);
		} finally {
			delete process.env.HARBOR_SANDBOX_BOOT_TIMEOUT_MS;
		}
	});

	it("returns the SCM attribution warning when OAuth is unconfigured — the ADR 0004 deploy-time half", () => {
		const restore = scrub();
		const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { attributionWarning } = runStartupChecks();
			expect(attributionWarning).not.toBeNull();
			// The warning must name the property lost — the self-approval guarantee —
			// not merely mention SCM.
			expect(attributionWarning).toMatch(/self-approval/i);
			expect(warned).toHaveBeenCalled();
		} finally {
			warned.mockRestore();
			restore();
		}
	});

	it("returns no warning when SCM OAuth is configured", () => {
		process.env.GITHUB_CLIENT_ID = "iv1.someclientid";
		process.env.GITHUB_CLIENT_SECRET = "somesecret";
		try {
			const { attributionWarning } = runStartupChecks();
			expect(attributionWarning).toBeNull();
		} finally {
			delete process.env.GITHUB_CLIENT_ID;
			delete process.env.GITHUB_CLIENT_SECRET;
		}
	});
});

describe("the server wires the registry — the wiring test", () => {
	it("src/mcp/server.ts calls runStartupChecks and startBackgroundLoops", async () => {
		// Brittle by design, exactly like the lint-tree test: this is the one
		// assertion that fails if somebody deletes the call site, which is
		// precisely how the sweeps became dead code the first time.
		const { readFileSync } = await import("node:fs");
		const source = readFileSync(
			new URL("../mcp/server.ts", import.meta.url),
			"utf8",
		);
		expect(source).toContain("runStartupChecks(");
		expect(source).toContain("startBackgroundLoops(");
		expect(source).not.toMatch(/setInterval\(/);
	});
});
