// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The spawn saga, tested against the four ambiguous failures it exists to survive.
 *
 * These are the acceptance criteria for the whole execution plane, and they are
 * written against a FAKE provider rather than a mock. The distinction matters: the
 * fake records what it was actually asked to create and answers `findByAttemptId`
 * from that record, so "the provider created a box and its response was lost" is
 * reproduced as a real orphan the reconciliation path has to discover — not as a
 * stubbed return value that agrees with whatever the test expected.
 *
 * A mock would happily pass an implementation that never calls `findByAttemptId`
 * at all.
 */

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DEAD_SANDBOX_STATUSES } from "../contracts/index.js";
import { db, sql } from "@core/schema/index.js";
import { circuitBreakers, orgs, sandboxes, sessions, tasks } from "@core/schema/schema.js";
import { claim, createTask } from "@core/kernel/work.js";
import { createSession } from "../lib/sessions.js";
import {
	currentFencingToken,
	ensureSandbox,
	markSandboxReady,
	onInactivity,
	onStaleHeartbeat,
	stopSandbox,
	validateFence,
} from "./manager.js";
import { SandboxProviderError } from "./provider.js";
import type {
	CreateSandboxConfig,
	CreatedSandbox,
	SandboxInspection,
	SandboxProvider,
} from "./provider.js";

let orgId: string;
let sessionId: string;

/**
 * A provider that remembers everything it was asked to do.
 *
 * `mode` drives the failure being reproduced. `created` is the ledger the fake
 * answers `findByAttemptId` from — which is exactly the role a real provider's own
 * records play during reconciliation.
 */
/** A probe result in the shape the real providers return. */
function inspection(externalId: string, attemptId: string): SandboxInspection {
	return {
		externalId,
		provider: "fake",
		state: "running",
		rawState: "running",
		attemptId,
		sessionId: null,
		sandboxId: null,
		startedAt: new Date().toISOString(),
		exitCode: null,
	};
}

function fakeProvider(mode: "ok" | "lose_response" | "transient" | "invalid_config" = "ok") {
	const created: Array<{ attemptId: string; externalId: string }> = [];
	let createCalls = 0;
	let findCalls = 0;

	const provider: SandboxProvider = {
		kind: "ephemeral",
		name: "fake",
		capabilities: {
			supportsSandboxTimeout: true,
			supportsSnapshots: false,
			supportsRestore: false,
		},
		async create(config: CreateSandboxConfig): Promise<CreatedSandbox> {
			createCalls += 1;
			const externalId = `ext-${created.length + 1}`;

			if (mode === "transient") {
				throw new SandboxProviderError({
					message: "provider is having a moment",
					errorType: "transient",
					provider: "fake",
					operation: "create",
				});
			}
			if (mode === "invalid_config") {
				throw new SandboxProviderError({
					message: "no such image",
					errorType: "invalid_config",
					provider: "fake",
					operation: "create",
				});
			}
			if (mode === "lose_response") {
				// The box IS created — this is the whole point. The provider did the
				// work and the answer never arrived, which from our side is
				// indistinguishable from the box never existing.
				created.push({ attemptId: config.attemptId, externalId });
				throw new SandboxProviderError({
					message: "socket hang up",
					errorType: "transient",
					provider: "fake",
					operation: "create",
				});
			}

			created.push({ attemptId: config.attemptId, externalId });
			return {
				externalId,
				provider: "fake",
				attemptId: config.attemptId,
				state: "running",
				createdAt: new Date().toISOString(),
			};
		},
		async findByAttemptId(attemptId: string): Promise<SandboxInspection | null> {
			findCalls += 1;
			const hit = created.find((row) => row.attemptId === attemptId);
			return hit ? inspection(hit.externalId, hit.attemptId) : null;
		},
		async inspect(externalId: string): Promise<SandboxInspection | null> {
			const hit = created.find((row) => row.externalId === externalId);
			return hit ? inspection(hit.externalId, hit.attemptId) : null;
		},
		async stop() {
			// Idempotent, as the provider contract requires: stopping a box that is
			// already gone is a no-op, not an error.
			return "stopped" as const;
		},
		supportedFeatures: [],
	} as unknown as SandboxProvider;

	return {
		provider,
		created,
		get createCalls() {
			return createCalls;
		},
		get findCalls() {
			return findCalls;
		},
	};
}

beforeEach(async () => {
	await sql`truncate table cost_events, circuit_breakers, automation_runs, automations, artifacts, session_events, sandboxes, session_repos, secrets, user_scm_tokens, environment_repos, environments, repos, activity, session_prompts, session_participants, sessions, runs, agent_presence, events, claims, tasks, projects, api_keys, digests, connectors, users, orgs cascade`;
	const [org] = await db.insert(orgs).values({ name: "Manager Org" }).returning();
	orgId = org!.id;
	const session = await createSession({ orgId, title: "Fix the thing", createdBy: "rin" });
	sessionId = session.id;

	// Required, with no default, because a box that boots pointing at
	// `http://localhost:3000` from inside its own container reaches itself — every
	// event is dropped and the watchdog reaps a healthy sandbox. See
	// `controlPlaneUrl` in manager.ts.
	process.env.HARBOR_PUBLIC_URL = "http://host.docker.internal:3000";
});

afterAll(async () => {
	await sql.end();
});

/**
 * Boxes that are not dead.
 *
 * The property is "at most one ACTIVE sandbox", so dead rows do not count — a test
 * that counted every row would fail on a perfectly correct system that had reaped
 * one box and started another. It also cannot filter on `ready` specifically: a
 * freshly created box is `spawning` until its bridge reports in, and that
 * transition belongs to the bridge rather than to `ensureSandbox`.
 *
 * The filter is the deny-list from the contract, used the same way the production
 * code uses it, so a status added later is treated as live here too rather than
 * making this test quietly stop counting things.
 */
const live = async () => {
	const rows = await db.select().from(sandboxes).where(eq(sandboxes.sessionId, sessionId));
	return rows.filter((row) => !DEAD_SANDBOX_STATUSES.includes(row.status as never));
};

describe("at most one active sandbox per lease", () => {
	/**
	 * The ordinary case, and the one claim-before-spawn already handles: two
	 * concurrent callers, one container.
	 */
	it("two concurrent ensureSandbox calls produce ONE provider create", async () => {
		const fake = fakeProvider();

		const [a, b] = await Promise.all([
			ensureSandbox({ orgId, sessionId, provider: fake.provider }),
			ensureSandbox({ orgId, sessionId, provider: fake.provider }),
		]);

		expect(fake.createCalls).toBeLessThanOrEqual(1);
		expect(await live()).toHaveLength(1);

		// One of them created it; the other adopted or was refused as already-active.
		// Which is which is a race and asserting on it would make this test flaky —
		// what matters is that between them exactly one box exists.
		const kinds = [a.kind, b.kind].sort();
		expect(kinds).not.toEqual(["created", "created"]);
	});

	/**
	 * The failure claim-before-spawn does NOT survive, and the reason "exactly one
	 * provider create call" is the wrong acceptance criterion.
	 *
	 * The provider created the box and the response was lost. From our side that is
	 * indistinguishable from the box never existing. A retry that simply creates
	 * again leaves two boxes, one of which nothing in the system knows about — an
	 * orphan burning money with a token that still works.
	 */
	it("adopts an orphan created by a lost response instead of creating a second", async () => {
		const fake = fakeProvider("lose_response");

		const first = await ensureSandbox({ orgId, sessionId, provider: fake.provider });
		expect(first.kind).not.toBe("created");
		// The provider really did make one.
		expect(fake.created).toHaveLength(1);

		// The retry must ask before it acts.
		const second = await ensureSandbox({ orgId, sessionId, provider: fake.provider });
		expect(fake.findCalls).toBeGreaterThan(0);
		expect(fake.created).toHaveLength(1);
		expect(second.kind === "adopted" || second.kind === "created").toBe(true);
	});

	it("is idempotent once a box is live", async () => {
		const fake = fakeProvider();
		await ensureSandbox({ orgId, sessionId, provider: fake.provider });
		await ensureSandbox({ orgId, sessionId, provider: fake.provider });
		await ensureSandbox({ orgId, sessionId, provider: fake.provider });
		expect(fake.createCalls).toBe(1);
		expect(await live()).toHaveLength(1);
	});
});

describe("fencing", () => {
	/**
	 * The fourth ambiguous failure: the lease expired while the holder is still
	 * running. The box is alive, its token is genuine, and it still believes it
	 * holds the work. Fencing is what makes that harmless instead of two agents
	 * pushing to one branch.
	 */
	it("refuses a stale token after a newer sandbox supersedes it", async () => {
		const fake = fakeProvider();
		const first = await ensureSandbox({ orgId, sessionId, provider: fake.provider });
		if (first.kind !== "created") throw new Error("expected a created sandbox");

		const firstToken = await currentFencingToken(sessionId);
		expect(await validateFence(first.sandbox_id, firstToken)).toMatchObject({ valid: true });

		// The box is reaped and a new one takes over.
		await stopSandbox(first.sandbox_id, "stopped_by_operator", { provider: fake.provider });
		const second = await ensureSandbox({ orgId, sessionId, provider: fake.provider });
		if (second.kind !== "created") throw new Error("expected a second created sandbox");

		const secondToken = await currentFencingToken(sessionId);
		expect(secondToken).toBeGreaterThan(firstToken);

		// The old box is still running and still holds a genuine token. It must not
		// be able to act.
		const verdict = await validateFence(first.sandbox_id, firstToken);
		expect(verdict.valid).toBe(false);
	});

	it("refuses a token for a sandbox that does not exist", async () => {
		const verdict = await validateFence("00000000-0000-0000-0000-000000000000", 1);
		expect(verdict.valid).toBe(false);
	});
});

describe("the circuit breaker", () => {
	/**
	 * Shared, not per session. A per-session breaker means every session
	 * independently discovers a dead provider by burning its own spawns — fifty
	 * sessions produce a hundred and fifty doomed attempts aimed at the dependency
	 * least able to absorb them.
	 */
	it("opens after the threshold and is shared across sessions", async () => {
		const fake = fakeProvider("transient");

		for (let attempt = 0; attempt < 4; attempt += 1) {
			await ensureSandbox({ orgId, sessionId, provider: fake.provider });
		}

		const [breaker] = await db
			.select()
			.from(circuitBreakers)
			.where(eq(circuitBreakers.orgId, orgId));
		expect(breaker).toBeDefined();
		expect(breaker!.consecutiveFailures).toBeGreaterThanOrEqual(3);

		// A DIFFERENT session must be refused instantly rather than paying the same
		// discovery cost. This is the assertion that makes the breaker shared.
		const other = await createSession({ orgId, title: "Another room", createdBy: "maya" });
		const callsBefore = fake.createCalls;
		const outcome = await ensureSandbox({
			orgId,
			sessionId: other.id,
			provider: fake.provider,
		});
		expect(outcome.kind).toBe("refused");
		if (outcome.kind === "refused") expect(outcome.reason).toBe("circuit_open");
		expect(fake.createCalls).toBe(callsBefore);
	});

	/**
	 * A permanent misconfiguration must NOT trip the breaker. Retrying "no such
	 * image" across a hundred sessions helps nobody, and opening the circuit hides
	 * an unrelated real outage behind a configuration error.
	 */
	it("does not open on a permanent configuration error", async () => {
		const fake = fakeProvider("invalid_config");

		for (let attempt = 0; attempt < 5; attempt += 1) {
			await ensureSandbox({ orgId, sessionId, provider: fake.provider });
		}

		const [breaker] = await db
			.select()
			.from(circuitBreakers)
			.where(eq(circuitBreakers.orgId, orgId));
		const open = breaker?.openedAt ?? null;
		expect(open).toBeNull();
	});
});

describe("claim before spawn", () => {
	/**
	 * The admission mechanism, and the thing nothing else in this space has. A
	 * duplicate unit of work must never cost a container.
	 */
	it("refuses when the lease is held by somebody else", async () => {
		const task = await createTask(orgId, { title: "Cap the retry loop" });
		const held = await claim(orgId, task.id, "someone-else", {
			intent: "Already capping the retry loop on this task.",
		});
		expect(held.ok).toBe(true);

		const [taskRow] = await db.select().from(tasks).where(eq(tasks.id, task.id));
		expect(taskRow!.status).toBe("claimed");

		// A claim id that is not the active holder's is not authority.
		const fake = fakeProvider();
		const outcome = await ensureSandbox({
			orgId,
			sessionId,
			claimId: "00000000-0000-0000-0000-000000000000",
			provider: fake.provider,
		});

		expect(outcome.kind).toBe("refused");
		expect(fake.createCalls).toBe(0);
	});
});

describe("deadline handlers are idempotent", () => {
	/**
	 * A sweep can run twice — two replicas, a retried tick, a restart mid-sweep. A
	 * handler that is not idempotent double-charges, double-stops, or writes two
	 * timeline events for one thing.
	 */
	it("running each handler twice changes nothing the second time", async () => {
		const fake = fakeProvider();
		const spawned = await ensureSandbox({ orgId, sessionId, provider: fake.provider });
		if (spawned.kind !== "created") throw new Error("expected a created sandbox");

		// The bridge reporting in is what moves a box from `spawning` to `ready`, and
		// it has to happen here: a box that never became ready is the CONNECTING
		// timeout's business, not inactivity's. Skipping this step tests the wrong
		// handler and passes for the wrong reason.
		await markSandboxReady(spawned.sandbox_id, { bootMode: "fresh" });

		// Push the sandbox far enough into the past that both deadlines apply.
		await db
			.update(sandboxes)
			.set({
				lastHeartbeatAt: new Date(Date.now() - 86_400_000),
				readyAt: new Date(Date.now() - 86_400_000),
			})
			.where(eq(sandboxes.sessionId, sessionId));
		await db
			.update(sessions)
			.set({ lastActivityAt: new Date(Date.now() - 86_400_000) })
			.where(eq(sessions.id, sessionId));

		const now = new Date();
		const firstInactivity = await onInactivity(now);
		const secondInactivity = await onInactivity(now);
		expect(secondInactivity.acted.length).toBeLessThanOrEqual(firstInactivity.acted.length);

		const firstStale = await onStaleHeartbeat(now);
		const secondStale = await onStaleHeartbeat(now);
		expect(secondStale.acted.length).toBeLessThanOrEqual(firstStale.acted.length);

		// Whatever happened, the box is not left in a live state.
		expect(await live()).toHaveLength(0);
	});
});

describe("enrolment — the step without which nothing works", () => {
	/**
	 * Found by an adversarial review, and it is the difference between "the code
	 * exists" and "the slice runs": nothing wrote `sandboxes.auth_token_hash` or
	 * injected the four variables the supervisor requires. Every other part of the
	 * saga was correct and no sandbox could have booted or authenticated.
	 *
	 * The supervisor exits 78 for want of `HARBOR_SANDBOX_TOKEN`, and a box that
	 * started anyway would be told `sandbox_unenrolled` because the row carried a
	 * null digest.
	 */
	it("mints a token, stores only its digest, and passes the plaintext to the box", async () => {
		process.env.HARBOR_PUBLIC_URL = "http://host.docker.internal:3000";
		const fake = fakeProvider();
		let seen: Record<string, string> = {};
		const capturing = {
			...fake.provider,
			async create(config: CreateSandboxConfig) {
				seen = config.env;
				return fake.provider.create(config);
			},
		} as unknown as SandboxProvider;

		const outcome = await ensureSandbox({ orgId, sessionId, provider: capturing });
		if (outcome.kind !== "created") throw new Error("expected a created sandbox");

		expect(seen.HARBOR_CONTROL_URL).toBe("http://host.docker.internal:3000");
		expect(seen.HARBOR_SANDBOX_ID).toBe(outcome.sandbox_id);
		expect(seen.HARBOR_SESSION_ID).toBe(sessionId);
		expect(seen.HARBOR_SANDBOX_TOKEN).toMatch(/^[A-Za-z0-9_-]{40,}$/);
		expect(Number(seen.HARBOR_FENCING_TOKEN)).toBeGreaterThan(0);

		const [row] = await db.select().from(sandboxes).where(eq(sandboxes.id, outcome.sandbox_id));
		// The digest, and never the plaintext. This credential lets a box write into
		// a transcript and fetch git credentials, so a database dump containing it
		// would hand over both.
		expect(row!.authTokenHash).toHaveLength(64);
		expect(row!.authTokenHash).not.toBe(seen.HARBOR_SANDBOX_TOKEN);
		expect(row!.authTokenHash).toBe(
			createHash("sha256").update(seen.HARBOR_SANDBOX_TOKEN!).digest("hex"),
		);
	});

	/**
	 * The correlation contract's missing hop. docs/sandbox-runtime.md always
	 * listed HARBOR_TRACE_ID in the environment and the supervisor always read
	 * it — but nothing ever set it, so the "single greppable token" the
	 * contracts file promises for a Slack→session→sandbox→PR chain was lost at
	 * exactly the container boundary.
	 */
	it("exports the turn's trace id into the box, and omits the key when there is none", async () => {
		process.env.HARBOR_PUBLIC_URL = "http://host.docker.internal:3000";
		const fake = fakeProvider();
		let seen: Record<string, string> = {};
		const capturing = {
			...fake.provider,
			async create(config: CreateSandboxConfig) {
				seen = config.env;
				return fake.provider.create(config);
			},
		} as unknown as SandboxProvider;

		const outcome = await ensureSandbox({
			orgId,
			sessionId,
			provider: capturing,
			traceId: "trace-e2e-1",
		});
		if (outcome.kind !== "created") throw new Error("expected a created sandbox");
		expect(seen.HARBOR_TRACE_ID).toBe("trace-e2e-1");

		// And a repo secret cannot shadow it: the Harbor-controlled spread wins.
		await stopSandbox(outcome.sandbox_id, "stopped_by_operator", { provider: capturing });
		const second = await ensureSandbox({
			orgId,
			sessionId,
			provider: capturing,
			traceId: "trace-e2e-2",
			env: { HARBOR_TRACE_ID: "attacker-supplied" },
		});
		if (second.kind !== "created") throw new Error("expected a created sandbox");
		expect(seen.HARBOR_TRACE_ID).toBe("trace-e2e-2");
	});

	/**
	 * A repository secret named HARBOR_CONTROL_URL would otherwise point a sandbox
	 * at an attacker's control plane, which it would then hand its token to.
	 */
	it("cannot have its control-plane address shadowed by a caller-supplied secret", async () => {
		process.env.HARBOR_PUBLIC_URL = "http://host.docker.internal:3000";
		const fake = fakeProvider();
		let seen: Record<string, string> = {};
		const capturing = {
			...fake.provider,
			async create(config: CreateSandboxConfig) {
				seen = config.env;
				return fake.provider.create(config);
			},
		} as unknown as SandboxProvider;

		await ensureSandbox({
			orgId,
			sessionId,
			provider: capturing,
			env: { HARBOR_CONTROL_URL: "http://evil.test", DATABASE_URL: "postgres://app" },
		});

		expect(seen.HARBOR_CONTROL_URL).toBe("http://host.docker.internal:3000");
		// Ordinary secrets still get through.
		expect(seen.DATABASE_URL).toBe("postgres://app");
	});

	/**
	 * `http://localhost:3000` from inside a container resolves to the container
	 * itself, so every event is dropped and the watchdog reaps a healthy box. The
	 * symptom is "sandboxes always time out", a very long way from "a variable is
	 * unset" — so the absence is fatal at spawn, with an error that says which.
	 */
	it("refuses to spawn with no callback address rather than defaulting to localhost", async () => {
		const saved = process.env.HARBOR_PUBLIC_URL;
		delete process.env.HARBOR_PUBLIC_URL;
		try {
			const fake = fakeProvider();
			const outcome = await ensureSandbox({ orgId, sessionId, provider: fake.provider });
			expect(outcome.kind).not.toBe("created");
			expect(fake.createCalls).toBe(0);
		} finally {
			if (saved !== undefined) process.env.HARBOR_PUBLIC_URL = saved;
		}
	});
});
