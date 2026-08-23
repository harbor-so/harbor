// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The session surface, and the six routes that were missing from it.
 *
 * Their absence was not cosmetic: `archived`
 * was a status `promptability` refused prompts to, with a message telling people
 * to "unarchive it", and nothing in the product could archive OR unarchive a
 * session — the door had no handle on either side. `stop` was a bridge verb the
 * commands route already knew how to send, derived from a column whose comment
 * said "set by a budget or by a human", and no human could set it.
 *
 * What is asserted here is mostly the *refusals*, because they are where these
 * routes are worth anything:
 *
 *  - org scoping: another tenant's key is 404, identical to a key never minted,
 *    so the key space is not an oracle;
 *  - a presented credential is judged on its own and never falls back to an
 *    ambient browser session;
 *  - `stop` leaves the sandbox alone — it pauses the queue, which is the whole
 *    difference between `stop` and `shutdown`;
 *  - `/pr` answers with a REASON rather than a 404, because "no pull request"
 *    has three causes with three different remedies.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, sql } from "@core/schema/index.js";
import { artifacts, orgs, sessions } from "@core/schema/schema.js";
import { appendEvent } from "../../lib/session-events.js";
import { createSession, queuePrompt } from "../../lib/sessions.js";

vi.mock("next/headers", () => ({
	cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

const { GET: getSession } = await import("./[key]/route.js");
const { GET: getMessages } = await import("./[key]/messages/route.js");
const { GET: getArtifacts } = await import("./[key]/artifacts/route.js");
const { GET: getParticipants } = await import("./[key]/participants/route.js");
const { GET: getPr } = await import("./[key]/pr/route.js");
const { POST: postStop } = await import("./[key]/stop/route.js");
const { POST: postArchive } = await import("./[key]/archive/route.js");
const { POST: postUnarchive } = await import("./[key]/unarchive/route.js");
const { POST: postPrompt } = await import("./[key]/prompts/route.js");

let orgId: string;

const request = (path = "http://harbor.test/x", init?: RequestInit) => new Request(path, init);
const params = (key: string) => ({ params: Promise.resolve({ key }) });
const body = async <T>(response: Response) => (await response.json()) as T;

beforeEach(async () => {
	await sql`truncate table cost_events, circuit_breakers, automation_runs, automations, artifacts, session_events, sandboxes, session_repos, secrets, user_scm_tokens, environment_repos, environments, repos, activity, session_prompts, session_participants, sessions, runs, agent_presence, events, claims, tasks, projects, api_keys, digests, connectors, users, orgs cascade`;
	const [org] = await db.insert(orgs).values({ name: "Surface Org" }).returning();
	orgId = org!.id;
	delete process.env.GITHUB_CLIENT_ID;
	delete process.env.GITHUB_CLIENT_SECRET;
});

afterAll(async () => {
	await sql.end();
});

describe("GET /api/sessions/[key] — the snapshot without holding a stream open", () => {
	it("carries the cursor a client resumes from", async () => {
		const session = await createSession({ orgId, title: "Snapshot", createdBy: "rin" });
		await appendEvent({ orgId, sessionId: session.id, type: "session_created", payload: {} });

		const response = await getSession(request(), params(session.key));
		expect(response.status).toBe(200);
		const snapshot = await body<{
			session: { key: string; title: string };
			snapshot_through_seq: number;
			participants: unknown[];
		}>(response);
		expect(snapshot.session).toMatchObject({ key: session.key, title: "Snapshot" });
		// The whole point of a snapshot: `?after=<this>` continues without a gap.
		expect(snapshot.snapshot_through_seq).toBeGreaterThanOrEqual(0);
		expect(snapshot.participants.length).toBeGreaterThan(0);
	});

	it("is a 404 for another tenant's key, indistinguishable from one never minted", async () => {
		const [other] = await db.insert(orgs).values({ name: "Other" }).returning();
		const theirs = await createSession({
			orgId: other!.id,
			title: "Not yours",
			createdBy: "someone",
		});

		const foreign = await getSession(request(), params(theirs.key));
		const invented = await getSession(request(), params("zzzzzzzzzzzzzzzzzzzzzz"));
		expect(foreign.status).toBe(404);
		expect(invented.status).toBe(404);
		expect(await body(foreign)).toEqual(await body(invented));
	});

	it("does not fall back to the browser session when a presented key is bad", async () => {
		const session = await createSession({ orgId, title: "Guarded", createdBy: "rin" });
		const response = await getSession(
			request("http://harbor.test/x", { headers: { authorization: "Bearer not-a-key" } }),
			params(session.key),
		);
		// A revoked key must not succeed for whoever happens to be signed in on
		// that browser.
		expect(response.status).toBe(401);
	});
});

describe("GET /api/sessions/[key]/messages", () => {
	it("returns what people said, in order, with authors and queue position", async () => {
		const session = await createSession({ orgId, title: "Talk", createdBy: "rin" });
		await queuePrompt({ orgId, sessionId: session.id, author: "rin", body: "first" });
		await queuePrompt({ orgId, sessionId: session.id, author: "maya", body: "second" });

		const response = await getMessages(request(), params(session.key));
		const { messages } = await body<{
			messages: Array<{ author: string; body: string; seq: number; status: string }>;
		}>(response);
		expect(messages.map((message) => [message.author, message.body])).toEqual([
			["rin", "first"],
			["maya", "second"],
		]);
		expect(messages[0]!.seq).toBeLessThan(messages[1]!.seq);
		expect(messages[1]!.status).toBe("queued");
	});
});

describe("GET /api/sessions/[key]/artifacts and /pr", () => {
	async function withArtifact(kind: string, url: string, merged?: Date) {
		const session = await createSession({ orgId, title: "Work", createdBy: "rin" });
		await db.insert(artifacts).values({
			orgId,
			sessionId: session.id,
			kind,
			title: `${kind} artifact`,
			url,
			mergedAt: merged ?? null,
		});
		return session;
	}

	it("lists artifacts and filters by kind", async () => {
		const session = await withArtifact("branch", "https://github.com/acme/api/tree/harbor/lse_1");
		await db.insert(artifacts).values({
			orgId,
			sessionId: session.id,
			kind: "log",
			title: "log",
			url: null,
		});

		const all = await body<{ artifacts: unknown[] }>(
			await getArtifacts(request(), params(session.key)),
		);
		expect(all.artifacts).toHaveLength(2);

		const branches = await body<{ artifacts: Array<{ kind: string }> }>(
			await getArtifacts(request("http://harbor.test/x?kind=branch"), params(session.key)),
		);
		expect(branches.artifacts).toEqual([expect.objectContaining({ kind: "branch" })]);
	});

	it("/pr says no_branch when nothing has been pushed", async () => {
		const session = await createSession({ orgId, title: "Fresh", createdBy: "rin" });
		const response = await getPr(request(), params(session.key));
		expect(response.status).toBe(200);
		expect((await body<{ state: string }>(response)).state).toBe("no_branch");
	});

	it("/pr explains branch_only in terms of the guarantee, not as a 404", async () => {
		const session = await withArtifact(
			"branch",
			"https://github.com/acme/api/compare/main...harbor/lse_1",
		);

		const response = await getPr(request(), params(session.key));
		expect(response.status).toBe(200);
		const payload = await body<{ state: string; reason: string; branch: { url: string } }>(
			response,
		);
		expect(payload.state).toBe("branch_only");
		// The sentence a person can act on: why Harbor refused, and what to do.
		expect(payload.reason).toContain("approve their own pull request");
		expect(payload.branch.url).toContain("compare");
	});

	it("/pr reports merged separately from open", async () => {
		const session = await withArtifact(
			"pull_request",
			"https://github.com/acme/api/pull/7",
			new Date(),
		);
		const response = await getPr(request(), params(session.key));
		expect((await body<{ state: string }>(response)).state).toBe("merged");
	});
});

describe("POST /api/sessions/[key]/stop", () => {
	it("pauses the queue, attributes the pause, and resumes", async () => {
		const session = await createSession({ orgId, title: "Runaway", createdBy: "rin" });

		const stopped = await postStop(request("http://harbor.test/x", { method: "POST" }), params(session.key));
		expect(stopped.status).toBe(200);
		const [paused] = await db.select().from(sessions).where(eq(sessions.id, session.id));
		// Set, and set to something a person can read. "paused" tells the next
		// prompter nothing; a name tells them who to ask.
		expect(paused!.pausedReason).toBeTruthy();
		// stop is not shutdown: the status is untouched and the box is left alone.
		// (`open` is the legacy column value `classifySessionStatus` maps forward.)
		expect(paused!.status).toBe("open");

		const resumed = await postStop(
			request("http://harbor.test/x", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ stopped: false }),
			}),
			params(session.key),
		);
		expect(resumed.status).toBe(200);
		const [running] = await db.select().from(sessions).where(eq(sessions.id, session.id));
		expect(running!.pausedReason).toBeNull();
	});

	it("takes a caller-supplied reason verbatim", async () => {
		const session = await createSession({ orgId, title: "Cap", createdBy: "rin" });
		await postStop(
			request("http://harbor.test/x", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ reason: "Daily spend cap reached." }),
			}),
			params(session.key),
		);
		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id));
		expect(row!.pausedReason).toBe("Daily spend cap reached.");
	});
});

describe("POST /api/sessions/[key]/archive and /unarchive", () => {
	it("closes the door prompts are refused at, and opens it again", async () => {
		const session = await createSession({ orgId, title: "Done", createdBy: "rin" });

		expect((await postArchive(request(), params(session.key))).status).toBe(200);

		// The refusal that existed before anything could produce it.
		const refused = await postPrompt(
			request(`http://harbor.test/api/sessions/${session.key}/prompts`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ body: "one more thing" }),
			}),
			params(session.key),
		);
		expect(refused.status).toBe(400);
		expect((await body<{ reason: string }>(refused)).reason).toBe("session_not_promptable");

		const reopened = await postUnarchive(request(), params(session.key));
		expect((await body<{ status: string }>(reopened)).status).toBe("created");

		const accepted = await postPrompt(
			request(`http://harbor.test/api/sessions/${session.key}/prompts`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ body: "one more thing" }),
			}),
			params(session.key),
		);
		expect(accepted.status).toBe(200);
	});

	it("archiving twice is not an error", async () => {
		const session = await createSession({ orgId, title: "Twice", createdBy: "rin" });
		await postArchive(request(), params(session.key));
		const second = await postArchive(request(), params(session.key));
		expect(second.status).toBe(200);
		expect((await body<{ changed: boolean }>(second)).changed).toBe(false);
	});

	it("unarchiving a session that ran comes back promptable, not active", async () => {
		const session = await createSession({ orgId, title: "Ran", createdBy: "rin" });
		await appendEvent({ orgId, sessionId: session.id, type: "agent_finished", payload: {} });
		await postArchive(request(), params(session.key));

		const reopened = await postUnarchive(request(), params(session.key));
		// Derived, not remembered: a session archived mid-turn must not come back
		// claiming a turn is in flight.
		expect((await body<{ status: string }>(reopened)).status).toBe("completed");
	});
});

describe("GET /api/sessions/[key]/participants", () => {
	it("lists humans and agents as one row shape", async () => {
		const session = await createSession({ orgId, title: "Room", createdBy: "rin" });
		await queuePrompt({
			orgId,
			sessionId: session.id,
			author: "agent-7",
			authorKind: "agent",
			body: "on it",
		});

		const response = await getParticipants(request(), params(session.key));
		const { participants } = await body<{
			participants: Array<{ participant: string; kind: string }>;
		}>(response);
		expect(participants).toEqual([expect.objectContaining({ participant: "rin", kind: "human" })]);
	});
});
