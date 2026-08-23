// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Every finished turn writes a cost row — the wiring that makes the daily cap real.
 *
 * Before this suite, `recordTokenUsage` and `recordCost` had zero production
 * callers. The bridge dutifully attached an `AgentUsage` block to every
 * `agent_finished`, the ingest route dropped it on the floor, and `cost_events`
 * in a running deployment contained only zero-valued spawn reservations — so
 * the $50/day cap could never trip, because nothing ever counted against it.
 *
 * These tests drive the REAL route handler with real `Request`s against real
 * Postgres, the same harness style as session-runner.test.ts, and then read
 * the money back through `budgetStatus` — the consumer whose answer the cap
 * decision is actually made from.
 */

import { createHash } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as postSandboxEvents } from "./[id]/events/route.js";
import { db, sql } from "@core/schema/index.js";
import { claims, costEvents, orgs, sandboxes, sessionPrompts, sessions } from "@core/schema/schema.js";
import { budgetStatus } from "../../lib/cost.js";
import { takeNextPrompt } from "../../lib/session-runner.js";
import { createSession, queuePrompt } from "../../lib/sessions.js";
import { claim, createTask } from "@core/kernel/work.js";

let orgId: string;
let sessionId: string;

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

async function makeSandbox(token: string) {
	const [box] = await db
		.insert(sandboxes)
		.values({
			orgId,
			sessionId,
			provider: "test",
			status: "ready",
			externalId: `ext-${Math.random().toString(16).slice(2)}`,
			authTokenHash: sha256Hex(token),
		})
		.returning();
	return box!;
}

/** Queue a prompt and move it to `delivered`, returning its id. */
async function deliveredPrompt(body: string): Promise<string> {
	await queuePrompt({ orgId, sessionId, author: "rin", authorKind: "human", body });
	const taken = await takeNextPrompt(orgId, sessionId);
	if (!taken) throw new Error("expected a prompt to take");
	return taken.id;
}

function finishBatch(
	box: { id: string },
	promptId: string,
	usage: Record<string, unknown> | undefined,
	options: { type?: string } = {},
): Request {
	return new Request(`http://harbor.test/api/sandbox/${box.id}/events`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: "Bearer tok-cost",
			"x-harbor-fencing-token": "1",
		},
		body: JSON.stringify({
			events: [
				{
					type: options.type ?? "agent_finished",
					sandbox_id: box.id,
					session_id: sessionId,
					payload: { prompt_id: promptId, ...(usage !== undefined ? { usage } : {}) },
				},
			],
		}),
	});
}

const post = (request: Request, boxId: string) =>
	postSandboxEvents(request, { params: Promise.resolve({ id: boxId }) });

const tokenRows = () =>
	db
		.select()
		.from(costEvents)
		.where(and(eq(costEvents.orgId, orgId), like(costEvents.kind, "%tokens%")));

beforeEach(async () => {
	await sql`truncate table cost_events, circuit_breakers, automation_runs, automations, artifacts, session_events, sandboxes, session_repos, secrets, user_scm_tokens, environment_repos, environments, repos, activity, session_prompts, session_participants, sessions, runs, agent_presence, events, claims, tasks, projects, api_keys, digests, connectors, users, orgs cascade`;
	const [org] = await db.insert(orgs).values({ name: "Cost Ingest Org" }).returning();
	orgId = org!.id;
	const session = await createSession({ orgId, title: "Billed", createdBy: "rin" });
	sessionId = session.id;
});

afterAll(async () => {
	await sql.end();
});

describe("agent_finished usage becomes a cost row", () => {
	it("records a priced tokens row and it counts against the budget", async () => {
		const box = await makeSandbox("tok-cost");
		const promptId = await deliveredPrompt("do the thing");

		const response = await post(
			finishBatch(box, promptId, {
				source: "agent_reported",
				input_tokens: 1_000_000,
				output_tokens: 500_000,
				model: "claude-sonnet-4-5",
			}),
			box.id,
		);
		expect(response.status).toBe(200);

		const rows = await tokenRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]!.microUsd).toBeGreaterThan(0);
		expect(rows[0]!.sessionId).toBe(sessionId);
		expect(rows[0]!.quantity).toBe(1_500_000);
		// The model column carries the pricing stamp, so the price is auditable.
		expect(rows[0]!.model).toContain("@");

		const budget = await budgetStatus(orgId);
		expect(budget.spentMicroUsd).toBe(rows[0]!.microUsd);
	});

	it("attributes the row to the active claim on the session's task", async () => {
		const created = await createTask(orgId, { title: "Attributed" });
		await db.update(sessions).set({ taskId: created.id }).where(eq(sessions.id, sessionId));
		const claimed = await claim(orgId, created.id, "runner:cost", { intent: "Hold this task for the sandbox test." });
		if (!claimed.ok) throw new Error("expected claim");

		const box = await makeSandbox("tok-cost");
		const promptId = await deliveredPrompt("attributed work");
		await post(
			finishBatch(box, promptId, {
				source: "agent_reported",
				input_tokens: 10,
				output_tokens: 10,
				model: "claude-sonnet-4-5",
			}),
			box.id,
		);

		const [row] = await tokenRows();
		expect(row!.claimId).toBe(claimed.claimId);
	});

	it("lands with a null claim when the lease already lapsed — legal, rolls up to the org", async () => {
		const created = await createTask(orgId, { title: "Lapsed" });
		await db.update(sessions).set({ taskId: created.id }).where(eq(sessions.id, sessionId));
		const claimed = await claim(orgId, created.id, "runner:cost", { intent: "Hold this task for the sandbox test." });
		if (!claimed.ok) throw new Error("expected claim");
		await db
			.update(claims)
			.set({ releasedAt: new Date() })
			.where(eq(claims.id, claimed.claimId));

		const box = await makeSandbox("tok-cost");
		const promptId = await deliveredPrompt("late bill");
		await post(
			finishBatch(box, promptId, {
				source: "agent_reported",
				input_tokens: 10,
				output_tokens: 10,
				model: "claude-sonnet-4-5",
			}),
			box.id,
		);

		const [row] = await tokenRows();
		expect(row).toBeDefined();
		expect(row!.claimId).toBeNull();
	});

	it("agent-reported money wins over the table price and is stamped agent_reported", async () => {
		const box = await makeSandbox("tok-cost");
		const promptId = await deliveredPrompt("self-priced");
		await post(
			finishBatch(box, promptId, {
				source: "agent_reported",
				input_tokens: 5,
				output_tokens: 5,
				model: "claude-sonnet-4-5",
				micro_usd: 123_456,
			}),
			box.id,
		);

		const [row] = await tokenRows();
		expect(row!.microUsd).toBe(123_456);
		// The stamp is the audit trail: this number came from the agent's own
		// bill, not from Harbor's price table, and the row must say so.
		expect(row!.model).toContain("agent_reported");
	});

	it("source unavailable records a VISIBLE zero-priced row rather than inventing a price", async () => {
		const box = await makeSandbox("tok-cost");
		const promptId = await deliveredPrompt("unbillable");
		await post(
			finishBatch(box, promptId, {
				source: "unavailable",
				input_tokens: 0,
				output_tokens: 0,
				model: null,
			}),
			box.id,
		);

		const rows = await tokenRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]!.microUsd).toBe(0);
	});

	it("a re-sent batch — the lost 200 — is absorbed and the spend is not doubled", async () => {
		const box = await makeSandbox("tok-cost");
		const promptId = await deliveredPrompt("retried");
		const usage = {
			source: "agent_reported",
			input_tokens: 100_000,
			output_tokens: 100_000,
			model: "claude-sonnet-4-5",
		};

		await post(finishBatch(box, promptId, usage), box.id);
		const [first] = await tokenRows();

		// The bridge never saw the 200 and re-sends the identical batch. The named
		// prompt keys the cost row, so the retry derives the same ids and collides.
		await post(finishBatch(box, promptId, usage), box.id);

		const rows = await tokenRows();
		expect(rows).toHaveLength(1);
		const budget = await budgetStatus(orgId);
		expect(budget.spentMicroUsd).toBe(first!.microUsd);
	});

	it("agent_failed turns are billed too — a failed turn spent real tokens", async () => {
		const box = await makeSandbox("tok-cost");
		const promptId = await deliveredPrompt("doomed");
		await post(
			finishBatch(
				box,
				promptId,
				{
					source: "agent_reported",
					input_tokens: 50_000,
					output_tokens: 1_000,
					model: "claude-sonnet-4-5",
				},
				{ type: "agent_failed" },
			),
			box.id,
		);

		const rows = await tokenRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]!.microUsd).toBeGreaterThan(0);
	});

	it("a malformed usage block is unbilled but the transcript survives — never a 500", async () => {
		const box = await makeSandbox("tok-cost");
		const promptId = await deliveredPrompt("garbage usage");
		const response = await post(
			finishBatch(box, promptId, {
				source: "agent_reported",
				input_tokens: "a lot",
				output_tokens: null,
			}),
			box.id,
		);
		expect(response.status).toBe(200);

		expect(await tokenRows()).toHaveLength(0);
		// The turn itself closed normally.
		const [prompt] = await db
			.select()
			.from(sessionPrompts)
			.where(eq(sessionPrompts.id, promptId));
		expect(prompt!.status).toBe("completed");
	});

	it("recorded usage flips budgetStatus.exhausted once it crosses the cap", async () => {
		process.env.HARBOR_MAX_SPEND_PER_DAY_MICRO_USD = "100000";
		try {
			const box = await makeSandbox("tok-cost");
			const promptId = await deliveredPrompt("expensive");
			await post(
				finishBatch(box, promptId, {
					source: "agent_reported",
					input_tokens: 1,
					output_tokens: 1,
					model: "claude-sonnet-4-5",
					micro_usd: 150_000,
				}),
				box.id,
			);

			const budget = await budgetStatus(orgId);
			expect(budget.exhausted).toBe(true);
			expect(budget.spentMicroUsd).toBe(150_000);
		} finally {
			delete process.env.HARBOR_MAX_SPEND_PER_DAY_MICRO_USD;
		}
	});
});
