// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The paging endpoint the contract promised.
 *
 * `src/contracts` §5 says a truncated snapshot's remainder "is fetched by
 * page". `eventPage` existed and was tested — and had no HTTP route, so a real
 * client had no way to call it: a reconnect after a busy window left a
 * permanent hole the contract claimed was fillable. This suite drives the new
 * route end to end, including the hole-filling walk the contract describes.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as getEventsPage } from "./[key]/events/route.js";
import { db, sql } from "@core/schema/index.js";
import { apiKeys, orgs } from "@core/schema/schema.js";
import { hashApiKey, mintApiKey } from "@core/kernel/keys.js";
import { appendEvent, snapshotSession } from "../../lib/session-events.js";
import { createSession } from "../../lib/sessions.js";

let orgId: string;
let sessionId: string;
let sessionKey: string;
let apiKey: string;

const TRUNCATE = `truncate table
	session_events, cost_events, artifacts, session_repos, sandboxes,
	session_prompts, session_participants, sessions,
	activity, runs, agent_presence, events, claims, tasks, projects,
	circuit_breakers, automation_runs, automations, secrets, user_scm_tokens,
	environment_repos, environments, repos, api_keys, digests, connectors, users, orgs
	cascade`;

interface PageBody {
	events: Array<{ seq: number }>;
	has_more: boolean;
	retained_from_seq: number;
	error?: string;
}

const page = async (query: string, headers: Record<string, string> = {}) => {
	const response = await getEventsPage(
		new Request(`http://harbor.test/api/sessions/${sessionKey}/events${query}`, {
			headers: { authorization: `Bearer ${apiKey}`, ...headers },
		}),
		{ params: Promise.resolve({ key: sessionKey }) },
	);
	return { status: response.status, body: (await response.json()) as PageBody };
};

beforeEach(async () => {
	await sql.unsafe(TRUNCATE);
	const [org] = await db.insert(orgs).values({ name: "Page Org" }).returning();
	orgId = org!.id;
	const session = await createSession({ orgId, title: "Paged", createdBy: "@rin" });
	sessionId = session.id;
	sessionKey = session.key;
	apiKey = mintApiKey();
	await db.insert(apiKeys).values({ orgId, keyHash: hashApiKey(apiKey), label: "page tests" });
});

afterAll(async () => {
	await sql.end({ timeout: 5 });
});

const seed = async (count: number) => {
	for (let n = 0; n < count; n += 1) {
		await appendEvent({ orgId, sessionId, type: "agent_message", payload: { n } });
	}
};

describe("GET /api/sessions/[key]/events", () => {
	it("refuses a bad credential, and refuses another org's key as not-found", async () => {
		// An unknown bearer is judged on its own and never falls back to the
		// browser's ambient session — the same rule the stream route states.
		const unauthenticated = await getEventsPage(
			new Request(`http://harbor.test/api/sessions/${sessionKey}/events`, {
				headers: { authorization: "Bearer hbr_not_a_real_key" },
			}),
			{ params: Promise.resolve({ key: sessionKey }) },
		);
		expect(unauthenticated.status).toBe(401);

		const [otherOrg] = await db.insert(orgs).values({ name: "Other" }).returning();
		const otherKey = mintApiKey();
		await db
			.insert(apiKeys)
			.values({ orgId: otherOrg!.id, keyHash: hashApiKey(otherKey), label: "other" });
		const crossTenant = await getEventsPage(
			new Request(`http://harbor.test/api/sessions/${sessionKey}/events`, {
				headers: { authorization: `Bearer ${otherKey}` },
			}),
			{ params: Promise.resolve({ key: sessionKey }) },
		);
		// Indistinguishable from a key never minted: the oracle argument.
		expect(crossTenant.status).toBe(404);
	});

	it("?after= walks forwards, exclusive, ascending", async () => {
		await seed(10);
		const { status, body } = await page("?after=4&limit=3");
		expect(status).toBe(200);
		expect(body.events.map((event) => event.seq)).toEqual([5, 6, 7]);
		expect(body.has_more).toBe(true);
	});

	it("?before= walks backwards, exclusive, still returned ascending", async () => {
		await seed(10);
		const { body } = await page("?before=5&limit=3");
		// The page below the cursor, in apply order.
		expect(body.events.map((event) => event.seq)).toEqual([2, 3, 4]);
		expect(body.has_more).toBe(true);
	});

	it("has_more is exact at the one-page boundary", async () => {
		await seed(6);
		// Exactly the remaining history: no more.
		const exact = await page("?after=3&limit=3");
		expect(exact.body.events.map((event) => event.seq)).toEqual([4, 5, 6]);
		expect(exact.body.has_more).toBe(false);
		// One short: more.
		const short = await page("?after=3&limit=2");
		expect(short.body.has_more).toBe(true);
	});

	it("refuses both cursors at once with a 400 that says so", async () => {
		await seed(3);
		const { status, body } = await page("?before=3&after=1");
		expect(status).toBe(400);
		expect(body.error).toMatch(/either .before. or .after/);
	});

	it("refuses a malformed cursor with 400 — this is an explicit fetch, not a reconnect", async () => {
		const { status } = await page("?after=banana");
		expect(status).toBe(400);
	});

	it("clamps limit to maxSnapshotEvents rather than serving an unbounded page", async () => {
		process.env.HARBOR_MAX_SNAPSHOT_EVENTS = "5";
		try {
			await seed(12);
			const { body } = await page("?after=0&limit=9999");
			expect(body.events).toHaveLength(5);
		} finally {
			delete process.env.HARBOR_MAX_SNAPSHOT_EVENTS;
		}
	});

	it("fills a truncated snapshot's hole: snapshot tail + backward pages = every retained event", async () => {
		process.env.HARBOR_MAX_SNAPSHOT_EVENTS = "5";
		try {
			await seed(17);
			const snapshot = await snapshotSession(orgId, sessionKey);
			expect(snapshot!.truncated).toBe(true);

			const collected = new Set(snapshot!.events.map((event) => event.seq));
			let cursor = Math.min(...collected);
			// The walk the contract describes: page backwards from the snapshot's
			// first event until the retention boundary.
			for (let hops = 0; hops < 10; hops += 1) {
				const { body } = await page(`?before=${cursor}&limit=5`);
				for (const event of body.events) collected.add(event.seq);
				if (!body.has_more || body.events.length === 0) break;
				cursor = Math.min(...body.events.map((event) => event.seq));
			}

			// Union: every retained event exactly once.
			const [row] = await sql`select count(*)::int as total from session_events where session_id = ${sessionId}`;
			expect(collected.size).toBe(Number(row!.total));
		} finally {
			delete process.env.HARBOR_MAX_SNAPSHOT_EVENTS;
		}
	});
});
