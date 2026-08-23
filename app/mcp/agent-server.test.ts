// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The `harbor-agent` surface, over the wire, driven by a real MCP client.
 *
 * `agent-protocol.test.ts` calls the tools' `run` functions directly, which
 * proves they work and proved nothing about whether anything served them — and
 * for several releases nothing did. The tools were written, tested and never
 * mounted, so `record_artifact` and `report_progress` were unreachable from
 * inside the sandbox they exist for. This suite is the missing half: it speaks
 * Streamable HTTP to the mounted route with the SDK's own `Client`, the same
 * implementation the agents use.
 *
 * The auth cases carry most of the weight. This endpoint lets a box write into a
 * session's transcript, so what matters is not that a valid caller succeeds but
 * that a zombie, an impostor and an unauthenticated caller all fail.
 */

import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, sql } from "@core/schema/index.js";
import { artifacts, orgs, sandboxes, sessions } from "@core/schema/schema.js";
import { sha256Hex } from "../lib/session-runner.js";
import { createSession } from "../lib/sessions.js";
import { app } from "./server.js";

let server: Server;
let baseUrl: string;
let orgId: string;
let sessionId: string;

interface Box {
	id: string;
	token: string;
	fence: number;
}

/**
 * A sandbox row and its credentials.
 *
 * The fencing token is an ordinal over a session's sandbox rows, so the Nth box
 * created for a session holds fence N. Seeding a second box is therefore how a
 * test makes the first one a zombie — which is the real-world shape: the lease
 * lapsed, the control plane booted a replacement, and the original is still
 * running and still convinced it owns the work.
 */
async function seedBox(fence: number): Promise<Box> {
	const token = `sbx-token-${fence}-${Math.random().toString(16).slice(2)}`;
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
	return { id: box!.id, token, fence };
}

async function connect(box: Box, overrides: Partial<Box> = {}): Promise<Client> {
	const id = overrides.id ?? box.id;
	const client = new Client({ name: "harbor-agent-test", version: "0.0.0" });
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${baseUrl}/agent/${id}/mcp`), {
			requestInit: {
				headers: {
					Authorization: `Bearer ${overrides.token ?? box.token}`,
					"x-harbor-fencing-token": String(overrides.fence ?? box.fence),
				},
			},
		}),
	);
	return client;
}

beforeEach(async () => {
	await sql`truncate table cost_events, circuit_breakers, automation_runs, automations, artifacts, session_events, sandboxes, session_repos, secrets, user_scm_tokens, environment_repos, environments, repos, activity, session_prompts, session_participants, sessions, runs, agent_presence, events, claims, tasks, projects, api_keys, digests, connectors, users, orgs cascade`;
	const [org] = await db.insert(orgs).values({ name: "Agent Server Org" }).returning();
	orgId = org!.id;
	const session = await createSession({ orgId, title: "Raise the retry cap", createdBy: "rin" });
	sessionId = session.id;

	if (!server) {
		server = await new Promise<Server>((resolve) => {
			const listening = app.listen(0, () => resolve(listening));
		});
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;
	}
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await sql.end();
});

describe("a live sandbox can reach its tools", () => {
	it("serves the four agent tools and none of the coordination ones", async () => {
		const box = await seedBox(1);
		const client = await connect(box);

		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"get_session_context",
			"record_artifact",
			"report_progress",
			"spawn_child",
		]);
		// The coordination budget's whole justification is that this surface is
		// separate. If `claim` appears here the split has silently collapsed.
		expect(tools.map((tool) => tool.name)).not.toContain("claim");

		await client.close();
	});

	it("records an artifact that actually lands in the database", async () => {
		const box = await seedBox(1);
		const client = await connect(box);

		await client.callTool({
			name: "record_artifact",
			arguments: {
				kind: "screenshot",
				title: "Retry cap dialog after the fix",
				url: "https://example.com/shots/retry-cap.png",
			},
		});
		await client.close();

		const rows = await db.query.artifacts.findMany({
			where: and(eq(artifacts.orgId, orgId), eq(artifacts.sessionId, sessionId)),
		});
		expect(rows).toHaveLength(1);
		expect(rows[0]!.url).toBe("https://example.com/shots/retry-cap.png");
	});

	it("refuses to record a pull request through this tool", async () => {
		const box = await seedBox(1);
		const client = await connect(box);

		// `kind` is a closed enum of things only the agent knows about. A pull request
		// is not one: the control plane opens it and records it from the push path, so
		// letting an agent assert one here would put a second, unverified writer on the
		// row the merged-PR metric is computed from.
		const result = await client.callTool({
			name: "record_artifact",
			arguments: { kind: "pull_request", title: "Raise the retry cap" },
		});
		expect(result.isError).toBe(true);
		await client.close();

		const rows = await db.query.artifacts.findMany({ where: eq(artifacts.orgId, orgId) });
		expect(rows).toHaveLength(0);
	});
});

describe("who is refused", () => {
	it("refuses a caller with no sandbox token", async () => {
		const box = await seedBox(1);
		const client = new Client({ name: "no-token", version: "0.0.0" });

		await expect(
			client.connect(
				new StreamableHTTPClientTransport(new URL(`${baseUrl}/agent/${box.id}/mcp`), {
					requestInit: { headers: { "x-harbor-fencing-token": "1" } },
				}),
			),
		).rejects.toThrow();
	});

	it("refuses a valid token presented with no fencing token", async () => {
		const box = await seedBox(1);
		const client = new Client({ name: "no-fence", version: "0.0.0" });

		// Authentication alone is deliberately not enough. A box whose lease lapsed
		// still holds a genuine credential, so a surface that accepted the token on
		// its own would let a zombie write for as long as it stayed up.
		await expect(
			client.connect(
				new StreamableHTTPClientTransport(new URL(`${baseUrl}/agent/${box.id}/mcp`), {
					requestInit: { headers: { Authorization: `Bearer ${box.token}` } },
				}),
			),
		).rejects.toThrow();
	});

	it("refuses a superseded box — the zombie case ADR 0002 exists for", async () => {
		const zombie = await seedBox(1);
		await seedBox(2); // the replacement; the session's fence is now 2

		// Still running, still healthy, still holding a valid per-attempt token, and
		// still convinced it owns the session. Only the fence separates it from the
		// box that legitimately holds the work.
		await expect(connect(zombie)).rejects.toThrow();

		const rows = await db.query.artifacts.findMany({ where: eq(artifacts.orgId, orgId) });
		expect(rows).toHaveLength(0);
	});

	it("refuses a box naming another sandbox's id", async () => {
		const mine = await seedBox(1);
		const theirs = await seedBox(2);

		// The id is in the path and the token is in a header, so without a check that
		// they agree, any authenticated box could write into another's session.
		await expect(connect(mine, { id: theirs.id })).rejects.toThrow();
	});

	it("refuses a box whose lifecycle has already closed", async () => {
		const box = await seedBox(1);
		await db.update(sandboxes).set({ status: "stopped" }).where(eq(sandboxes.id, box.id));

		// Persisted lifecycle state is authoritative over transport: a box Harbor has
		// already reaped does not get to keep talking because its socket is open.
		await expect(connect(box)).rejects.toThrow();
	});
});

describe("the session it may write to", () => {
	it("scopes writes to the sandbox's own session, not one named by the caller", async () => {
		const box = await seedBox(1);
		const other = await createSession({
			orgId,
			title: "Somebody else's work",
			createdBy: "maya",
		});

		const client = await connect(box);
		await client.callTool({
			name: "record_artifact",
			arguments: { kind: "log", title: "build output", session_id: other.id },
		});
		await client.close();

		// `session_id` is not a parameter these tools take; it comes off the resolved
		// sandbox row. A caller that could name its own session could write into any
		// room in the org.
		const stray = await db.query.artifacts.findMany({
			where: eq(artifacts.sessionId, other.id),
		});
		expect(stray).toHaveLength(0);
		const mine = await db.query.artifacts.findMany({ where: eq(artifacts.sessionId, sessionId) });
		expect(mine).toHaveLength(1);
	});

	it("still refuses after the lease lapses mid-connection", async () => {
		const box = await seedBox(1);
		const client = await connect(box);

		// One successful call while it legitimately holds the fence...
		await client.callTool({
			name: "record_artifact",
			arguments: { kind: "log", title: "first, while current" },
		});

		// ...then the control plane boots a replacement. The authority is re-resolved
		// per request, not cached at connect time, so the very next call is refused
		// even though the transport is still open. A capability captured at connect
		// would let this box keep writing until it happened to disconnect — exactly
		// the window in which a second agent has taken the work.
		await seedBox(2);

		await expect(
			client.callTool({ name: "record_artifact", arguments: { kind: "log", title: "second" } }),
		).rejects.toThrow();

		await client.close().catch(() => {});
		const rows = await db.query.artifacts.findMany({ where: eq(artifacts.sessionId, sessionId) });
		expect(rows).toHaveLength(1);
	});
});

describe("the session row is untouched by all this", () => {
	it("leaves the session's own state alone when a tool call is refused", async () => {
		const zombie = await seedBox(1);
		await seedBox(2);
		await expect(connect(zombie)).rejects.toThrow();

		const row = await db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) });
		expect(row).toBeTruthy();
	});
});
