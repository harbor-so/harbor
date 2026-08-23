// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The queue-depth cap is enforced at every production door, not just defined.
 *
 * `enqueueSessionPrompt` — the capped, promptability-checked front door — had
 * ZERO production callers. All four enqueue paths (this HTTP route, Slack,
 * automations, the agent spawn tool) called the raw `queuePrompt` insert, so
 * the cap was implemented, documented, tested at the unit level and
 * unreachable. Its own doc comment named the failure it prevents ("a
 * misconfigured hourly automation with a retry loop enqueues without bound")
 * while the automation path bypassed it.
 *
 * These tests drive each production path to a refusal and assert the typed
 * outcome AND that no row landed. The unit-level cap behaviour (exact
 * boundary, concurrency overshoot) stays in session-runner.test.ts; this file
 * is about the doors.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, sql } from "@core/schema/index.js";
import {
	artifacts,
	automationRuns,
	automations,
	orgs,
	sessionPrompts,
	sessions,
} from "@core/schema/schema.js";
import { createSession, queuePrompt } from "../../lib/sessions.js";
import { handleSlackWebhook } from "../../connectors/slack.js";
import { runAutomation } from "../../triggers/automations.js";
import { agentTools, type AgentToolContext } from "../../mcp/agent-tools";

// The route reads the viewer from a cookie via next/headers, which only exists
// inside a Next request scope. The stub below is framework plumbing, not
// behaviour: with no cookie present and no OAuth configured, `currentSession`
// takes its documented dev-bypass path (first org), which is exactly the
// authenticated-viewer shape this suite needs.
vi.mock("next/headers", () => ({
	cookies: async () => ({
		get: () => undefined,
		set: () => {},
		delete: () => {},
	}),
}));

const { POST: postPrompt } = await import("./[key]/prompts/route.js");

let orgId: string;

async function fullSession(cap: number) {
	const session = await createSession({ orgId, title: "Full", createdBy: "rin" });
	for (let index = 0; index < cap; index += 1) {
		await queuePrompt({
			orgId,
			sessionId: session.id,
			author: "rin",
			authorKind: "human",
			body: `queued ${index}`,
		});
	}
	return session;
}

const promptCount = async (sessionId: string) =>
	(await db.select().from(sessionPrompts).where(eq(sessionPrompts.sessionId, sessionId))).length;

const promptRequest = (key: string, body: string) =>
	new Request(`http://harbor.test/api/sessions/${key}/prompts`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ body }),
	});

beforeEach(async () => {
	await sql`truncate table cost_events, circuit_breakers, automation_runs, automations, artifacts, session_events, sandboxes, session_repos, secrets, user_scm_tokens, environment_repos, environments, repos, activity, session_prompts, session_participants, sessions, runs, agent_presence, events, claims, tasks, projects, api_keys, digests, connectors, users, orgs cascade`;
	const [org] = await db.insert(orgs).values({ name: "Cap Org" }).returning();
	orgId = org!.id;
	delete process.env.GITHUB_CLIENT_ID;
	delete process.env.GITHUB_CLIENT_SECRET;
	process.env.HARBOR_MAX_QUEUE_DEPTH = "3";
});

afterAll(async () => {
	delete process.env.HARBOR_MAX_QUEUE_DEPTH;
	await sql.end();
});

describe("POST /api/sessions/[key]/prompts — the human door", () => {
	it("refuses a full queue with 429, naming the depth and the cap", async () => {
		const session = await fullSession(3);
		const response = await postPrompt(promptRequest(session.key, "one more"), {
			params: Promise.resolve({ key: session.key }),
		});

		expect(response.status).toBe(429);
		const body = (await response.json()) as {
			reason: string;
			depth: number;
			cap: number;
		};
		expect(body.reason).toBe("queue_full");
		expect(body.depth).toBe(3);
		expect(body.cap).toBe(3);
		expect(await promptCount(session.id)).toBe(3);
	});

	it("refuses an archived session with 400 rather than silently swallowing", async () => {
		const session = await createSession({ orgId, title: "Done", createdBy: "rin" });
		await db.update(sessions).set({ status: "archived" }).where(eq(sessions.id, session.id));

		const response = await postPrompt(promptRequest(session.key, "hello?"), {
			params: Promise.resolve({ key: session.key }),
		});
		expect(response.status).toBe(400);
		expect(((await response.json()) as { reason: string }).reason).toBe(
			"session_not_promptable",
		);
		expect(await promptCount(session.id)).toBe(0);
	});

	it("refuses an empty body with the prompt's own reason, not the session's", async () => {
		const session = await createSession({ orgId, title: "Empty", createdBy: "rin" });
		const response = await postPrompt(promptRequest(session.key, "   "), {
			params: Promise.resolve({ key: session.key }),
		});
		expect(response.status).toBe(400);
		expect(((await response.json()) as { reason: string }).reason).toBe("prompt_rejected");
	});

	it("still enqueues below the cap, attributed to the viewer as a human", async () => {
		const session = await createSession({ orgId, title: "Open", createdBy: "rin" });
		const response = await postPrompt(promptRequest(session.key, "do the thing"), {
			params: Promise.resolve({ key: session.key }),
		});
		expect(response.status).toBe(200);

		const [prompt] = await db
			.select()
			.from(sessionPrompts)
			.where(eq(sessionPrompts.sessionId, session.id));
		expect(prompt!.authorKind).toBe("human");
		expect(prompt!.body).toBe("do the thing");
	});
});

describe("Slack thread replies — the connector door", () => {
	const slackCtx = {
		orgId: "",
		connectorId: "conn-1",
		externalAccountId: "T123",
		traceId: "trace-cap-test",
		config: {},
	};

	const threadReply = (channel: string, thread: string, text: string) => ({
		team_id: "T123",
		event: {
			type: "message",
			user: "U777",
			text,
			channel,
			ts: "1700000001.000100",
			thread_ts: thread,
		},
	});

	async function threadSession() {
		const session = await createSession({ orgId, title: "Thread", createdBy: "slack:U777" });
		const threadRef = "C42:1700000000.000100";
		await db.insert(artifacts).values({
			orgId,
			sessionId: session.id,
			kind: "log",
			title: "slack-thread",
			url: `slack:${threadRef}`,
			payload: { threadRef, channel: "C42", ts: "1700000000.000100" },
		});
		return session;
	}

	it("a reply into a full queue is a typed ignore, not an unbounded insert", async () => {
		const session = await threadSession();
		for (let index = 0; index < 3; index += 1) {
			await queuePrompt({
				orgId,
				sessionId: session.id,
				author: "rin",
				authorKind: "human",
				body: `queued ${index}`,
			});
		}

		const result = await handleSlackWebhook(
			threadReply("C42", "1700000000.000100", "and another thing"),
			{ ...slackCtx, orgId },
		);

		expect(result.action).toBe("ignored");
		expect(result.reason).toMatch(/cap of 3/);
		expect(await promptCount(session.id)).toBe(3);
	});

	it("a reply into an archived session is refused with the session's reason", async () => {
		const session = await threadSession();
		await db.update(sessions).set({ status: "archived" }).where(eq(sessions.id, session.id));

		const result = await handleSlackWebhook(
			threadReply("C42", "1700000000.000100", "still there?"),
			{ ...slackCtx, orgId },
		);

		expect(result.action).toBe("ignored");
		expect(await promptCount(session.id)).toBe(0);
	});
});

describe("automations — the scheduled door", () => {
	it("an enqueue refusal fails the run and increments the self-pause counter", async () => {
		// An empty prompt is the refusal reachable on a fresh session (each run
		// creates its own). What matters is the PLUMBING: the front door's typed
		// refusal becomes a thrown error, the run is marked failed, and
		// consecutiveFailures moves — the exact loop-breaking path the cap's doc
		// comment promises for the amplification case.
		const [automation] = await db
			.insert(automations)
			.values({
				orgId,
				name: "hourly-empty",
				source: "cron",
				spec: { cron: "0 * * * *" },
				prompt: "   ",
				targetKind: "repo",
				targetId: "00000000-0000-4000-8000-000000000042",
				runtime: "claude-code",
			})
			.returning();

		// "skipped" is runAutomation's word for a failed run that has not yet
		// crossed the pause threshold.
		const outcome = await runAutomation(automation!.id);
		expect(outcome).toBe("skipped");

		const [run] = await db
			.select()
			.from(automationRuns)
			.where(eq(automationRuns.automationId, automation!.id));
		expect(run!.status).toBe("failed");
		expect(run!.error).toMatch(/empty|body/i);

		const [after] = await db
			.select()
			.from(automations)
			.where(eq(automations.id, automation!.id));
		expect(after!.consecutiveFailures).toBe(1);
	});
});

describe("spawn_child — the agent door", () => {
	it("a refused enqueue surfaces as the tool's error text, never a silent no-op", async () => {
		const parent = await createSession({ orgId, title: "Parent", createdBy: "rin" });
		const ctx: AgentToolContext = {
			orgId,
			sessionId: parent.id,
			sandboxId: "00000000-0000-4000-8000-000000000099",
			fencingToken: 1,
		};
		const spawn = agentTools.find((tool) => tool.name === "spawn_child");
		expect(spawn).toBeDefined();

		await expect(spawn!.run(ctx, { prompt: "   " })).rejects.toThrow(/empty|body/i);
	});
});
