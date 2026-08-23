// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Digest tests keep the database boundary real and the paid model boundary fake.
 *
 * The joins and JSON payloads are where activity can silently disappear, so a
 * query mock would miss the valuable failures. Conversely, network calls would
 * make the suite costly and nondeterministic, so the SDK constructor is observed
 * and never allowed to reach Anthropic.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, sql } from "@core/schema/index.js";
import { events, orgs, projects, tasks } from "@core/schema/schema.js";

const anthropicConstructor = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
	default: class Anthropic {
		messages = { create: vi.fn() };

		constructor(options: unknown) {
			anthropicConstructor(options);
		}
	},
}));

import { MOCK_PREFIX, MissingAnthropicApiKeyError, collectActivity, generateDigest, mockDigest, renderActivityPrompt } from "./digest.js";

let orgId: string;
const since = new Date("2026-08-03T00:00:00.000Z");
const until = new Date("2026-08-10T00:00:00.000Z");

beforeEach(async () => {
	await sql`truncate table session_prompts, session_participants, sessions, runs, agent_presence, events, claims, tasks, projects, api_keys, digests, connectors, users, orgs cascade`;
	anthropicConstructor.mockClear();
	delete process.env.ANTHROPIC_API_KEY;

	const [org] = await db.insert(orgs).values({ name: "Digest Test Org" }).returning();
	orgId = org!.id;
});

afterAll(async () => {
	await sql.end();
});

describe("collectActivity", () => {
	it("groups completions and prevented conflicts by project", async () => {
		const [backend, frontend] = await db
			.insert(projects)
			.values([
				{ orgId, name: "backend" },
				{ orgId, name: "frontend" },
			])
			.returning();
		const [authTask, uiTask] = await db
			.insert(tasks)
			.values([
				{ orgId, projectId: backend!.id, title: "Fix token refresh" },
				{ orgId, projectId: frontend!.id, title: "Polish task list" },
			])
			.returning();

		await db.insert(events).values([
			{
				orgId,
				taskId: authTask!.id,
				agentId: "agent-a",
				type: "completed",
				payload: { summary: "Serialized refresh behind a mutex." },
				createdAt: new Date("2026-08-05T12:00:00.000Z"),
			},
			{
				orgId,
				taskId: authTask!.id,
				agentId: "agent-b",
				type: "claim_conflict",
				payload: { heldBy: "agent-a" },
				createdAt: new Date("2026-08-05T12:01:00.000Z"),
			},
			{
				orgId,
				taskId: uiTask!.id,
				agentId: "agent-c",
				type: "completed",
				payload: { summary: "Reduced layout shift." },
				createdAt: new Date("2026-08-06T12:00:00.000Z"),
			},
		]);

		await expect(collectActivity(orgId, since, until)).resolves.toEqual({
			projects: [
				{
					project: "backend",
					completed: [
						{
							task: "Fix token refresh",
							agent: "agent-a",
							summary: "Serialized refresh behind a mutex.",
						},
					],
					conflicts: [
						{
							task: "Fix token refresh",
							heldBy: "agent-a",
							blocked: "agent-b",
						},
					],
				},
				{
					project: "frontend",
					completed: [
						{
							task: "Polish task list",
							agent: "agent-c",
							summary: "Reduced layout shift.",
						},
					],
					conflicts: [],
				},
			],
		});
	});
});

describe("renderActivityPrompt", () => {
	it("keeps summaries in a compact line-oriented block", () => {
		const prompt = renderActivityPrompt({
			projects: [
				{
					project: "backend",
					completed: [
						{ task: "Fix auth", agent: "agent-a", summary: "Added token locking." },
					],
					conflicts: [
						{ task: "Fix auth", heldBy: "agent-a", blocked: "agent-b" },
					],
				},
			],
		});

		expect(prompt).toBe(
			"backend\ndone: Fix auth | agent-a | Added token locking.\n" +
				"conflict: Fix auth | held agent-a | blocked agent-b",
		);
		expect(prompt.length).toBeLessThan(140);
	});
});

describe("generateDigest", () => {
	it("throws a named, actionable error when ANTHROPIC_API_KEY is missing", async () => {
		const activity = {
			projects: [
				{
					project: "backend",
					completed: [{ task: "Fix auth", agent: "agent-a", summary: "Done." }],
					conflicts: [],
				},
			],
		};

		const error = await generateDigest(activity).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(MissingAnthropicApiKeyError);
		expect(error).toMatchObject({ name: "MissingAnthropicApiKeyError" });
		expect((error as Error).message).toContain("ANTHROPIC_API_KEY");
		expect(anthropicConstructor).not.toHaveBeenCalled();
	});

	it("returns an explicit empty-week result without constructing a client", async () => {
		const generation = await generateDigest({ projects: [] });
		expect(generation.body).toBe("No agent activity this week.");
		// No model was called, so there is no usage to account for — a digest
		// that cost nothing must report nothing, or the cost table gains rows
		// for API calls that never happened.
		expect(generation.usage).toBeNull();
		expect(generation.model).toBeNull();
		expect(anthropicConstructor).not.toHaveBeenCalled();
	});
});

describe("demo mode", () => {
	const original = { key: process.env.ANTHROPIC_API_KEY, demo: process.env.HARBOR_DEMO_MODE };

	afterEach(() => {
		process.env.ANTHROPIC_API_KEY = original.key;
		process.env.HARBOR_DEMO_MODE = original.demo;
	});

	const activity = {
		projects: [
			{
				project: "backend",
				completed: [{ task: "Fix auth refresh", agent: "claude-code:wt-1", summary: "Mutex." }],
				conflicts: [{ task: "Add rate limiting", heldBy: "codex:a", blocked: "codex:b" }],
			},
		],
	};

	it("still refuses when demo mode is off and no key is set", async () => {
		process.env.ANTHROPIC_API_KEY = "";
		process.env.HARBOR_DEMO_MODE = "";
		await expect(generateDigest(activity)).rejects.toThrow(/ANTHROPIC_API_KEY/);
	});

	it("produces a digest in demo mode without a key", async () => {
		process.env.ANTHROPIC_API_KEY = "";
		process.env.HARBOR_DEMO_MODE = "1";
		const generation = await generateDigest(activity);
		expect(generation.body).toContain("Fix auth refresh");
		expect(generation.body).toContain("collision avoided");
		// The mock called no model; usage must say so.
		expect(generation.usage).toBeNull();
	});

	it("labels every mocked digest so it can never pass for the model's work", async () => {
		// The label is the whole safety argument for shipping a fake summary at
		// all. If this assertion is ever deleted, the reason for the mock goes
		// with it.
		process.env.ANTHROPIC_API_KEY = "";
		process.env.HARBOR_DEMO_MODE = "1";
		expect((await generateDigest(activity)).body).toContain(MOCK_PREFIX);
		expect(mockDigest(activity).startsWith(MOCK_PREFIX)).toBe(true);
	});

	it("never mocks when a real key is present, even in demo mode", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-fake-for-routing-check";
		process.env.HARBOR_DEMO_MODE = "1";
		// Reaches the real client and fails on the network/auth rather than
		// silently returning a mock — a real key must always win.
		await expect(generateDigest(activity)).rejects.toThrow();
		await expect(generateDigest(activity)).rejects.not.toThrow(/ANTHROPIC_API_KEY is required/);
	});

	it("short-circuits an empty week without calling anything", async () => {
		process.env.ANTHROPIC_API_KEY = "";
		process.env.HARBOR_DEMO_MODE = "";
		const generation = await generateDigest({ projects: [] });
		expect(generation.body).not.toContain(MOCK_PREFIX);
		expect(generation.body.length).toBeGreaterThan(0);
	});
});
