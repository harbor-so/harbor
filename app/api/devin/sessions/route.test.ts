// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The registration route against the real database, with only Devin's spawn call
 * stubbed. What matters here is tenancy and idempotency: the org comes off the key
 * and never the body, a task id from another org misses, and re-registering a
 * session returns the existing mapping rather than minting a second one.
 */

import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../devin/client.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../devin/client.js")>();
	return { ...actual, createDevinSession: vi.fn() };
});

import { db, sql } from "@core/schema/index.js";
import { apiKeys, connectors, devinSessions, orgs, sessions, tasks } from "@core/schema/schema.js";
import { hashApiKey, mintApiKey } from "@core/kernel/keys.js";
import { createDevinSession } from "../../../devin/client.js";
import { POST } from "./route.js";

const mockCreate = vi.mocked(createDevinSession);

let orgId: string;
let apiKey: string;

function post(body: unknown, key?: string): Promise<Response> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (key) headers.authorization = `Bearer ${key}`;
	return POST(
		new Request("http://localhost/api/devin/sessions", { method: "POST", headers, body: JSON.stringify(body) }),
	);
}

beforeEach(async () => {
	await sql`truncate table devin_sessions, artifacts, session_participants, sessions, agent_presence, events, claims, tasks, connectors, api_keys, users, orgs cascade`;
	mockCreate.mockReset();
	// Keep token resolution deterministic regardless of the host environment.
	delete process.env.DEVIN_API_TOKEN;

	const [org] = await db.insert(orgs).values({ name: "Devin Org" }).returning();
	orgId = org!.id;
	apiKey = mintApiKey();
	await db.insert(apiKeys).values({ orgId, keyHash: hashApiKey(apiKey), label: "test" });
});

afterAll(async () => {
	await sql.end();
});

describe("POST /api/devin/sessions", () => {
	it("refuses a request with no key", async () => {
		expect((await post({ devinSessionId: "devin-1" })).status).toBe(401);
	});

	it("400s when neither devinSessionId nor prompt is given", async () => {
		expect((await post({}, apiKey)).status).toBe(400);
	});

	it("registers an existing Devin session and mints a Harbor session", async () => {
		const res = await post({ devinSessionId: "devin-1", title: "QA the widget" }, apiKey);
		expect(res.status).toBe(201);
		const json = await res.json();
		expect(json).toMatchObject({ status: "tracking", devinSessionId: "devin-1" });

		const rows = await db.select().from(devinSessions).where(eq(devinSessions.orgId, orgId));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.sessionId).toBe(json.sessionId);
		const harbor = await db.query.sessions.findFirst({ where: eq(sessions.id, json.sessionId) });
		expect(harbor?.title).toBe("QA the widget");
	});

	it("is idempotent: re-registering returns the same mapping, no second session", async () => {
		const first = await (await post({ devinSessionId: "devin-1" }, apiKey)).json();
		const res = await post({ devinSessionId: "devin-1" }, apiKey);
		expect(res.status).toBe(200);
		const second = await res.json();
		expect(second).toMatchObject({ status: "already_tracked", sessionId: first.sessionId });

		expect(await db.select().from(devinSessions).where(eq(devinSessions.orgId, orgId))).toHaveLength(1);
		expect(await db.select().from(sessions).where(eq(sessions.orgId, orgId))).toHaveLength(1);
	});

	it("refuses a task id from another org", async () => {
		const [otherOrg] = await db.insert(orgs).values({ name: "Other" }).returning();
		const [task] = await db.insert(tasks).values({ orgId: otherOrg!.id, title: "not mine", status: "open" }).returning();
		const res = await post({ devinSessionId: "devin-1", taskId: task!.id }, apiKey);
		expect(res.status).toBe(404);
		expect(await db.select().from(devinSessions)).toHaveLength(0);
	});

	it("spawns a Devin session from a prompt when a token is configured", async () => {
		await db.insert(connectors).values({ orgId, type: "devin", config: { apiToken: "tok-123" } });
		mockCreate.mockResolvedValue({ session_id: "devin-spawned" });

		const res = await post({ prompt: "fix the flaky test" }, apiKey);
		expect(res.status).toBe(201);
		expect(await res.json()).toMatchObject({ devinSessionId: "devin-spawned" });
		expect(mockCreate).toHaveBeenCalledWith("tok-123", "fix the flaky test");

		const [row] = await db.select().from(devinSessions).where(eq(devinSessions.orgId, orgId));
		expect(row?.devinSessionId).toBe("devin-spawned");
	});

	it("400s a spawn with no Devin token", async () => {
		const res = await post({ prompt: "do work" }, apiKey);
		expect(res.status).toBe(400);
		expect(mockCreate).not.toHaveBeenCalled();
	});
});
