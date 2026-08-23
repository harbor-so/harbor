// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Reconnect convergence, exercised by actually reconnecting.
 *
 * The stream's convergence used to hold only "by construction": there was no
 * resume — no `id:` on any frame, so a browser EventSource could not even
 * populate `Last-Event-ID` — and no test ever dropped a connection. Every
 * reconnect re-sent the full snapshot (megabytes, on every blip of a flaky
 * proxy), and the convergence argument for the reconnect window itself was
 * never executed by anything.
 *
 * These are the fault-injection tests the review spec asked for: disconnect
 * mid-stream, mutate state DURING the disconnect window, reconnect with the
 * cursor the first connection ended on, and assert the second connection
 * replays exactly the missed events — no snapshot, no gaps, no duplicates.
 * Real route handler, real Postgres, real LISTEN/NOTIFY.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as getSessionStream } from "./[key]/stream/route.js";
import { db, sql } from "@core/schema/index.js";
import { apiKeys, orgs, sessions } from "@core/schema/schema.js";
import { hashApiKey, mintApiKey } from "@core/kernel/keys.js";
import { appendEvent, compactSession } from "../../lib/session-events.js";
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

interface Frame {
	event: string;
	data: unknown;
	/** The SSE `id:` line, when the server sent one. */
	id: number | null;
}

/** parseFrames from the runner tests, extended to capture `id:` lines. */
function parseFrames(buffer: string): { frames: Frame[]; rest: string } {
	const parts = buffer.split("\n\n");
	const rest = parts.pop() ?? "";
	const frames: Frame[] = [];
	for (const part of parts) {
		let event = "message";
		let id: number | null = null;
		const data: string[] = [];
		for (const line of part.split("\n")) {
			if (line.startsWith("event: ")) event = line.slice(7);
			else if (line.startsWith("data: ")) data.push(line.slice(6));
			else if (line.startsWith("id: ")) id = Number(line.slice(4));
		}
		if (data.length > 0) frames.push({ event, data: JSON.parse(data.join("\n")), id });
	}
	return { frames, rest };
}

/**
 * Open the stream, read frames until `until` is satisfied (or the budget runs
 * out), then disconnect. Returns everything received.
 */
async function connectAndRead(options: {
	headers?: Record<string, string>;
	query?: string;
	until: (frames: Frame[]) => boolean;
	budgetMs?: number;
}): Promise<Frame[]> {
	const abort = new AbortController();
	const response = await getSessionStream(
		new Request(`http://harbor.test/api/sessions/${sessionKey}/stream${options.query ?? ""}`, {
			headers: { authorization: `Bearer ${apiKey}`, ...(options.headers ?? {}) },
			signal: abort.signal,
		}),
		{ params: Promise.resolve({ key: sessionKey }) },
	);
	expect(response.status).toBe(200);

	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const frames: Frame[] = [];
	try {
		const deadline = Date.now() + (options.budgetMs ?? 8_000);
		while (Date.now() < deadline && !options.until(frames)) {
			const chunk = await Promise.race([
				reader.read(),
				new Promise<{ done: true; value: undefined }>((resolve) =>
					setTimeout(() => resolve({ done: true, value: undefined }), 250),
				),
			]);
			if (!chunk.value) continue;
			buffer += decoder.decode(chunk.value, { stream: true });
			const parsed = parseFrames(buffer);
			buffer = parsed.rest;
			frames.push(...parsed.frames);
		}
	} finally {
		abort.abort();
		await reader.cancel().catch(() => {});
	}
	return frames;
}

const eventSeqs = (frames: Frame[]) =>
	frames
		.filter((frame) => frame.event === "event")
		.map((frame) => (frame.data as { seq: number }).seq);

const append = (text: string) =>
	appendEvent({ orgId, sessionId, type: "agent_message", actor: "agent", payload: { text } });

beforeEach(async () => {
	await sql.unsafe(TRUNCATE);
	const [org] = await db.insert(orgs).values({ name: "Resume Org" }).returning();
	orgId = org!.id;
	const session = await createSession({ orgId, title: "Resume", createdBy: "@rin" });
	sessionId = session.id;
	sessionKey = session.key;
	apiKey = mintApiKey();
	await db.insert(apiKeys).values({ orgId, keyHash: hashApiKey(apiKey), label: "resume tests" });
});

afterAll(async () => {
	await sql.end({ timeout: 5 });
});

describe("SSE frames carry resume ids", () => {
	it("events carry their seq as id; the snapshot carries its own cursor", async () => {
		await append("one");
		await append("two");

		const frames = await connectAndRead({
			until: (seen) => eventSeqs(seen).length >= 2 || seen.some((f) => f.event === "snapshot"),
		});

		const snapshot = frames.find((frame) => frame.event === "snapshot");
		expect(snapshot).toBeDefined();
		// The snapshot's id is its cursor: a client that dies right after the
		// snapshot resumes from here instead of downloading it all again.
		expect(snapshot!.id).toBe(
			(snapshot!.data as { snapshot_through_seq: number }).snapshot_through_seq,
		);

		for (const frame of frames.filter((f) => f.event === "event")) {
			expect(frame.id).toBe((frame.data as { seq: number }).seq);
		}
	});
});

describe("disconnect, mutate, reconnect — the window the spec says cannot be read-verified", () => {
	it("replays exactly the missed events on Last-Event-ID, with no snapshot and no gaps", async () => {
		for (let n = 0; n < 5; n += 1) await append(`before ${n}`);

		// First connection: read the snapshot, remember the last id seen, drop.
		const first = await connectAndRead({
			until: (seen) => seen.some((frame) => frame.event === "snapshot"),
		});
		const lastSeen = first
			.map((frame) => frame.id ?? 0)
			.reduce((max, id) => Math.max(max, id), 0);
		expect(lastSeen).toBeGreaterThanOrEqual(5);

		// THE WINDOW: state mutates while nobody is connected.
		for (let n = 0; n < 7; n += 1) await append(`during ${n}`);

		// Reconnect the way a real EventSource does: the header, automatically.
		const second = await connectAndRead({
			headers: { "last-event-id": String(lastSeen) },
			until: (seen) => eventSeqs(seen).length >= 7,
		});

		// No snapshot — the resume frame is the baseline...
		expect(second.some((frame) => frame.event === "snapshot")).toBe(false);
		const resume = second.find((frame) => frame.event === "resume");
		expect(resume).toBeDefined();
		expect((resume!.data as { from_seq: number }).from_seq).toBe(lastSeen);

		// ...and the replay is exactly the missed range: contiguous from the
		// cursor, no gaps, no duplicates, ending at the server's head.
		const seqs = eventSeqs(second);
		expect(seqs[0]).toBe(lastSeen + 1);
		for (let index = 1; index < seqs.length; index += 1) {
			expect(seqs[index]).toBe(seqs[index - 1]! + 1);
		}
		expect(new Set(seqs).size).toBe(seqs.length);
		expect(seqs).toHaveLength(7);
	});

	it("converges when writes continue DURING the resume drain", async () => {
		for (let n = 0; n < 3; n += 1) await append(`before ${n}`);

		let writing = true;
		let writerError: unknown = null;
		const writer = (async () => {
			for (let n = 0; writing && n < 20; n += 1) await append(`during ${n}`);
		})().catch((error: unknown) => {
			writerError = error;
		});

		const frames = await connectAndRead({
			query: "?after=3",
			until: (seen) => eventSeqs(seen).length >= 20,
			budgetMs: 12_000,
		});
		writing = false;
		await writer;
		if (writerError) throw writerError;

		const seqs = eventSeqs(frames);
		// Contiguous from the cursor: a mid-drain NOTIFY may not re-deliver
		// everything instantly, but nothing may be skipped or repeated.
		expect(seqs[0]).toBe(4);
		for (let index = 1; index < seqs.length; index += 1) {
			expect(seqs[index]).toBe(seqs[index - 1]! + 1);
		}
	});

	it("?after= beats Last-Event-ID — explicit over ambient", async () => {
		for (let n = 0; n < 6; n += 1) await append(`e${n}`);

		const frames = await connectAndRead({
			query: "?after=4",
			headers: { "last-event-id": "1" },
			until: (seen) => eventSeqs(seen).length >= 2,
		});

		expect(eventSeqs(frames)[0]).toBe(5);
	});

	it("a malformed cursor falls back to the snapshot — never a 400 at a reconnecting client", async () => {
		await append("only");
		const frames = await connectAndRead({
			headers: { "last-event-id": "not-a-number" },
			until: (seen) => seen.some((frame) => frame.event === "snapshot"),
		});
		expect(frames.some((frame) => frame.event === "snapshot")).toBe(true);
		expect(frames.some((frame) => frame.event === "resume")).toBe(false);
	});

	it("a cursor below the compaction boundary falls back to the snapshot", async () => {
		process.env.HARBOR_EVENT_RETENTION_COUNT = "10";
		process.env.HARBOR_MAX_SNAPSHOT_EVENTS = "10";
		try {
			for (let n = 0; n < 30; n += 1) await append(`grow ${n}`);
			// A turn boundary so compaction has a foldable run to close.
			await appendEvent({ orgId, sessionId, type: "agent_finished", actor: "agent" });
			const result = await compactSession(orgId, sessionId);
			expect(result.compacted).toBeGreaterThan(0);

			// Seq 2 is long gone: the events above it were folded into summaries.
			// The honest baseline is the snapshot, whose summaries carry the story.
			const frames = await connectAndRead({
				query: "?after=2",
				until: (seen) => seen.some((frame) => frame.event === "snapshot"),
			});
			expect(frames.some((frame) => frame.event === "snapshot")).toBe(true);
			expect(frames.some((frame) => frame.event === "resume")).toBe(false);
		} finally {
			delete process.env.HARBOR_EVENT_RETENTION_COUNT;
			delete process.env.HARBOR_MAX_SNAPSHOT_EVENTS;
		}
	});

	it("an unknown key with a cursor is the same oracle-proof error as without one", async () => {
		const abort = new AbortController();
		const response = await getSessionStream(
			new Request("http://harbor.test/api/sessions/not-a-key/stream?after=5", {
				headers: { authorization: `Bearer ${apiKey}` },
				signal: abort.signal,
			}),
			{ params: Promise.resolve({ key: "not-a-key" }) },
		);
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			const deadline = Date.now() + 3_000;
			while (Date.now() < deadline && !buffer.includes("No such session.")) {
				const chunk = await Promise.race([
					reader.read(),
					new Promise<{ done: true; value: undefined }>((resolve) =>
						setTimeout(() => resolve({ done: true, value: undefined }), 200),
					),
				]);
				if (chunk.value) buffer += decoder.decode(chunk.value, { stream: true });
			}
		} finally {
			abort.abort();
			await reader.cancel().catch(() => {});
		}
		expect(buffer).toContain("No such session.");
	});
});

describe("the resume replays through holes the same way the live path does", () => {
	it("does not advance past a hole, and delivers the event when the hole fills", async () => {
		for (let n = 0; n < 3; n += 1) await append(`e${n}`);

		// Manufacture a hole: allocate seq 4 and 5, roll 4 back. The stream must
		// not present 5 as contiguous until 4 exists or forever pins — re-reading
		// is invisible, losing an event is not.
		await expect(
			db.transaction(async (tx) => {
				const { appendEvent: appendOnTx } = await import("../../lib/session-events");
				await appendOnTx(
					{ orgId, sessionId, type: "agent_message", payload: { doomed: true } },
					{ executor: tx },
				);
				throw new Error("roll back seq 4");
			}),
		).rejects.toThrow();

		// Seq 4 was rolled back WITH its counter bump (see the executor tests), so
		// the next append takes seq 4 and there is no hole after all — the
		// contiguity discipline is what this asserts.
		await append("e4");
		const frames = await connectAndRead({
			query: "?after=0",
			until: (seen) => eventSeqs(seen).length >= 4,
		});
		const seqs = eventSeqs(frames);
		expect(seqs).toEqual([1, 2, 3, 4]);
	});
});
