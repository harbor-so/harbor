// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Two layers, matching the two layers of the feature.
 *
 * The normalizer tests are pure: a captured hook payload in, canonical rows out,
 * no database — that is the whole point of keeping parsing free of I/O. The
 * ingest tests drive the real route handler against the real database, because
 * the parts worth asserting — that the org comes off the key and not the payload,
 * that a tool call links to the claim it happened under — only exist once auth and
 * Postgres are in the loop.
 */

import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, sql } from "@core/schema/index.js";
import { activity, apiKeys, orgs, tasks } from "@core/schema/schema.js";
import { claim } from "@core/kernel/work.js";
import { hashApiKey, mintApiKey } from "@core/kernel/keys.js";
import { claudeCodeNormalizer } from "./claude-code.js";
import { cursorNormalizer } from "./cursor.js";
import { opencodeNormalizer } from "./opencode.js";
import { normalizerFor } from "./registry.js";
import { POST } from "../api/hooks/[runtime]/route.js";

describe("normalizers", () => {
	it("maps a Claude Code PreToolUse to a pre-phase tool_call", () => {
		const [row] = claudeCodeNormalizer.normalize({
			hook_event_name: "PreToolUse",
			session_id: "sess-1",
			tool_name: "Bash",
			tool_input: { command: "ls -la" },
			cwd: "/repo",
		});
		expect(row).toMatchObject({
			kind: "tool_call",
			phase: "pre",
			tool: "Bash",
			runtimeSessionId: "sess-1",
		});
		expect(row?.payload).toMatchObject({ command: "ls -la", cwd: "/repo" });
	});

	it("carries an explicit harbor_agent_id through", () => {
		const [row] = claudeCodeNormalizer.normalize({
			hook_event_name: "PostToolUse",
			session_id: "sess-1",
			tool_name: "Edit",
			tool_input: { file_path: "src/x.ts" },
			harbor_agent_id: "claude-code:worktree-3",
		});
		expect(row?.agentId).toBe("claude-code:worktree-3");
		expect(row?.phase).toBe("post");
	});

	it("clips a long command instead of storing it whole", () => {
		const [row] = claudeCodeNormalizer.normalize({
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_input: { command: "x".repeat(5000) },
		});
		expect((row?.payload?.command as string).length).toBeLessThan(5000);
		expect(row?.payload?.command).toContain("+3000 chars");
	});

	it("ignores an event Harbor does not track", () => {
		expect(claudeCodeNormalizer.normalize({ hook_event_name: "FileChanged" })).toHaveLength(0);
		expect(claudeCodeNormalizer.normalize({})).toHaveLength(0);
	});

	it("reads Cursor's camelCase events from query context", () => {
		const [edit] = cursorNormalizer.normalize(
			{ file_path: "a.ts", edits: [1, 2, 3], session_id: "cur-1" },
			{ event: "afterFileEdit" },
		);
		expect(edit).toMatchObject({ kind: "tool_call", phase: "post", tool: "edit" });
		expect(edit?.payload).toMatchObject({ file_path: "a.ts", edits: 3 });

		const [shell] = cursorNormalizer.normalize(
			{ command: "npm test" },
			{ event: "beforeShellExecution" },
		);
		expect(shell).toMatchObject({ kind: "tool_call", phase: "pre", tool: "shell" });
	});

	it("maps opencode's dotted events", () => {
		const [row] = opencodeNormalizer.normalize({
			event: "tool.execute.before",
			tool: "bash",
			sessionID: "oc-1",
			args: { command: "echo hi" },
		});
		expect(row).toMatchObject({ kind: "tool_call", phase: "pre", tool: "bash", runtimeSessionId: "oc-1" });
	});

	it("routes conductor through the Claude Code parser", () => {
		expect(normalizerFor("conductor")).toBe(claudeCodeNormalizer);
		expect(normalizerFor("nope")).toBeNull();
	});
});

describe("ingest route", () => {
	let orgId: string;
	let apiKey: string;

	beforeEach(async () => {
		await sql`truncate table activity, session_prompts, session_participants, sessions, runs, agent_presence, events, claims, tasks, projects, api_keys, digests, connectors, users, orgs cascade`;
		const [org] = await db.insert(orgs).values({ name: "Activity Org" }).returning();
		if (!org) throw new Error("Test org was not created.");
		orgId = org.id;
		apiKey = mintApiKey();
		await db.insert(apiKeys).values({ orgId, keyHash: hashApiKey(apiKey), label: "test" });
	});

	afterAll(async () => {
		await sql.end();
	});

	function post(runtime: string, body: unknown, key?: string, query = ""): Promise<Response> {
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (key) headers.authorization = `Bearer ${key}`;
		const request = new Request(`http://localhost/api/hooks/${runtime}${query}`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
		return POST(request, { params: Promise.resolve({ runtime }) });
	}

	it("refuses a request with no key", async () => {
		const res = await post("claude-code", { hook_event_name: "PreToolUse", tool_name: "Bash" });
		expect(res.status).toBe(401);
	});

	it("404s an unknown runtime", async () => {
		const res = await post("emacs", { hook_event_name: "PreToolUse" }, apiKey);
		expect(res.status).toBe(404);
	});

	it("records a tool call under the org the key belongs to", async () => {
		const res = await post(
			"claude-code",
			{ hook_event_name: "PostToolUse", session_id: "sess-42", tool_name: "Bash", tool_input: { command: "ls" } },
			apiKey,
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ recorded: 1 });

		const rows = await db.select().from(activity).where(eq(activity.orgId, orgId));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			runtime: "claude-code",
			kind: "tool_call",
			tool: "Bash",
			// No explicit id, so it falls back to runtime:session.
			agentId: "claude-code:sess-42",
		});
	});

	it("links a tool call to the task the agent currently holds", async () => {
		const [task] = await db
			.insert(tasks)
			.values({ orgId, title: "Wire the widget", status: "open" })
			.returning();
		await claim(orgId, task!.id, "claude-code:wt-7", { intent: "Build the widget wiring." });

		await post(
			"claude-code",
			{
				hook_event_name: "PreToolUse",
				session_id: "s1",
				tool_name: "Edit",
				tool_input: { file_path: "widget.ts" },
				harbor_agent_id: "claude-code:wt-7",
			},
			apiKey,
		);

		const [row] = await db
			.select()
			.from(activity)
			.where(and(eq(activity.orgId, orgId), eq(activity.agentId, "claude-code:wt-7")));
		expect(row?.taskId).toBe(task!.id);

		// And it did not touch the claim itself.
		const stillClaimed = await db.query.tasks.findFirst({ where: eq(tasks.id, task!.id) });
		expect(stillClaimed?.status).toBe("claimed");
	});

	it("accepts a batch and stores each event", async () => {
		const res = await post(
			"codex",
			[
				{ hook_event_name: "PreToolUse", session_id: "b", tool_name: "shell" },
				{ hook_event_name: "PostToolUse", session_id: "b", tool_name: "shell" },
			],
			apiKey,
		);
		expect(await res.json()).toEqual({ recorded: 2 });
		const rows = await db
			.select()
			.from(activity)
			.where(and(eq(activity.orgId, orgId), isNull(activity.taskId)));
		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.phase).sort()).toEqual(["post", "pre"]);
	});

	it("records a Conductor session running Codex, stamped as the conductor runtime", async () => {
		// Conductor drives Claude Code or Codex under the hood; the conductor endpoint
		// must parse the same PascalCase dialect and store `conductor` as the runtime.
		const res = await post(
			"conductor",
			{ hook_event_name: "PostToolUse", session_id: "cond-1", tool_name: "shell", tool_input: { command: "pytest" } },
			apiKey,
		);
		expect(await res.json()).toEqual({ recorded: 1 });
		const [row] = await db.select().from(activity).where(eq(activity.runtime, "conductor"));
		expect(row).toMatchObject({ runtime: "conductor", kind: "tool_call", tool: "shell", phase: "post" });
	});

	it("200s with zero rows for an event it does not track", async () => {
		const res = await post("claude-code", { hook_event_name: "Notification" }, apiKey);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ recorded: 0 });
	});
});
