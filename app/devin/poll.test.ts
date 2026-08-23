// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The poll loop against the real database, with only Devin's network call stubbed.
 *
 * The parts worth asserting are exactly the ones that only exist once Postgres is
 * in the loop: that an unchanged session writes nothing, that the message cursor
 * only ever advances, that a PR is recorded once, that a terminal or unreachable
 * session drops out of the poll set. The Devin API itself is a `vi.fn`, because
 * what this file tests is Harbor's diffing, not Devin's HTTP.
 */

import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./client.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./client.js")>();
	return { ...actual, getDevinSession: vi.fn() };
});

import { db, sql } from "@core/schema/index.js";
import { activity, artifacts, connectors, devinSessions, orgs, sessions } from "@core/schema/schema.js";
import { DevinApiError, getDevinSession, type DevinSession } from "./client.js";
import { tickDevinPoll } from "./poll.js";

const mockGet = vi.mocked(getDevinSession);

let orgId: string;
let harborSessionId: string;

async function registerDevinSession(devinSessionId: string, overrides: Partial<typeof devinSessions.$inferInsert> = {}) {
	const [row] = await db
		.insert(devinSessions)
		.values({ orgId, devinSessionId, sessionId: harborSessionId, ...overrides })
		.returning();
	return row!;
}

beforeEach(async () => {
	await sql`truncate table activity, artifacts, devin_sessions, session_participants, sessions, agent_presence, events, claims, tasks, connectors, api_keys, users, orgs cascade`;
	mockGet.mockReset();

	const [org] = await db.insert(orgs).values({ name: "Devin Org" }).returning();
	orgId = org!.id;
	const [session] = await db
		.insert(sessions)
		.values({ orgId, key: "devinkey0000000000000001", title: "Devin session", createdBy: "devin" })
		.returning();
	harborSessionId = session!.id;
	// A per-org Devin token so devinTokenFor resolves without an env var.
	await db.insert(connectors).values({ orgId, type: "devin", config: { apiToken: "tok-123" } });
});

afterAll(async () => {
	await sql.end();
});

function devinResponse(over: Partial<DevinSession> = {}): DevinSession {
	return { session_id: "devin-1", status_enum: "working", updated_at: "2026-08-13T10:00:00.000Z", messages: [], ...over };
}

describe("tickDevinPoll", () => {
	it("records a first observation as session_start plus new messages", async () => {
		await registerDevinSession("devin-1");
		mockGet.mockResolvedValue(
			devinResponse({
				messages: [
					{ type: "user_message", message: "go" },
					{ type: "devin_message", message: "on it" },
				],
			}),
		);

		const result = await tickDevinPoll();
		expect(result.polled).toBe(1);

		const rows = await db.select().from(activity).where(eq(activity.orgId, orgId));
		expect(rows.map((r) => r.kind).sort()).toEqual(["prompt", "session_start", "tool_call"].sort());
		// Every row is attributed to the derived devin agent id.
		expect(rows.every((r) => r.agentId === "devin:devin-1")).toBe(true);

		const [row] = await db.select().from(devinSessions).where(eq(devinSessions.devinSessionId, "devin-1"));
		expect(row?.lastMessageCount).toBe(2);
		expect(row?.lastStatus).toBe("working");
	});

	it("short-circuits when updated_at is unchanged: no writes, only lastPolledAt bumps", async () => {
		await registerDevinSession("devin-1", {
			lastUpdatedAt: new Date("2026-08-13T10:00:00.000Z"),
			lastStatus: "working",
			lastMessageCount: 1,
		});
		mockGet.mockResolvedValue(devinResponse({ messages: [{ type: "user_message", message: "go" }] }));

		const result = await tickDevinPoll();
		expect(result).toMatchObject({ polled: 0, skipped: 1, recorded: 0 });
		expect(await db.select().from(activity)).toHaveLength(0);

		const [row] = await db.select().from(devinSessions).where(eq(devinSessions.devinSessionId, "devin-1"));
		expect(row?.lastPolledAt).not.toBeNull();
	});

	it("emits only the new tail of messages on an incremental poll", async () => {
		await registerDevinSession("devin-1", {
			lastUpdatedAt: new Date("2026-08-13T09:00:00.000Z"),
			lastStatus: "working",
			lastMessageCount: 1,
		});
		mockGet.mockResolvedValue(
			devinResponse({
				updated_at: "2026-08-13T10:00:00.000Z",
				messages: [
					{ type: "user_message", message: "go" },
					{ type: "devin_message", message: "step 1" },
					{ type: "devin_message", message: "step 2" },
				],
			}),
		);

		const result = await tickDevinPoll();
		expect(result.recorded).toBe(2);
		const rows = await db.select().from(activity).where(eq(activity.orgId, orgId));
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => r.kind === "tool_call")).toBe(true);
	});

	it("records a pull request as an artifact exactly once", async () => {
		const row = await registerDevinSession("devin-1", {
			lastUpdatedAt: new Date("2026-08-13T09:00:00.000Z"),
			lastStatus: "working",
		});
		mockGet.mockResolvedValue(
			devinResponse({
				updated_at: "2026-08-13T10:00:00.000Z",
				pull_request: { url: "https://github.com/acme/repo/pull/7", title: "Fix flake" },
			}),
		);

		await tickDevinPoll();
		let prs = await db.select().from(artifacts).where(and(eq(artifacts.orgId, orgId), eq(artifacts.kind, "pull_request")));
		expect(prs).toHaveLength(1);
		expect(prs[0]).toMatchObject({
			url: "https://github.com/acme/repo/pull/7",
			sessionId: harborSessionId,
			mergedAt: null,
		});

		// A second poll with a newer updated_at must not double-record the PR.
		mockGet.mockResolvedValue(
			devinResponse({ updated_at: "2026-08-13T11:00:00.000Z", pull_request: { url: "https://github.com/acme/repo/pull/7" } }),
		);
		await tickDevinPoll();
		prs = await db.select().from(artifacts).where(and(eq(artifacts.orgId, orgId), eq(artifacts.kind, "pull_request")));
		expect(prs).toHaveLength(1);

		const updated = await db.query.devinSessions.findFirst({ where: eq(devinSessions.id, row.id) });
		expect(updated?.prArtifactId).not.toBeNull();
	});

	it("drops a finished session out of the poll set", async () => {
		await registerDevinSession("devin-1", { lastUpdatedAt: new Date("2026-08-13T09:00:00.000Z"), lastStatus: "working" });
		mockGet.mockResolvedValue(devinResponse({ updated_at: "2026-08-13T10:00:00.000Z", status_enum: "finished" }));

		const result = await tickDevinPoll();
		expect(result.finished).toBe(1);
		const [row] = await db.select().from(devinSessions).where(eq(devinSessions.devinSessionId, "devin-1"));
		expect(row?.status).toBe("finished");

		// A finished session is not fetched again next tick.
		mockGet.mockClear();
		await tickDevinPoll();
		expect(mockGet).not.toHaveBeenCalled();
	});

	it("expires a session whose Devin fetch permanently fails", async () => {
		await registerDevinSession("devin-1");
		mockGet.mockRejectedValue(new DevinApiError("gone", 404));

		const result = await tickDevinPoll();
		expect(result.finished).toBe(1);
		const [row] = await db.select().from(devinSessions).where(eq(devinSessions.devinSessionId, "devin-1"));
		expect(row?.status).toBe("expired");
	});

	it("skips an org with no token without calling the API", async () => {
		await db.delete(connectors);
		delete process.env.DEVIN_API_TOKEN;
		await registerDevinSession("devin-1");

		const result = await tickDevinPoll();
		expect(result.skipped).toBe(1);
		expect(mockGet).not.toHaveBeenCalled();
		const [row] = await db.select().from(devinSessions).where(eq(devinSessions.devinSessionId, "devin-1"));
		expect(row?.lastPolledAt).not.toBeNull();
	});
});
