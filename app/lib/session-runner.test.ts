// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The runner's tests, against real Postgres.
 *
 * Every property asserted here is a concurrency property or a boundary, and both
 * kinds are exactly what a mocked database cannot tell you about. A fake that
 * "implements" `pg_try_advisory_lock` grants it to both callers or to neither
 * depending on how the fake was written, which means the test proves a fact about
 * the fake. The lock, `FOR UPDATE SKIP LOCKED`, and the ordering argument in the
 * stream route are all properties of Postgres, so Postgres is what they run
 * against.
 *
 * The one thing that IS injected is the sandbox gateway, and that is the point of
 * it existing: the loop's admission behaviour can be exercised without booting a
 * container, which is the difference between these tests running on every commit
 * and running never.
 */

import { and, asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpawnOutcome } from "../contracts/index.js";
import { db, sql } from "@core/schema/index.js";
import {
	apiKeys,
	claims,
	orgs,
	sandboxes,
	sessionEvents,
	sessionPrompts,
	sessions,
	tasks,
} from "@core/schema/schema.js";
import { GET as getSandboxCommands } from "../api/sandbox/[id]/commands/route.js";
import { POST as postSandboxEvents } from "../api/sandbox/[id]/events/route.js";
import { GET as getSessionStream } from "../api/sessions/[key]/stream/route.js";
import { hashApiKey, mintApiKey } from "@core/kernel/keys.js";
import { promptability, promptabilityOf } from "./promptability.js";
import { appendEvent } from "./session-events.js";
import {
	enqueueSessionPrompt,
	peekNextPrompt,
	priorityOfAuthorKind,
	promptPriority,
	runSessionTurn,
	sha256Hex,
	type SandboxGateway,
} from "./session-runner.js";
import { createSession } from "./sessions.js";

let orgId: string;
let sessionId: string;
let sessionKey: string;
let apiKey: string;

const TRUNCATE = `truncate table
	session_events, cost_events, artifacts, session_repos, sandboxes,
	session_prompts, session_participants, sessions,
	activity, runs, agent_presence, events, claims, tasks, projects,
	circuit_breakers, automation_runs, automations, secrets, user_scm_tokens,
	environment_repos, environments, repos, api_keys, digests, connectors, users, orgs
	cascade`;

beforeEach(async () => {
	await sql.unsafe(TRUNCATE);
	const [org] = await db.insert(orgs).values({ name: "Runner Org" }).returning();
	orgId = org!.id;

	const session = await createSession({
		orgId,
		title: "Fix the flaky webhook retry",
		createdBy: "@rin",
	});
	sessionId = session.id;
	sessionKey = session.key;

	apiKey = mintApiKey();
	await db.insert(apiKeys).values({ orgId, keyHash: hashApiKey(apiKey), label: "runner tests" });
});

afterEach(() => {
	delete process.env.HARBOR_MAX_QUEUE_DEPTH;
	delete process.env.HARBOR_MAX_SNAPSHOT_EVENTS;
	delete process.env.HARBOR_MAX_EVENT_PAYLOAD_CHARS;
});

afterAll(async () => {
	await sql.end();
});

/**
 * A gateway that produces a real sandbox row and takes a moment doing it.
 *
 * The delay is what makes the contention tests contend. Without it two "concurrent"
 * runners can serialise by accident — the first finishes its whole turn before the
 * second reaches the lock — and the test would pass whether or not the lock works.
 */
function fakeGateway(options: { delayMs?: number; outcome?: SpawnOutcome } = {}): SandboxGateway {
	return {
		async ensureSandbox(input) {
			if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
			if (options.outcome) return options.outcome;
			const [box] = await db
				.insert(sandboxes)
				.values({
					orgId: input.orgId,
					sessionId: input.sessionId,
					provider: "test",
					status: "ready",
					externalId: `ext-${Math.random().toString(16).slice(2)}`,
				})
				.returning();
			return { kind: "created", sandbox_id: box!.id, external_id: box!.externalId! };
		},
	};
}

async function eventsOfType(type: string) {
	return db
		.select()
		.from(sessionEvents)
		.where(and(eq(sessionEvents.sessionId, sessionId), eq(sessionEvents.type, type)))
		.orderBy(asc(sessionEvents.seq));
}

// ---------------------------------------------------------------------------
// One writer
// ---------------------------------------------------------------------------

describe("exactly one runner drives a session", () => {
	it("delivers a prompt once even with four runners racing for it", async () => {
		await enqueueSessionPrompt({
			orgId,
			sessionId,
			author: "@rin",
			body: "Have another look at the retry backoff.",
		});

		const gateway = fakeGateway({ delayMs: 60 });
		const outcomes = await Promise.all(
			[1, 2, 3, 4].map((n) =>
				runSessionTurn({ orgId, sessionId, agentId: `worker-${n}`, gateway }),
			),
		);

		const delivered = outcomes.filter((outcome) => outcome.kind === "delivered");
		expect(delivered).toHaveLength(1);

		// The losers are idle, never refused. A runner that could not take the lock
		// has not been denied anything — somebody else is doing the work — and
		// reporting it as a refusal would make an ordinary quiet path look like an
		// incident in every dashboard that counts refusals.
		for (const outcome of outcomes) {
			if (outcome.kind === "delivered") continue;
			expect(outcome.kind).toBe("idle");
		}

		expect(await eventsOfType("prompt_delivered")).toHaveLength(1);
		const rows = await db.select().from(sessionPrompts).where(eq(sessionPrompts.sessionId, sessionId));
		expect(rows.map((row) => row.status)).toEqual(["delivered"]);
	});

	it("delivers each of three prompts exactly once across six racing runners", async () => {
		for (const body of ["first", "second", "third"]) {
			await enqueueSessionPrompt({ orgId, sessionId, author: "@rin", body });
		}

		const gateway = fakeGateway({ delayMs: 25 });
		// Six turns, three prompts. More runners than work is the ordinary state of a
		// fleet, and it is the state in which a double delivery would happen.
		const outcomes = await Promise.all(
			[1, 2, 3, 4, 5, 6].map((n) =>
				runSessionTurn({ orgId, sessionId, agentId: `worker-${n}`, gateway }),
			),
		);

		const delivered = outcomes.flatMap((outcome) =>
			outcome.kind === "delivered" ? [outcome.promptId] : [],
		);
		expect(new Set(delivered).size).toBe(delivered.length);

		const events = await eventsOfType("prompt_delivered");
		const promptIds = events.map((event) => (event.payload as { prompt_id: string }).prompt_id);
		expect(new Set(promptIds).size).toBe(promptIds.length);
	});
});

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

describe("two priority classes", () => {
	it("delivers a human's prompt before an automation's that was queued first", async () => {
		const automation = await enqueueSessionPrompt({
			orgId,
			sessionId,
			author: "nightly-upgrade",
			authorKind: "agent",
			body: "Upgrade every dependency and run the full suite.",
		});
		const human = await enqueueSessionPrompt({
			orgId,
			sessionId,
			author: "@rin",
			authorKind: "human",
			body: "wait — not the database driver",
		});
		expect(automation.ok && human.ok).toBe(true);
		if (!automation.ok || !human.ok) throw new Error("setup failed");

		// Arrival order is unambiguous: the automation's seq is lower.
		expect(human.seq).toBeGreaterThan(automation.seq);

		const peeked = await peekNextPrompt(orgId, sessionId);
		expect(peeked?.id).toBe(human.promptId);

		const turn = await runSessionTurn({
			orgId,
			sessionId,
			agentId: "worker-1",
			gateway: fakeGateway(),
		});
		expect(turn.kind).toBe("delivered");
		if (turn.kind !== "delivered") throw new Error("expected a delivery");
		expect(turn.promptId).toBe(human.promptId);

		// And the automation is not dropped — it is next, still at its own seq.
		const next = await peekNextPrompt(orgId, sessionId);
		expect(next?.id).toBe(automation.promptId);
		expect(next?.seq).toBe(automation.seq);
	});

	it("orders within a class by seq, so a room still reads in the order it happened", async () => {
		const first = await enqueueSessionPrompt({ orgId, sessionId, author: "@rin", body: "one" });
		await enqueueSessionPrompt({ orgId, sessionId, author: "@sam", body: "two" });
		const peeked = await peekNextPrompt(orgId, sessionId);
		expect(first.ok && peeked?.id).toBe(first.ok ? first.promptId : null);
	});

	it("puts an unrecognised author kind in the agent class rather than ahead of a person", () => {
		expect(promptPriority("human")).toBeLessThan(promptPriority("agent"));
		expect(priorityOfAuthorKind("reviewer")).toBe(promptPriority("agent"));
		expect(priorityOfAuthorKind("HUMAN")).toBe(promptPriority("human"));
	});
});

// ---------------------------------------------------------------------------
// Queue depth
// ---------------------------------------------------------------------------

describe("queue depth cap", () => {
	it("refuses past the cap with a typed reason and leaves the queue at the cap", async () => {
		process.env.HARBOR_MAX_QUEUE_DEPTH = "3";

		for (let n = 0; n < 3; n += 1) {
			const outcome = await enqueueSessionPrompt({
				orgId,
				sessionId,
				author: "nightly-upgrade",
				authorKind: "agent",
				body: `attempt ${n}`,
			});
			expect(outcome.ok).toBe(true);
		}

		const refused = await enqueueSessionPrompt({
			orgId,
			sessionId,
			author: "nightly-upgrade",
			authorKind: "agent",
			body: "attempt 4",
		});
		expect(refused.ok).toBe(false);
		if (refused.ok) throw new Error("expected a refusal");
		expect(refused.reason).toBe("queue_full");
		expect(refused.depth).toBe(3);
		expect(refused.cap).toBe(3);

		const rows = await db.select().from(sessionPrompts).where(eq(sessionPrompts.sessionId, sessionId));
		expect(rows).toHaveLength(3);
	});

	it("admits exactly at the boundary and refuses exactly one past it", async () => {
		process.env.HARBOR_MAX_QUEUE_DEPTH = "1";
		const first = await enqueueSessionPrompt({ orgId, sessionId, author: "@rin", body: "a" });
		expect(first.ok).toBe(true);
		const second = await enqueueSessionPrompt({ orgId, sessionId, author: "@rin", body: "b" });
		expect(second.ok).toBe(false);
	});

	it("frees a slot once a prompt is delivered, since the cap counts what is waiting", async () => {
		process.env.HARBOR_MAX_QUEUE_DEPTH = "1";
		await enqueueSessionPrompt({ orgId, sessionId, author: "@rin", body: "a" });
		await runSessionTurn({ orgId, sessionId, agentId: "worker-1", gateway: fakeGateway() });
		const second = await enqueueSessionPrompt({ orgId, sessionId, author: "@rin", body: "b" });
		expect(second.ok).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Promptability
// ---------------------------------------------------------------------------

describe("promptability", () => {
	it("is total over the vocabulary, at every member", () => {
		expect(promptability("created").promptable).toBe(true);
		expect(promptability("active").promptable).toBe(true);
		// The two that look wrong and are not: failure is where somebody most wants
		// to say "try again, differently", and the transcript they need is here.
		expect(promptability("completed").promptable).toBe(true);
		expect(promptability("failed").promptable).toBe(true);
		expect(promptability("archived").promptable).toBe(false);
		expect(promptability("cancelled").promptable).toBe(false);
	});

	it("names the refusal rather than returning a bare false", () => {
		const archived = promptability("archived");
		expect(archived.promptable).toBe(false);
		if (archived.promptable) throw new Error("unreachable");
		expect(archived.reason).toBe("session_archived");

		const cancelled = promptability("cancelled");
		if (cancelled.promptable) throw new Error("unreachable");
		expect(cancelled.reason).toBe("session_cancelled");
	});

	it("keeps 'could not determine' distinct from 'denied', and fails closed", () => {
		const unknown = promptabilityOf("quiescent");
		expect(unknown.promptable).toBe(false);
		if (unknown.promptable) throw new Error("unreachable");
		expect(unknown.reason).toBe("status_unrecognised");
		expect(unknown.status).toBeNull();
	});

	it("understands the status createSession actually writes", async () => {
		const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
		// If this ever fails, every pre-existing session in every deployment has just
		// stopped accepting prompts — which is why the alias exists at all.
		expect(promptabilityOf(row!.status).promptable).toBe(true);
	});

	it("refuses to enqueue into an archived session, and to run a turn on one", async () => {
		await db.update(sessions).set({ status: "archived" }).where(eq(sessions.id, sessionId));

		const enqueued = await enqueueSessionPrompt({ orgId, sessionId, author: "@rin", body: "hi" });
		expect(enqueued.ok).toBe(false);
		if (enqueued.ok) throw new Error("expected a refusal");
		expect(enqueued.reason).toBe("session_not_promptable");

		const turn = await runSessionTurn({
			orgId,
			sessionId,
			agentId: "worker-1",
			gateway: fakeGateway(),
		});
		expect(turn.kind).toBe("refused");
		if (turn.kind !== "refused") throw new Error("expected a refusal");
		expect(turn.reason).toBe("session_not_promptable");
	});

	it("accepts a prompt into a completed session and into a failed one", async () => {
		for (const status of ["completed", "failed"]) {
			await db.update(sessions).set({ status }).where(eq(sessions.id, sessionId));
			const outcome = await enqueueSessionPrompt({
				orgId,
				sessionId,
				author: "@rin",
				body: `try again, differently (${status})`,
			});
			expect(outcome.ok).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// Refusals do not eat the prompt
// ---------------------------------------------------------------------------

describe("a refused spawn", () => {
	it("puts the prompt back at its own seq and records the denial", async () => {
		const queued = await enqueueSessionPrompt({ orgId, sessionId, author: "@rin", body: "go" });
		if (!queued.ok) throw new Error("setup failed");

		const turn = await runSessionTurn({
			orgId,
			sessionId,
			agentId: "worker-1",
			gateway: fakeGateway({ outcome: { kind: "refused", reason: "circuit_open" } }),
		});
		expect(turn.kind).toBe("refused");
		if (turn.kind !== "refused") throw new Error("expected a refusal");
		expect(turn.reason).toBe("sandbox_refused");
		expect(turn.spawnRefusal).toBe("circuit_open");

		const back = await peekNextPrompt(orgId, sessionId);
		expect(back?.id).toBe(queued.promptId);
		expect(back?.seq).toBe(queued.seq);

		const denials = await eventsOfType("policy_denied");
		expect(denials).toHaveLength(1);
		expect((denials[0]!.payload as { reason: string }).reason).toBe("circuit_open");
	});
});

// ---------------------------------------------------------------------------
// Claim before spawn, and the lease handoff
// ---------------------------------------------------------------------------

describe("claim before spawn", () => {
	it("never reaches the provider when the lease is held by somebody else", async () => {
		const [task] = await db
			.insert(tasks)
			.values({ orgId, title: "Fix the retry backoff" })
			.returning();
		await db.update(sessions).set({ taskId: task!.id }).where(eq(sessions.id, sessionId));
		await db.insert(claims).values({
			orgId,
			scope: `harbor:${task!.id}`,
			taskId: task!.id,
			agentId: "somebody-else",
			intent: "Already working the retry backoff on this task.",
			expiresAt: new Date(Date.now() + 600_000),
		});

		await enqueueSessionPrompt({ orgId, sessionId, author: "@rin", body: "go" });

		let reached = false;
		const gateway: SandboxGateway = {
			async ensureSandbox() {
				reached = true;
				throw new Error("the provider must not be reached");
			},
		};

		const turn = await runSessionTurn({ orgId, sessionId, agentId: "worker-1", gateway });
		expect(turn.kind).toBe("refused");
		if (turn.kind !== "refused") throw new Error("expected a refusal");
		expect(turn.reason).toBe("lease_not_held");
		// The whole point: a duplicate unit of work costs one failed INSERT, never a
		// container and never a token.
		expect(reached).toBe(false);
		expect(await db.select().from(sandboxes).where(eq(sandboxes.sessionId, sessionId))).toHaveLength(0);
		// And the prompt is untouched, still queued for whoever holds the lease.
		expect((await peekNextPrompt(orgId, sessionId))?.body).toBe("go");
	});

	it("reuses the session and names the previous holder when a lease lapsed", async () => {
		const [task] = await db.insert(tasks).values({ orgId, title: "Long job" }).returning();
		await db.update(sessions).set({ taskId: task!.id }).where(eq(sessions.id, sessionId));
		// A lease that has already lapsed. The holder may well still be running —
		// that is the case the fence exists for — but the task is claimable again.
		await db.insert(claims).values({
			orgId,
			scope: `harbor:${task!.id}`,
			taskId: task!.id,
			agentId: "runner/worker-old",
			intent: "Long job that outran its lease but may still be running.",
			expiresAt: new Date(Date.now() - 60_000),
		});

		await enqueueSessionPrompt({ orgId, sessionId, author: "@rin", body: "carry on" });

		const turn = await runSessionTurn({
			orgId,
			sessionId,
			agentId: "worker-new",
			gateway: fakeGateway(),
		});
		expect(turn.kind).toBe("delivered");

		const handoffs = await eventsOfType("participant_joined");
		expect(handoffs).toHaveLength(1);
		const payload = handoffs[0]!.payload as { kind: string; previous_holder: string };
		expect(payload.kind).toBe("lease_handoff");
		expect(payload.previous_holder).toBe("runner/worker-old");

		// The session itself is the same room: same id, same key, same transcript.
		const [after] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
		expect(after!.key).toBe(sessionKey);
	});
});

// ---------------------------------------------------------------------------
// The bridge's uplink
// ---------------------------------------------------------------------------

async function makeSandbox(token: string, status = "ready") {
	const [box] = await db
		.insert(sandboxes)
		.values({
			orgId,
			sessionId,
			provider: "test",
			status,
			externalId: `ext-${Math.random().toString(16).slice(2)}`,
			authTokenHash: sha256Hex(token),
		})
		.returning();
	return box!;
}

function eventRequest(
	sandboxId: string,
	init: { token?: string; fence?: string; body?: string } = {},
) {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (init.token) headers.authorization = `Bearer ${init.token}`;
	if (init.fence) headers["x-harbor-fencing-token"] = init.fence;
	return new Request(`http://harbor.test/api/sandbox/${sandboxId}/events`, {
		method: "POST",
		headers,
		body: init.body ?? JSON.stringify({ events: [] }),
	});
}

describe("POST /api/sandbox/[id]/events", () => {
	it("accepts a correctly authenticated, correctly fenced batch", async () => {
		const box = await makeSandbox("tok-good");
		const response = await postSandboxEvents(
			eventRequest(box.id, {
				token: "tok-good",
				fence: "1",
				body: JSON.stringify({
					events: [
						{ type: "boot_ready", sandbox_id: box.id, session_id: sessionId },
						{
							type: "agent_message",
							sandbox_id: box.id,
							session_id: sessionId,
							payload: { text: "Reading the retry policy." },
						},
						// Not for the timeline, counted rather than silently vanished.
						{ type: "heartbeat", sandbox_id: box.id, session_id: sessionId },
					],
				}),
			}),
			{ params: Promise.resolve({ id: box.id }) },
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { appended: number; ignored: number };
		expect(body.appended).toBe(2);
		expect(body.ignored).toBe(1);
		expect(await eventsOfType("agent_message")).toHaveLength(1);
	});

	it("refuses a wrong token with 401", async () => {
		const box = await makeSandbox("tok-good");
		const response = await postSandboxEvents(
			eventRequest(box.id, { token: "tok-wrong", fence: "1" }),
			{ params: Promise.resolve({ id: box.id }) },
		);
		expect(response.status).toBe(401);
		expect(((await response.json()) as { reason: string }).reason).toBe("token_mismatch");
	});

	it("refuses a missing token with 401, and says it is missing rather than wrong", async () => {
		const box = await makeSandbox("tok-good");
		const response = await postSandboxEvents(eventRequest(box.id, { fence: "1" }), {
			params: Promise.resolve({ id: box.id }),
		});
		expect(response.status).toBe(401);
		expect(((await response.json()) as { reason: string }).reason).toBe("token_absent");
	});

	it("refuses a stale fence even though the token is genuine", async () => {
		const first = await makeSandbox("tok-first");
		// A second boot for the same session. The first box may still be running and
		// may still believe it owns the work; its credential is real. Only the fence
		// stops it writing into a transcript another agent now owns.
		await makeSandbox("tok-second");

		const response = await postSandboxEvents(
			eventRequest(first.id, {
				token: "tok-first",
				fence: "1",
				body: JSON.stringify({
					events: [{ type: "agent_message", sandbox_id: first.id, session_id: sessionId }],
				}),
			}),
			{ params: Promise.resolve({ id: first.id }) },
		);
		expect(response.status).toBe(409);
		expect(((await response.json()) as { reason: string }).reason).toBe("superseded");
		expect(await eventsOfType("agent_message")).toHaveLength(0);
	});

	it("refuses a missing fence rather than defaulting to 'fine'", async () => {
		const box = await makeSandbox("tok-good");
		const response = await postSandboxEvents(eventRequest(box.id, { token: "tok-good" }), {
			params: Promise.resolve({ id: box.id }),
		});
		expect(response.status).toBe(409);
		expect(((await response.json()) as { reason: string }).reason).toBe("fence_absent");
	});

	it("refuses an oversized body with 413", async () => {
		// The ceiling is derived from two settings, so the test moves the settings
		// rather than shipping a four-megabyte fixture.
		process.env.HARBOR_MAX_SNAPSHOT_EVENTS = "10";
		process.env.HARBOR_MAX_EVENT_PAYLOAD_CHARS = "100";

		const box = await makeSandbox("tok-good");
		const oversized = JSON.stringify({
			events: [
				{
					type: "agent_message",
					sandbox_id: box.id,
					session_id: sessionId,
					payload: { text: "x".repeat(4000) },
				},
			],
		});
		expect(oversized.length).toBeGreaterThan(10 * 100);

		const response = await postSandboxEvents(
			eventRequest(box.id, { token: "tok-good", fence: "1", body: oversized }),
			{ params: Promise.resolve({ id: box.id }) },
		);
		expect(response.status).toBe(413);
		expect(await eventsOfType("agent_message")).toHaveLength(0);
	});

	it("refuses an event that names another session", async () => {
		const box = await makeSandbox("tok-good");
		const other = await createSession({ orgId, title: "Somebody else's room", createdBy: "@sam" });
		const response = await postSandboxEvents(
			eventRequest(box.id, {
				token: "tok-good",
				fence: "1",
				body: JSON.stringify({
					events: [{ type: "agent_message", sandbox_id: box.id, session_id: other.id }],
				}),
			}),
			{ params: Promise.resolve({ id: box.id }) },
		);
		expect(response.status).toBe(403);
		expect(((await response.json()) as { reason: string }).reason).toBe("session_mismatch");
	});

	it("closes the in-flight prompt when the agent reports it finished", async () => {
		const queued = await enqueueSessionPrompt({ orgId, sessionId, author: "@rin", body: "go" });
		if (!queued.ok) throw new Error("setup failed");
		const turn = await runSessionTurn({
			orgId,
			sessionId,
			agentId: "worker-1",
			gateway: fakeGateway(),
		});
		if (turn.kind !== "delivered") throw new Error("expected a delivery");

		const [box] = await db
			.select()
			.from(sandboxes)
			.where(eq(sandboxes.id, turn.sandboxId))
			.limit(1);
		await db
			.update(sandboxes)
			.set({ authTokenHash: sha256Hex("tok-live") })
			.where(eq(sandboxes.id, box!.id));

		const response = await postSandboxEvents(
			eventRequest(box!.id, {
				token: "tok-live",
				fence: "1",
				body: JSON.stringify({
					events: [{ type: "agent_finished", sandbox_id: box!.id, session_id: sessionId }],
				}),
			}),
			{ params: Promise.resolve({ id: box!.id }) },
		);
		expect(response.status).toBe(200);

		const [prompt] = await db
			.select()
			.from(sessionPrompts)
			.where(eq(sessionPrompts.id, queued.promptId))
			.limit(1);
		expect(prompt!.status).toBe("completed");

		const finished = await eventsOfType("prompt_finished");
		expect(finished).toHaveLength(1);
		// The finish marker sits ABOVE the agent's last sentence, so a client that
		// stops rendering at the marker has already rendered the answer.
		const agentEvents = await eventsOfType("agent_finished");
		expect(finished[0]!.seq).toBeGreaterThan(agentEvents[0]!.seq);
	});
});

// ---------------------------------------------------------------------------
// The bridge's downlink
// ---------------------------------------------------------------------------

describe("GET /api/sandbox/[id]/commands", () => {
	it("delivers the in-flight prompt, with its author, to a correctly fenced box", async () => {
		const queued = await enqueueSessionPrompt({
			orgId,
			sessionId,
			author: "@rin",
			body: "Have another look at the retry backoff.",
		});
		if (!queued.ok) throw new Error("setup failed");

		const turn = await runSessionTurn({
			orgId,
			sessionId,
			agentId: "worker-1",
			gateway: fakeGateway(),
		});
		if (turn.kind !== "delivered") throw new Error("expected a delivery");
		await db
			.update(sandboxes)
			.set({ authTokenHash: sha256Hex("tok-live") })
			.where(eq(sandboxes.id, turn.sandboxId));

		const abort = new AbortController();
		const response = await getSandboxCommands(
			new Request(`http://harbor.test/api/sandbox/${turn.sandboxId}/commands`, {
				headers: { authorization: "Bearer tok-live", "x-harbor-fencing-token": "1" },
				signal: abort.signal,
			}),
			{ params: Promise.resolve({ id: turn.sandboxId }) },
		);
		expect(response.status).toBe(200);

		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		const frames: Frame[] = [];
		try {
			const deadline = Date.now() + 5_000;
			while (Date.now() < deadline && !frames.some((frame) => frame.event === "command")) {
				const chunk = await Promise.race([
					reader.read(),
					new Promise<{ done: true; value: undefined }>((resolve) =>
						setTimeout(() => resolve({ done: true, value: undefined }), 500),
					),
				]);
				if (!chunk.value) continue;
				buffer += decoder.decode(chunk.value, { stream: true });
				const parsed = parseFrames(buffer);
				buffer = parsed.rest;
				frames.push(...parsed.frames);
			}
		} finally {
			abort.abort();
			await reader.cancel().catch(() => {});
		}

		const command = frames.find((frame) => frame.event === "command")?.data as {
			type: string;
			prompt?: { id: string; author: string };
		};
		expect(command?.type).toBe("prompt");
		expect(command?.prompt?.id).toBe(queued.promptId);
		// The author travels all the way down so the commit is attributed to the
		// person who asked rather than to a bot.
		expect(command?.prompt?.author).toBe("@rin");
	});

	it("refuses a superseded box rather than handing it work", async () => {
		const first = await makeSandbox("tok-first");
		await makeSandbox("tok-second");

		const response = await getSandboxCommands(
			new Request(`http://harbor.test/api/sandbox/${first.id}/commands`, {
				headers: { authorization: "Bearer tok-first", "x-harbor-fencing-token": "1" },
			}),
			{ params: Promise.resolve({ id: first.id }) },
		);
		expect(response.status).toBe(409);
		expect(((await response.json()) as { reason: string }).reason).toBe("superseded");
	});
});

// ---------------------------------------------------------------------------
// The client stream
// ---------------------------------------------------------------------------

interface Frame {
	event: string;
	data: unknown;
}

/** Parse whatever complete SSE frames are in `buffer`, returning the tail. */
function parseFrames(buffer: string): { frames: Frame[]; rest: string } {
	const parts = buffer.split("\n\n");
	const rest = parts.pop() ?? "";
	const frames: Frame[] = [];
	for (const part of parts) {
		let event = "message";
		const data: string[] = [];
		for (const line of part.split("\n")) {
			if (line.startsWith("event: ")) event = line.slice(7);
			else if (line.startsWith("data: ")) data.push(line.slice(6));
			// A `:` comment line is the keep-alive and is ignored, exactly as
			// EventSource ignores it.
		}
		if (data.length > 0) frames.push({ event, data: JSON.parse(data.join("\n")) });
	}
	return { frames, rest };
}

describe("GET /api/sessions/[key]/stream", () => {
	it("converges on the server's state with no gaps and no duplicate application", async () => {
		// History that exists before anybody connects.
		for (let n = 0; n < 12; n += 1) {
			await appendEvent({
				orgId,
				sessionId,
				type: "agent_message",
				actor: "agent",
				payload: { text: `before ${n}` },
			});
		}

		// A writer that keeps going across the connect. This is the condition the
		// ordering argument exists for: events that commit while the snapshot is
		// being assembled, and events that commit after it.
		let writing = true;
		let written = 12;
		// The writer's failure is captured rather than left to float. An assertion
		// that fails before the `await` below would otherwise turn a real error into
		// an unhandled rejection attributed to whichever test happened to be running
		// next, which is how a one-line bug costs somebody an afternoon.
		let writerError: unknown = null;
		const writer = (async () => {
			while (writing && written < 60) {
				await appendEvent({
					orgId,
					sessionId,
					type: "agent_message",
					actor: "agent",
					payload: { text: `during ${written}` },
				});
				written += 1;
			}
		})().catch((error: unknown) => {
			writerError = error;
		});

		const abort = new AbortController();
		const response = await getSessionStream(
			new Request(`http://harbor.test/api/sessions/${sessionKey}/stream`, {
				headers: { authorization: `Bearer ${apiKey}` },
				signal: abort.signal,
			}),
			{ params: Promise.resolve({ key: sessionKey }) },
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("x-accel-buffering")).toBe("no");

		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		/**
		 * A client that follows the contract: a snapshot REPLACES state, and a live
		 * event is applied idempotently by seq. `duplicates` counts the events the
		 * contract says are free — re-applying one must be a no-op — so the test can
		 * assert the difference between "sent twice" (fine) and "applied twice" (not).
		 */
		const applied = new Map<number, string>();
		let duplicates = 0;
		let snapshots = 0;

		const apply = (frame: Frame) => {
			if (frame.event === "snapshot") {
				snapshots += 1;
				const snapshot = frame.data as {
					events: Array<{ seq: number; id: string }>;
				};
				applied.clear();
				for (const event of snapshot.events) applied.set(event.seq, event.id);
				return;
			}
			if (frame.event !== "event") return;
			const event = frame.data as { seq: number; id: string };
			if (applied.has(event.seq)) {
				duplicates += 1;
				return;
			}
			applied.set(event.seq, event.id);
		};

		try {
			const deadline = Date.now() + 15_000;
			while (Date.now() < deadline) {
				const chunk = await Promise.race([
					reader.read(),
					new Promise<{ done: true; value: undefined }>((resolve) =>
						setTimeout(() => resolve({ done: true, value: undefined }), 1_000),
					),
				]);
				if (chunk.value) {
					buffer += decoder.decode(chunk.value, { stream: true });
					const parsed = parseFrames(buffer);
					buffer = parsed.rest;
					for (const frame of parsed.frames) apply(frame);
				}
				if (!writing && applied.size >= written) break;
				if (written >= 60) writing = false;
			}
		} finally {
			// In a `finally` so a failed assertion cannot leave a LISTEN connection
			// open for the rest of the run. Each stream holds a dedicated Postgres
			// connection, and leaking one per failure exhausts the server long before
			// anybody works out why an unrelated suite started timing out.
			writing = false;
			await writer;
			abort.abort();
			await reader.cancel().catch(() => {});
		}
		if (writerError) throw writerError;

		expect(snapshots).toBe(1);

		const [row] = await db
			.select({ next: sessions.nextEventSeq })
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1);
		const highest = row!.next - 1;

		// No gaps: the client holds every seq from 1 to the server's highest.
		const seqs = [...applied.keys()].sort((a, b) => a - b);
		expect(seqs[0]).toBe(1);
		expect(seqs[seqs.length - 1]).toBe(highest);
		expect(seqs).toHaveLength(highest);
		for (let index = 1; index < seqs.length; index += 1) {
			expect(seqs[index]).toBe(seqs[index - 1]! + 1);
		}

		// No duplicate application: every seq is in the map exactly once, and any
		// event the server repeated was recognised and dropped by number rather than
		// applied a second time.
		expect(new Set(applied.values()).size).toBe(applied.size);
		expect(duplicates).toBeGreaterThanOrEqual(0);
	});

	it("refuses an unknown key without revealing whether it exists in another org", async () => {
		const abort = new AbortController();
		const response = await getSessionStream(
			new Request("http://harbor.test/api/sessions/zzzzzzzzzzzzzzzzzzzzzz/stream", {
				headers: { authorization: `Bearer ${apiKey}` },
				signal: abort.signal,
			}),
			{ params: Promise.resolve({ key: "zzzzzzzzzzzzzzzzzzzzzz" }) },
		);
		const reader = response.body!.getReader();
		const chunk = await reader.read();
		const text = new TextDecoder().decode(chunk.value);
		expect(text).toContain("No such session.");
		abort.abort();
		await reader.cancel().catch(() => {});
	});

	it("refuses a revoked key rather than falling back to the browser session", async () => {
		await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.orgId, orgId));
		const response = await getSessionStream(
			new Request(`http://harbor.test/api/sessions/${sessionKey}/stream`, {
				headers: { authorization: `Bearer ${apiKey}` },
			}),
			{ params: Promise.resolve({ key: sessionKey }) },
		);
		expect(response.status).toBe(401);
	});
});
