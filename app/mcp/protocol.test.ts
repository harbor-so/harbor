// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Protocol conformance, driven by a real MCP client.
 *
 * The earlier verification of this server was curl posting hand-written
 * JSON-RPC, and that proves less than it appears to: it proves the server
 * answers the shape of request I happened to write. It cannot catch a missing
 * `Mcp-Session-Id` behaviour, a capability we never advertise, a content block
 * the spec requires, or an `Accept` header negotiation that only the real client
 * performs — and every one of those is invisible until Claude Code fails to
 * connect in front of a customer.
 *
 * So this suite drives the server with `@modelcontextprotocol/sdk`'s own
 * `Client` over `StreamableHTTPClientTransport`, which is the same client
 * implementation Claude Code and Codex use. If these pass, an agent host can
 * connect; if they fail, the transport is wrong regardless of what curl said.
 *
 * The server is started on an ephemeral port for the duration, so the tests are
 * self-contained and do not assume anything is already running.
 */

import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@core/schema/index";
import { apiKeys, orgs, projects, tasks } from "@core/schema/schema";
import { hashApiKey, mintApiKey } from "@core/kernel/keys";
import { app } from "../../app/mcp/server.js";

let server: Server;
let baseUrl: string;
let apiKey: string;
let orgId: string;

async function connect(key: string): Promise<Client> {
	const client = new Client({ name: "harbor-test", version: "0.0.0" });
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
			requestInit: { headers: { Authorization: `Bearer ${key}` } },
		}),
	);
	return client;
}

/** The text an agent actually reads, unwrapped from the content envelope. */
function textOf(result: unknown): string {
	const content = (result as { content: Array<{ type: string; text?: string }> }).content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

beforeAll(async () => {
	await sql`truncate table session_prompts, session_participants, sessions, runs, agent_presence, events, claims, tasks, projects, api_keys, digests, connectors, users, orgs cascade`;

	const [org] = await db.insert(orgs).values({ name: "Protocol Org" }).returning();
	orgId = org!.id;
	const [project] = await db
		.insert(projects)
		.values({ orgId, name: "backend" })
		.returning();
	await db.insert(tasks).values([
		{ orgId, projectId: project!.id, title: "Fix auth token refresh bug", status: "open" },
		{ orgId, projectId: project!.id, title: "Add rate limiting", status: "open" },
	]);

	apiKey = mintApiKey();
	await db.insert(apiKeys).values({ orgId, keyHash: hashApiKey(apiKey), label: "test" });

	server = await new Promise<Server>((resolve) => {
		const listening = app.listen(0, () => resolve(listening));
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await sql.end();
});

describe("transport", () => {
	it("completes a real MCP handshake", async () => {
		const client = await connect(apiKey);
		const info = client.getServerVersion();
		expect(info?.name).toBe("harbor");
		// Instructions are how an agent host learns the claim-before-you-work rule
		// without the operator having to paste it into a prompt.
		expect(client.getInstructions()).toMatch(/list_work/);
		await client.close();
	});

	it("refuses a bad key at connect time, not at first tool call", async () => {
		// Failing late would mean an agent starts a task believing it has
		// coordination and silently has none.
		await expect(connect("hbr_definitely-not-a-real-key")).rejects.toThrow();
	});

	it("refuses a missing key", async () => {
		const client = new Client({ name: "harbor-test", version: "0.0.0" });
		await expect(
			client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`))),
		).rejects.toThrow();
	});
});

describe("tools/list", () => {
	it("advertises exactly the five tools, and no more", async () => {
		const client = await connect(apiKey);
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name).sort()).toEqual(
			["claim", "create_task", "list_work", "release", "renew_claim"].sort(),
		);
		await client.close();
	});

	it("keeps the whole tool surface under a 1200-token budget", async () => {
		// This is the product claim, asserted. The tool list is re-read by the model
		// on every turn, so a regression here is paid forever, by every agent.
		//
		// The cap sits just above the actual cost (~1,130 tokens) rather than at a
		// round number well above it. A budget with 30% headroom is not a budget: it
		// passes while a sixth tool is added, which is the exact regression it exists
		// to catch. Rewording a description stays green; adding a tool does not.
		const client = await connect(apiKey);
		const { tools } = await client.listTools();
		const cost = Math.ceil(JSON.stringify(tools).length / 4);
		expect(cost).toBeLessThan(1200);
		await client.close();
	});

	it("gives every tool a description that says when to call it", async () => {
		const client = await connect(apiKey);
		const { tools } = await client.listTools();
		for (const tool of tools) {
			expect(tool.description ?? "", `${tool.name} description`).not.toHaveLength(0);
			expect(tool.inputSchema).toBeDefined();
		}
		await client.close();
	});

	it("declares required arguments so a host can reject a bad call locally", async () => {
		const client = await connect(apiKey);
		const { tools } = await client.listTools();
		const claimTool = tools.find((t) => t.name === "claim");
		expect(claimTool?.inputSchema.required).toEqual(
			expect.arrayContaining(["task_id", "agent_id"]),
		);
		await client.close();
	});
});

describe("tools/call", () => {
	it("returns plain text, never JSON, for list_work", async () => {
		const client = await connect(apiKey);
		const text = textOf(await client.callTool({ name: "list_work", arguments: {} }));

		expect(text).toMatch(/^\[\w{4}\] /m);
		// The entire token argument collapses if a payload ever comes back as JSON.
		expect(text.trimStart().startsWith("{")).toBe(false);
		expect(text).not.toMatch(/"title"\s*:/);
		// And no ISO timestamps, which are ~10 tokens each for a value the model
		// immediately converts to "20 minutes".
		expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
		await client.close();
	});

	it("runs a full claim → conflict → release cycle over the wire", async () => {
		const client = await connect(apiKey);
		const listing = textOf(await client.callTool({ name: "list_work", arguments: {} }));
		const id = /\[(\w{4})\]/.exec(listing)?.[1];
		expect(id).toBeDefined();

		const claimed = textOf(
			await client.callTool({
				name: "claim",
				arguments: {
					task_id: id,
					agent_id: "claude-code:wt-1",
					intent: "Fixing the token refresh race before it pages anyone.",
				},
			}),
		);
		expect(claimed).toMatch(/^ok claimed/);

		const conflict = await client.callTool({
			name: "claim",
			arguments: {
				task_id: id,
				agent_id: "codex:wt-2",
				intent: "Wanted to take the same task, will pivot if it is held.",
			},
		});
		const conflictText = textOf(conflict);
		expect(conflictText).toMatch(/^no /);
		expect(conflictText).toContain("claude-code:wt-1");
		// The holder's intent is echoed verbatim so the loser can judge whether to wait.
		expect(conflictText).toContain("token refresh race");
		// A refusal is a normal result, not a protocol error: the model has to read
		// it and choose different work, which it cannot do with an exception.
		expect(conflict.isError).toBeFalsy();
		// And it must be actionable, not merely negative: either a concrete
		// alternative to open, or the fallback pointer to list_work.
		expect(conflictText).toMatch(/open instead|list_work|retry/);

		const released = textOf(
			await client.callTool({
				name: "release",
				arguments: {
					task_id: id,
					agent_id: "claude-code:wt-1",
					completion_summary: "Serialised refresh behind a mutex.",
				},
			}),
		);
		expect(released).toMatch(/^ok completed/);
		await client.close();
	});

	it("surfaces a user error as isError content rather than a thrown protocol error", async () => {
		const client = await connect(apiKey);
		// "zzzz" is not hex, so it is now rejected by shape before it ever reaches a
		// LIKE pattern — a strictly better message than the old "No task matching".
		const badShape = await client.callTool({
			name: "release",
			arguments: { task_id: "zzzz", agent_id: "nobody" },
		});
		expect(badShape.isError).toBe(true);
		expect(textOf(badShape)).toMatch(/not a task id/);

		// A well-formed id that simply does not exist still reports the miss.
		const missing = await client.callTool({
			name: "release",
			arguments: { task_id: "beef", agent_id: "nobody" },
		});
		expect(missing.isError).toBe(true);
		expect(textOf(missing)).toMatch(/No task matching/);
		await client.close();
	});

	it("reports an unknown tool as an error result rather than a transport failure", async () => {
		// Asserting a thrown exception here would have been wrong, and the real
		// client is what showed it: the SDK answers an unknown tool with an
		// isError result, so a model that hallucinates `search_issues` — a tool
		// Linear has and Harbor deliberately does not — reads "no such tool" and
		// carries on, instead of the session dying on a protocol error.
		const client = await connect(apiKey);
		const result = await client.callTool({ name: "search_issues", arguments: {} });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/search_issues|not found|unknown/i);
		await client.close();
	});

	it("creates a task and returns it in the same compact line format", async () => {
		const client = await connect(apiKey);
		const text = textOf(
			await client.callTool({
				name: "create_task",
				arguments: { title: "Add retry to webhook handler", project: "backend" },
			}),
		);
		expect(text).toMatch(/^\[\w{4}\] Add retry to webhook handler/);
		expect(text).toContain("project: backend");
		await client.close();
	});
});

describe("tenancy", () => {
	it("never shows one org's tasks to another org's key", async () => {
		const [otherOrg] = await db.insert(orgs).values({ name: "Other Org" }).returning();
		await db
			.insert(tasks)
			.values({ orgId: otherOrg!.id, title: "Secret work in another org", status: "open" });
		const otherKey = mintApiKey();
		await db
			.insert(apiKeys)
			.values({ orgId: otherOrg!.id, keyHash: hashApiKey(otherKey), label: "other" });

		const mine = await connect(apiKey);
		const theirs = await connect(otherKey);

		const mineText = textOf(await mine.callTool({ name: "list_work", arguments: {} }));
		const theirsText = textOf(await theirs.callTool({ name: "list_work", arguments: {} }));

		expect(mineText).not.toContain("Secret work in another org");
		expect(theirsText).toContain("Secret work in another org");
		expect(theirsText).not.toContain("Fix auth token refresh bug");

		await mine.close();
		await theirs.close();
	});

	it("refuses a revoked key", async () => {
		const doomed = mintApiKey();
		const [row] = await db
			.insert(apiKeys)
			.values({ orgId, keyHash: hashApiKey(doomed), label: "doomed" })
			.returning();
		const client = await connect(doomed);
		await client.close();

		await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, row!.id));
		await expect(connect(doomed)).rejects.toThrow();
	});
});

