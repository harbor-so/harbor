// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The downlink's fence, checked where it actually matters: *during* the stream.
 *
 * The connect-time check is asserted in `src/lib/session-runner.test.ts`, and on
 * its own it proves less than it looks. A fence validated once at the handshake is
 * a fence a box keeps for as long as its socket stays open — and an open socket is
 * exactly what a zombie has. This suite reproduces the sequence that produces two
 * agents on one branch:
 *
 *   1. box 1 connects, correctly fenced, and is serving happily;
 *   2. box 1 is written off (a boot that outran its watchdog, a stop that did not
 *      land) and box 2 is spawned, taking fence 2;
 *   3. a prompt is delivered.
 *
 * Before the fix, step 3 handed that prompt to *both* boxes: box 1's socket was
 * still open and nothing re-asked whether it still held the fence. The assertion
 * below is therefore about what box 1 must NOT receive, which is the shape of every
 * useful test of an authority check.
 *
 * Real Postgres, real LISTEN/NOTIFY, no mocks: the wakeup that drives the drain is
 * a property of Postgres, and a fake that delivers it is a fake that proves a fact
 * about itself.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as getSandboxCommands } from "./[id]/commands/route.js";
import { db, sql } from "@core/schema/index.js";
import { orgs, sandboxes } from "@core/schema/schema.js";
import { enqueueSessionPrompt, sha256Hex, takeNextPrompt } from "../../lib/session-runner.js";
import { createSession } from "../../lib/sessions.js";
import { notifyChange } from "@core/kernel/work.js";

let orgId: string;
let sessionId: string;

const TRUNCATE = `truncate table
	session_events, cost_events, artifacts, session_repos, sandboxes,
	session_prompts, session_participants, sessions,
	activity, runs, agent_presence, events, claims, tasks, projects,
	circuit_breakers, automation_runs, automations, secrets, user_scm_tokens,
	environment_repos, environments, repos, api_keys, digests, connectors, users, orgs
	cascade`;

beforeEach(async () => {
	await sql.unsafe(TRUNCATE);
	const [org] = await db.insert(orgs).values({ name: "Fence Org" }).returning();
	orgId = org!.id;
	const session = await createSession({
		orgId,
		title: "Rewrite the retry backoff",
		createdBy: "@rin",
	});
	sessionId = session.id;
});

afterAll(async () => {
	await sql.end({ timeout: 5 });
});

interface Frame {
	event: string;
	data: unknown;
}

function parseFrames(buffer: string): { frames: Frame[]; rest: string } {
	const parts = buffer.split("\n\n");
	const rest = parts.pop() ?? "";
	const frames: Frame[] = [];
	for (const part of parts) {
		let event = "message";
		const data: string[] = [];
		for (const line of part.split("\n")) {
			if (line.startsWith("event: ")) event = line.slice(7);
			else if (line.startsWith("data: ")) data.push(line.slice(6));
		}
		if (data.length > 0) frames.push({ event, data: JSON.parse(data.join("\n")) });
	}
	return { frames, rest };
}

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

describe("GET /api/sandbox/[id]/commands — the fence, mid-stream", () => {
	it("shuts a box down when it is superseded after connecting, and sends it no prompt", async () => {
		const first = await makeSandbox("tok-first");

		const abort = new AbortController();
		const response = await getSandboxCommands(
			new Request(`http://harbor.test/api/sandbox/${first.id}/commands`, {
				headers: { authorization: "Bearer tok-first", "x-harbor-fencing-token": "1" },
				signal: abort.signal,
			}),
			{ params: Promise.resolve({ id: first.id }) },
		);
		expect(response.status).toBe(200);

		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		const frames: Frame[] = [];

		/** Read until `want` says we have seen enough, or the budget runs out. */
		const readUntil = async (want: () => boolean): Promise<void> => {
			const deadline = Date.now() + 5_000;
			while (Date.now() < deadline && !want()) {
				const chunk = await Promise.race([
					reader.read(),
					new Promise<{ done: true; value: undefined }>((resolve) =>
						setTimeout(() => resolve({ done: true, value: undefined }), 200),
					),
				]);
				if (!chunk.value) continue;
				buffer += decoder.decode(chunk.value, { stream: true });
				const parsed = parseFrames(buffer);
				buffer = parsed.rest;
				frames.push(...parsed.frames);
			}
		};

		try {
			await readUntil(() => frames.some((frame) => frame.event === "ready"));
			expect(frames.some((frame) => frame.event === "ready")).toBe(true);

			// The world moves on: a second box takes fence 2, and a prompt is delivered
			// into the session. The first box is still `ready` — nothing reaped it, which
			// is the whole point — so a status check alone would let it keep working.
			await makeSandbox("tok-second");
			const queued = await enqueueSessionPrompt({
				orgId,
				sessionId,
				author: "@rin",
				body: "Push the fix.",
			});
			expect(queued.ok).toBe(true);
			await takeNextPrompt(orgId, sessionId);
			await notifyChange(orgId, "session_event");

			await readUntil(() =>
				frames.some(
					(frame) => frame.event === "command" && (frame.data as { type: string }).type === "shutdown",
				),
			);
		} finally {
			abort.abort();
			await reader.cancel().catch(() => {});
		}

		const commands = frames
			.filter((frame) => frame.event === "command")
			.map((frame) => frame.data as { type: string });

		// The superseded box is never handed the prompt that box 2 legitimately owns.
		// Asserted first because it is the security claim: without the per-drain fence
		// check this is `true`, and two agents start on one prompt.
		expect(commands.some((command) => command.type === "prompt")).toBe(false);
		// And it is told to stop rather than left holding an open socket, so it exits
		// instead of waiting for a heartbeat threshold to notice it.
		expect(commands.some((command) => command.type === "shutdown")).toBe(true);
	});

	it("keeps serving a box that still holds the fence", async () => {
		const only = await makeSandbox("tok-only");
		const queued = await enqueueSessionPrompt({
			orgId,
			sessionId,
			author: "@rin",
			body: "Have another look at the backoff.",
		});
		if (!queued.ok) throw new Error("setup failed");
		await takeNextPrompt(orgId, sessionId);

		const abort = new AbortController();
		const response = await getSandboxCommands(
			new Request(`http://harbor.test/api/sandbox/${only.id}/commands`, {
				headers: { authorization: "Bearer tok-only", "x-harbor-fencing-token": "1" },
				signal: abort.signal,
			}),
			{ params: Promise.resolve({ id: only.id }) },
		);
		expect(response.status).toBe(200);

		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		const frames: Frame[] = [];
		try {
			const deadline = Date.now() + 5_000;
			while (Date.now() < deadline && !frames.some((frame) => frame.event === "command")) {
				const chunk = await Promise.race([
					reader.read(),
					new Promise<{ done: true; value: undefined }>((resolve) =>
						setTimeout(() => resolve({ done: true, value: undefined }), 200),
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

		// The re-check is per drain, so a box that is still current must be unaffected
		// by it — a guard that also stops the healthy case is not a guard, it is an
		// outage.
		const command = frames.find((frame) => frame.event === "command")?.data as {
			type: string;
			prompt?: { id: string };
		};
		expect(command?.type).toBe("prompt");
		expect(command?.prompt?.id).toBe(queued.ok ? queued.promptId : "");
	});
});

/** The sandbox row is only read by primary key, so this is a smoke check on setup. */
it("seeds sandboxes that the route can actually authenticate", async () => {
	const box = await makeSandbox("tok-check");
	const [row] = await db.select().from(sandboxes).where(eq(sandboxes.id, box.id)).limit(1);
	expect(row?.authTokenHash).toBe(sha256Hex("tok-check"));
});
