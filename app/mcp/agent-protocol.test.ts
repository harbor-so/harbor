// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The agent-facing MCP surface, and the budget that keeps it from growing.
 *
 * The coordination server has a character budget with a test behind it, and the
 * whole reason background-agent capability lives on a *second* server is to avoid
 * quietly widening that budget. A second server with no budget of its own would
 * make the split pointless — the discipline would just have moved somewhere it
 * was not enforced.
 */

import { eq, sql as raw } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, sql } from "@core/schema/index";
import { artifacts, orgs, sandboxes, sessionPrompts, sessions } from "@core/schema/schema";
import { createSession } from "../../app/lib/sessions.js";
import {
	AGENT_TOOL_BUDGET_CHARS,
	agentToolSurfaceSize,
	agentTools,
	contextForSandboxToken,
	type AgentToolContext,
} from "./agent-tools.js";
import { tools as coordinationTools } from "@core/mcp/tools";

let orgId: string;
let ctx: AgentToolContext;

beforeEach(async () => {
	await sql`truncate table cost_events, circuit_breakers, automation_runs, automations, artifacts, session_events, sandboxes, session_repos, secrets, user_scm_tokens, environment_repos, environments, repos, activity, session_prompts, session_participants, sessions, runs, agent_presence, events, claims, tasks, projects, api_keys, digests, connectors, users, orgs cascade`;
	const [org] = await db.insert(orgs).values({ name: "Agent MCP Org" }).returning();
	orgId = org!.id;

	const session = await createSession({ orgId, title: "Fix the retry cap", createdBy: "rin" });
	ctx = { orgId, sessionId: session.id, sandboxId: "sbx", fencingToken: 1 };
});

afterAll(async () => {
	await sql.end();
});

const run = (name: string, args: Record<string, unknown> = {}) => {
	const tool = agentTools.find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`No agent tool named ${name}`);
	return tool.run(ctx, args);
};

describe("the budget", () => {
	it("stays under its cap", () => {
		const size = agentToolSurfaceSize();
		expect(size).toBeLessThan(AGENT_TOOL_BUDGET_CHARS);
	});

	/**
	 * The assertion that gives the two-server split its point. If background-agent
	 * capability ever migrates onto the coordination server, this fails — and the
	 * README makes a specific numeric claim about that server's size.
	 */
	it("shares no tool name with the coordination server", () => {
		const coordination = new Set(coordinationTools.map((tool) => tool.name));
		for (const tool of agentTools) {
			expect(coordination.has(tool.name)).toBe(false);
		}
		expect(coordinationTools).toHaveLength(5);
	});

	/**
	 * Descriptions are written for a model deciding whether to call something, and
	 * a description that only names the tool leaves it to guess — and a model that
	 * guesses calls it every turn.
	 */
	it("has a description on every tool that says when NOT to call it", () => {
		for (const tool of agentTools) {
			expect(tool.description.length).toBeGreaterThan(80);
		}
		expect(
			agentTools.find((t) => t.name === "record_artifact")!.description,
		).toContain("do not record those here");
		expect(agentTools.find((t) => t.name === "spawn_child")!.description).toContain(
			"Do not use it",
		);
	});
});

describe("report_progress", () => {
	it("writes a timeline event a client can render", async () => {
		await run("report_progress", { text: "Reproduced the drop with a failing test." });
		const [event] = await db.execute(
			raw`select type, payload, actor from session_events where session_id = ${ctx.sessionId}::uuid order by seq desc limit 1`,
		);
		expect(event).toMatchObject({ type: "agent_message", actor: "agent" });
	});

	/**
	 * `blocked` rides in the payload rather than as a distinct event type, so a
	 * consumer that has never heard of it still renders the message rather than
	 * rendering nothing.
	 */
	it("marks a blocked note in the payload, not as a new event type", async () => {
		await run("report_progress", { text: "Which database should I point at?", blocked: true });
		const [event] = (await db.execute(
			raw`select type, payload from session_events where session_id = ${ctx.sessionId}::uuid order by seq desc limit 1`,
		)) as unknown as Array<{ type: string; payload: { kind: string } }>;
		expect(event!.type).toBe("agent_message");
		expect(event!.payload.kind).toBe("needs_input");
	});
});

describe("record_artifact", () => {
	it("records the artifact and announces it on the timeline", async () => {
		await run("record_artifact", {
			kind: "screenshot",
			title: "Login page after the fix",
			url: "https://example.test/shot.png",
		});
		const rows = await db.select().from(artifacts).where(eq(artifacts.orgId, orgId));
		expect(rows).toHaveLength(1);
		expect(rows[0]!.kind).toBe("screenshot");
	});
});

describe("spawn_child", () => {
	it("creates an independent session that inherits the parent's target", async () => {
		await db
			.update(sessions)
			.set({ baseBranch: "main", runtime: "claude-code" })
			.where(eq(sessions.id, ctx.sessionId));

		const result = await run("spawn_child", {
			prompt: "Audit the other repositories for the same retry bug and report back.",
		});
		expect(result).toContain("spawned child session");

		const all = await db.select().from(sessions).where(eq(sessions.orgId, orgId));
		expect(all).toHaveLength(2);

		const child = all.find((s) => s.id !== ctx.sessionId)!;
		expect(child.createdBy).toBe(`agent:${ctx.sessionId}`);
		expect(child.baseBranch).toBe("main");
		expect(child.runtime).toBe("claude-code");

		const prompts = await db
			.select()
			.from(sessionPrompts)
			.where(eq(sessionPrompts.sessionId, child.id));
		// authorKind `agent`, so the session runner's priority ordering puts a
		// human's one-word correction ahead of this.
		expect(prompts[0]!.authorKind).toBe("agent");
	});

	/**
	 * Without a depth limit, an agent that decides delegation is the answer
	 * produces a tree, and the tree's cost is exponential in a system where every
	 * node boots a container.
	 */
	it("refuses a third level", async () => {
		const child = await createSession({
			orgId,
			title: "child",
			createdBy: `agent:${ctx.sessionId}`,
		});
		const childCtx: AgentToolContext = { ...ctx, sessionId: child.id };
		const tool = agentTools.find((t) => t.name === "spawn_child")!;

		await expect(
			tool.run(childCtx, { prompt: "Go one level deeper than Harbor allows, please." }),
		).rejects.toThrow(/third level/);
	});
});

describe("get_session_context", () => {
	it("returns what humans have said, so a corrected agent can notice", async () => {
		const { queuePrompt } = await import("../lib/sessions.js");
		await queuePrompt({
			orgId,
			sessionId: ctx.sessionId,
			author: "maya",
			body: "Actually do not touch the migration in this PR.",
		});
		const context = await run("get_session_context");
		expect(context).toContain("@maya");
		expect(context).toContain("do not touch the migration");
	});
});

describe("token resolution", () => {
	/**
	 * A stopped, stale or failed sandbox keeps its token row but must not be able
	 * to write. Persisted lifecycle state is the authority, not whether the process
	 * happens to still be running — which is the entire point of the fencing design,
	 * and the reason a token is re-resolved on every call rather than cached for the
	 * life of the connection.
	 */
	it("refuses a token belonging to a dead sandbox", async () => {
		const [live] = await db
			.insert(sandboxes)
			.values({
				orgId,
				sessionId: ctx.sessionId,
				provider: "docker",
				status: "ready",
				authTokenHash: "hash-live",
			})
			.returning();
		await db.insert(sandboxes).values({
			orgId,
			sessionId: ctx.sessionId,
			provider: "docker",
			status: "stopped",
			authTokenHash: "hash-dead",
		});

		expect(await contextForSandboxToken("hash-live")).toMatchObject({
			orgId,
			sessionId: ctx.sessionId,
			sandboxId: live!.id,
		});
		expect(await contextForSandboxToken("hash-dead")).toBeNull();
		expect(await contextForSandboxToken("hash-nonexistent")).toBeNull();
	});
});
