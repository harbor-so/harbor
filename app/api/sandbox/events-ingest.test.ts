// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The bridge's gap marker survives the control plane.
 *
 * The bridge caps its disconnect buffer and, at the cap, drops the oldest
 * events and builds a VISIBLE marker saying how many and when — the whole
 * design being that the hole is in the record rather than hidden from it. The
 * marker rides on a `log` event because `SandboxEventType` has no gap member.
 * The ingest route mapped `log → null`, so the marker was built, tested, sent
 * across the wire — and thrown away at the receiving end. The transcript
 * showed an unbroken timeline across a window where events were destroyed,
 * which is precisely the lie the marker exists to prevent.
 *
 * These tests drive the real route: the marker becomes a `transcript_gap`
 * timeline event; plain logs stay off the timeline; heartbeats stay off the
 * timeline but still prove liveness; and the marker survives compaction,
 * because a gap folded into a summary is the silent hole all over again.
 */

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as postSandboxEvents } from "./[id]/events/route.js";
import { db, sql } from "@core/schema/index.js";
import { orgs, sandboxes, sessionEvents } from "@core/schema/schema.js";
import { compactSession, snapshotSession } from "../../lib/session-events.js";
import { createSession } from "../../lib/sessions.js";

let orgId: string;
let sessionId: string;
let sessionKey: string;

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

const post = (box: { id: string }, events: unknown[]) =>
	postSandboxEvents(
		new Request(`http://harbor.test/api/sandbox/${box.id}/events`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer tok-gap",
				"x-harbor-fencing-token": "1",
			},
			body: JSON.stringify({ events }),
		}),
		{ params: Promise.resolve({ id: box.id }) },
	);

const gapMarker = (box: { id: string }, dropped = 16) => ({
	type: "log",
	sandbox_id: box.id,
	session_id: sessionId,
	at: "2026-08-12T10:00:05.000Z",
	payload: {
		level: "warning",
		code: "bridge.buffer_overflow",
		dropped_events: dropped,
		first_dropped_at: "2026-08-12T10:00:00.000Z",
		last_dropped_at: "2026-08-12T10:00:05.000Z",
		message: `${dropped} event(s) were dropped while this sandbox could not reach Harbor.`,
	},
});

const gapEvents = () =>
	db
		.select()
		.from(sessionEvents)
		.where(and(eq(sessionEvents.sessionId, sessionId), eq(sessionEvents.type, "transcript_gap")));

beforeEach(async () => {
	await sql`truncate table cost_events, circuit_breakers, automation_runs, automations, artifacts, session_events, sandboxes, session_repos, secrets, user_scm_tokens, environment_repos, environments, repos, activity, session_prompts, session_participants, sessions, runs, agent_presence, events, claims, tasks, projects, api_keys, digests, connectors, users, orgs cascade`;
	const [org] = await db.insert(orgs).values({ name: "Gap Org" }).returning();
	orgId = org!.id;
	const session = await createSession({ orgId, title: "Gapped", createdBy: "rin" });
	sessionId = session.id;
	sessionKey = session.key;
});

afterAll(async () => {
	await sql.end();
});

describe("bridge gap markers become transcript_gap timeline events", () => {
	it("persists the marker with the known fields, harbor-actored, counted as appended", async () => {
		const box = await makeSandbox("tok-gap");
		const response = await post(box, [gapMarker(box, 16)]);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { appended: number; ignored: number };
		expect(body.appended).toBe(1);
		expect(body.ignored).toBe(0);

		const [gap] = await gapEvents();
		expect(gap).toBeDefined();
		// `harbor`, not `agent`: the marker is the platform's own statement about
		// its record, and a reader trusts the actor.
		expect(gap!.actor).toBe("harbor");
		const payload = gap!.payload as Record<string, unknown>;
		expect(payload.dropped_events).toBe(16);
		expect(payload.first_dropped_at).toBe("2026-08-12T10:00:00.000Z");
		expect(payload.message).toContain("dropped");
	});

	it("copies only the known fields — a compromised bridge cannot plant keys on a harbor event", async () => {
		const box = await makeSandbox("tok-gap");
		const poisoned = gapMarker(box, 3);
		(poisoned.payload as Record<string, unknown>).injected_admin_flag = true;
		(poisoned.payload as Record<string, unknown>).dropped_events = { evil: "object" };
		await post(box, [poisoned]);

		const [gap] = await gapEvents();
		const payload = gap!.payload as Record<string, unknown>;
		expect(payload).not.toHaveProperty("injected_admin_flag");
		// A non-scalar in a scalar field is nulled, not passed through.
		expect(payload.dropped_events).toBeNull();
	});

	it("plain log lines are still ignored — the timeline is not a log pipeline", async () => {
		const box = await makeSandbox("tok-gap");
		const response = await post(box, [
			{
				type: "log",
				sandbox_id: box.id,
				session_id: sessionId,
				payload: { level: "info", code: "hook.setup", message: "npm ci output..." },
			},
		]);
		const body = (await response.json()) as { appended: number; ignored: number };
		expect(body.appended).toBe(0);
		expect(body.ignored).toBe(1);
		expect(await gapEvents()).toHaveLength(0);
	});

	it("heartbeats stay off the timeline but still advance liveness", async () => {
		const box = await makeSandbox("tok-gap");
		const before = (await db.select().from(sandboxes).where(eq(sandboxes.id, box.id)))[0]!
			.lastHeartbeatAt;
		const response = await post(box, [
			{ type: "heartbeat", sandbox_id: box.id, session_id: sessionId, payload: { buffered: 0 } },
		]);
		const body = (await response.json()) as { appended: number; ignored: number };
		expect(body.appended).toBe(0);
		expect(body.ignored).toBe(1);

		const [after] = await db.select().from(sandboxes).where(eq(sandboxes.id, box.id));
		expect(after!.lastHeartbeatAt).not.toBeNull();
		expect(after!.lastHeartbeatAt?.getTime() ?? 0).toBeGreaterThan(before?.getTime() ?? 0);
	});

	it("the marker survives compaction — a gap folded into a summary is the silent hole again", async () => {
		process.env.HARBOR_EVENT_RETENTION_COUNT = "10";
		process.env.HARBOR_MAX_SNAPSHOT_EVENTS = "10";
		try {
			const box = await makeSandbox("tok-gap");
			// Foldable chatter around the marker, then a turn boundary.
			const chatter = (n: number, text: string) =>
				Array.from({ length: n }, (_, i) => ({
					type: "agent_message",
					sandbox_id: box.id,
					session_id: sessionId,
					payload: { text: `${text} ${i}` },
				}));
			// Batches of 8: one ingest batch may carry at most maxSnapshotEvents
			// events, and this test pins that setting to 10.
			await post(box, chatter(8, "before-a"));
			await post(box, chatter(8, "before-b"));
			await post(box, [gapMarker(box, 42)]);
			await post(box, chatter(8, "after-a"));
			await post(box, chatter(8, "after-b"));
			await post(box, [
				{ type: "agent_finished", sandbox_id: box.id, session_id: sessionId, payload: {} },
			]);

			const result = await compactSession(orgId, sessionId);
			expect(result.compacted).toBeGreaterThan(0);

			const gaps = await gapEvents();
			expect(gaps).toHaveLength(1);
			expect((gaps[0]!.payload as { dropped_events: number }).dropped_events).toBe(42);
		} finally {
			delete process.env.HARBOR_EVENT_RETENTION_COUNT;
			delete process.env.HARBOR_MAX_SNAPSHOT_EVENTS;
		}
	});

	it("the marker appears in the snapshot a reconnecting client receives", async () => {
		const box = await makeSandbox("tok-gap");
		await post(box, [gapMarker(box, 7)]);

		const snapshot = await snapshotSession(orgId, sessionKey);
		const gap = snapshot!.events.find((event) => event.type === "transcript_gap");
		expect(gap).toBeDefined();
		expect((gap!.payload as { dropped_events: number }).dropped_events).toBe(7);
	});

	it("an oversized marker message is truncated by the payload budget, not refused", async () => {
		process.env.HARBOR_MAX_EVENT_PAYLOAD_CHARS = "300";
		try {
			const box = await makeSandbox("tok-gap");
			const marker = gapMarker(box, 5);
			(marker.payload as Record<string, unknown>).message = "x".repeat(10_000);
			const response = await post(box, [marker]);
			expect(response.status).toBe(200);

			const [gap] = await gapEvents();
			expect(JSON.stringify(gap!.payload).length).toBeLessThanOrEqual(300);
			// The countable fact survives the truncation; the prose is what pays.
			expect((gap!.payload as { dropped_events: number }).dropped_events).toBe(5);
		} finally {
			delete process.env.HARBOR_MAX_EVENT_PAYLOAD_CHARS;
		}
	});
});
