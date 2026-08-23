// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Session tests, aimed at the three decisions that are corrections rather than
 * conveniences: no owner, mandatory attribution, and a queue that survives two
 * people typing at once.
 *
 * Against real Postgres, because two of the three are concurrency properties and
 * a mock would pass a read-then-write allocation that collides in production.
 */

import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, sql } from "@core/schema/index.js";
import {
	orgs,
	sessionParticipants,
	sessionPrompts,
	sessions,
	tasks,
} from "@core/schema/schema.js";
import {
	createSession,
	dequeuePrompt,
	joinSession,
	listSessions,
	mintSessionKey,
	participantsOf,
	promptsOf,
	queuePrompt,
	sessionByKey,
} from "./sessions.js";

let orgId: string;
let sessionId: string;
let sessionKey: string;

beforeEach(async () => {
	await sql`truncate table session_prompts, session_participants, sessions, runs, agent_presence, events, claims, tasks, projects, api_keys, digests, connectors, users, orgs cascade`;
	const [org] = await db.insert(orgs).values({ name: "Session Org" }).returning();
	orgId = org!.id;
	const session = await createSession({
		orgId,
		title: "Fix the webhook retry bug",
		createdBy: "@rin",
	});
	sessionId = session.id;
	sessionKey = session.key;
});

afterAll(async () => {
	await sql.end();
});

describe("no single owner", () => {
	it("has no owner column at all — createdBy is provenance only", async () => {
		const columns = await sql`
			select column_name from information_schema.columns where table_name = 'sessions'
		`;
		const names = columns.map((row) => row.column_name as string);
		expect(names).toContain("created_by");
		// If an owner column ever appears, the "send it to a colleague" property is
		// already gone and this test is the cheapest place to find out.
		expect(names).not.toContain("owner_id");
		expect(names).not.toContain("owner");
	});

	it("lets anyone with the link join and steer, not just the creator", async () => {
		await joinSession(sessionId, orgId, "@maya");
		await joinSession(sessionId, orgId, "claude-code:wt-1", "agent");

		await queuePrompt({ orgId, sessionId, author: "@maya", body: "Also check the retry cap." });

		const people = await participantsOf(sessionId);
		expect(people.map((p) => p.participant).sort()).toEqual(
			["@maya", "@rin", "claude-code:wt-1"].sort(),
		);
		// The creator holds no special position: a later joiner's prompt is a
		// first-class instruction, not a suggestion.
		const queued = await promptsOf(sessionId);
		expect(queued.at(-1)!.author).toBe("@maya");
	});

	it("makes the creator an ordinary participant", async () => {
		const people = await participantsOf(sessionId);
		expect(people).toHaveLength(1);
		expect(people[0]!.participant).toBe("@rin");
		expect(Object.keys(people[0]!)).not.toContain("role");
	});
});

describe("link sharing", () => {
	it("resolves a session by its shareable key", async () => {
		const found = await sessionByKey(orgId, sessionKey);
		expect(found?.id).toBe(sessionId);
	});

	it("refuses a key from another org", async () => {
		const [other] = await db.insert(orgs).values({ name: "Other" }).returning();
		expect(await sessionByKey(other!.id, sessionKey)).toBeUndefined();
	});

	it("mints keys that are unguessable and safe to read aloud", () => {
		const keys = new Set(Array.from({ length: 2000 }, () => mintSessionKey()));
		expect(keys.size).toBe(2000);
		for (const key of keys) {
			expect(key).toMatch(/^[0-9a-hjkmnp-tv-z]{22}$/);
			// i/l/o/u are excluded so a key survives being typed from a screenshot.
			expect(key).not.toMatch(/[ilou]/);
		}
	});

	it("is idempotent when the same person opens the link twice", async () => {
		await joinSession(sessionId, orgId, "@maya");
		await joinSession(sessionId, orgId, "@maya");
		expect(await participantsOf(sessionId)).toHaveLength(2);
	});
});

describe("attribution", () => {
	it("records an author on every prompt", async () => {
		await queuePrompt({ orgId, sessionId, author: "@rin", body: "Start with the tests." });
		await queuePrompt({ orgId, sessionId, author: "@maya", body: "And check the cap." });
		const all = await promptsOf(sessionId);
		expect(all.map((p) => p.author)).toEqual(["@rin", "@maya"]);
	});

	it("cannot store an unattributed prompt even via raw SQL", async () => {
		// The NOT NULL is the guarantee; application code is the convenience.
		await expect(
			sql`insert into session_prompts (org_id, session_id, body, seq) values (${orgId}, ${sessionId}, 'ghost', 99)`,
		).rejects.toThrow();
	});

	it("distinguishes a human author from an agent author", async () => {
		await queuePrompt({ orgId, sessionId, author: "@rin", body: "Do the thing." });
		await queuePrompt({
			orgId,
			sessionId,
			author: "claude-code:wt-1",
			authorKind: "agent",
			body: "Found a related bug; filing it.",
		});
		const all = await promptsOf(sessionId);
		expect(all.map((p) => p.authorKind)).toEqual(["human", "agent"]);
	});

	it("rejects empty and oversized prompts", async () => {
		await expect(queuePrompt({ orgId, sessionId, author: "@rin", body: "   " })).rejects.toThrow(
			/cannot be empty/,
		);
		await expect(
			queuePrompt({ orgId, sessionId, author: "@rin", body: "x".repeat(8001) }),
		).rejects.toThrow(/too long/);
	});
});

describe("the queue", () => {
	it("preserves order rather than interleaving", async () => {
		await queuePrompt({ orgId, sessionId, author: "@rin", body: "first" });
		await queuePrompt({ orgId, sessionId, author: "@maya", body: "second" });
		await queuePrompt({ orgId, sessionId, author: "@rin", body: "third" });
		expect((await promptsOf(sessionId)).map((p) => p.body)).toEqual([
			"first",
			"second",
			"third",
		]);
	});

	it("loses no prompt when many clients submit at once", async () => {
		// The whole reason the sequence is allocated in SQL. A read-max-then-insert
		// allocation hands two concurrent callers the same number; the unique index
		// then rejects the loser and somebody's message vanishes.
		//
		// Note what this asserts and why. An earlier version of this test caught
		// the rejections and then checked that the STORED rows had unique seqs —
		// which is true by construction, since the colliding insert is exactly the
		// one that failed. It passed against a deliberately broken implementation.
		// The property that actually matters is that nothing is dropped.
		const submissions = 12;
		const results = await Promise.allSettled(
			Array.from({ length: submissions }, (_, i) =>
				queuePrompt({ orgId, sessionId, author: `@user-${i}`, body: `message ${i}` }),
			),
		);

		const rejected = results.filter((r) => r.status === "rejected");
		expect(rejected, `${rejected.length} prompts were dropped`).toHaveLength(0);

		const stored = await promptsOf(sessionId);
		expect(stored).toHaveLength(submissions);
		const seqs = stored.map((p) => p.seq);
		expect(new Set(seqs).size, "duplicate seq allocated").toBe(submissions);
		// Every author is still represented — nobody's message was silently lost.
		expect(new Set(stored.map((p) => p.author)).size).toBe(submissions);
	});

	it("hands each queued prompt to exactly one consumer", async () => {
		for (let i = 0; i < 6; i += 1) {
			await queuePrompt({ orgId, sessionId, author: "@rin", body: `task ${i}` });
		}

		// Two agents attached to one session is a supported state, so two
		// concurrent dequeues must not both take the same row.
		const taken = await Promise.all(
			Array.from({ length: 6 }, () => dequeuePrompt(orgId, sessionId)),
		);
		const ids = taken.filter(Boolean).map((p) => p!.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toHaveLength(6);
	});

	it("returns prompts in order and marks them delivered", async () => {
		await queuePrompt({ orgId, sessionId, author: "@rin", body: "first" });
		await queuePrompt({ orgId, sessionId, author: "@rin", body: "second" });

		expect((await dequeuePrompt(orgId, sessionId))!.body).toBe("first");
		expect((await dequeuePrompt(orgId, sessionId))!.body).toBe("second");
		expect(await dequeuePrompt(orgId, sessionId)).toBeNull();

		const delivered = await db
			.select()
			.from(sessionPrompts)
			.where(and(eq(sessionPrompts.sessionId, sessionId), eq(sessionPrompts.status, "delivered")));
		expect(delivered).toHaveLength(2);
		expect(delivered.every((p) => p.deliveredAt !== null)).toBe(true);
	});

	it("keeps a second thought queued while the first is being worked on", async () => {
		await queuePrompt({ orgId, sessionId, author: "@rin", body: "do the thing" });
		await dequeuePrompt(orgId, sessionId);

		// Somebody adds a follow-up mid-run. It must wait its turn, not splice
		// itself into work already in flight.
		await queuePrompt({ orgId, sessionId, author: "@maya", body: "actually, also this" });
		const queued = await db
			.select()
			.from(sessionPrompts)
			.where(and(eq(sessionPrompts.sessionId, sessionId), eq(sessionPrompts.status, "queued")));
		expect(queued).toHaveLength(1);
		expect(queued[0]!.author).toBe("@maya");
	});

	it("scopes the queue to its own session", async () => {
		const other = await createSession({ orgId, title: "Other work", createdBy: "@bo" });
		await queuePrompt({ orgId, sessionId, author: "@rin", body: "mine" });
		await queuePrompt({ orgId, sessionId: other.id, author: "@bo", body: "theirs" });

		expect((await dequeuePrompt(orgId, other.id))!.body).toBe("theirs");
		expect((await promptsOf(sessionId)).map((p) => p.body)).toEqual(["mine"]);
	});
});

describe("listing", () => {
	it("orders by last activity, and a prompt counts as activity", async () => {
		const second = await createSession({ orgId, title: "Newer", createdBy: "@bo" });
		await queuePrompt({ orgId, sessionId, author: "@rin", body: "bumping the first" });

		const listed = await listSessions(orgId);
		expect(listed[0]!.id).toBe(sessionId);
		expect(listed.map((s) => s.id)).toContain(second.id);
	});

	it("never lists another org's sessions", async () => {
		const [other] = await db.insert(orgs).values({ name: "Other" }).returning();
		await createSession({ orgId: other!.id, title: "Secret", createdBy: "@x" });
		expect((await listSessions(orgId)).map((s) => s.title)).not.toContain("Secret");
	});

	it("links a session to a task when one is given", async () => {
		const [task] = await db
			.insert(tasks)
			.values({ orgId, title: "Fix retries", status: "open" })
			.returning();
		const linked = await createSession({
			orgId,
			title: "Working on retries",
			createdBy: "@rin",
			taskId: task!.id,
		});
		const listed = await listSessions(orgId);
		expect(listed.find((s) => s.id === linked.id)!.taskTitle).toBe("Fix retries");
	});
});
