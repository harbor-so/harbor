// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Every prompt the commands route emits must be runnable by the real bridge.
 *
 * The defect this suite closes was total: `session_prompts` had no
 * `author_email` column, the route hardcoded `author_email: null` and sent no
 * `mode`, and `identityForPrompt` in runtime/bridge.ts — correctly — refused
 * to guess. Every attributed prompt in the product threw `GitIdentityError`
 * inside the sandbox, so NO turn could run end to end, and the suite was green
 * because each hop was tested in isolation and nothing fed one hop's real
 * output into the next hop's real input.
 *
 * So that is exactly what the key test here does: it drains real `prompt`
 * commands off the real SSE route and feeds each one into the REAL
 * `identityForPrompt` imported from the runtime — not a copy, not a fixture of
 * its rules. If the control plane and the sandbox ever disagree about identity
 * again, this fails before a customer's sandbox does.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as getSandboxCommands } from "./[id]/commands/route.js";
import { identityForPrompt } from "../../../runtime/bridge.js";
import { db, sql } from "@core/schema/index.js";
import { orgs, sandboxes } from "@core/schema/schema.js";
import {
	enqueueSessionPrompt,
	sha256Hex,
	takeNextPrompt,
} from "../../lib/session-runner.js";
import { createSession, queuePrompt } from "../../lib/sessions.js";
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

interface Frame {
	event: string;
	data: unknown;
}

interface PromptCommand {
	type: string;
	trace_id?: string;
	prompt?: {
		id: string;
		author: string;
		author_email: string | null;
		mode?: string;
	};
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

/** Open the stream, collect prompt commands until `count` arrive, close. */
async function drainPromptCommands(boxId: string, token: string, count: number) {
	const abort = new AbortController();
	const response = await getSandboxCommands(
		new Request(`http://harbor.test/api/sandbox/${boxId}/commands`, {
			headers: { authorization: `Bearer ${token}`, "x-harbor-fencing-token": "1" },
			signal: abort.signal,
		}),
		{ params: Promise.resolve({ id: boxId }) },
	);
	expect(response.status).toBe(200);

	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const frames: Frame[] = [];
	const prompts = () =>
		frames.filter(
			(frame) => frame.event === "command" && (frame.data as PromptCommand).type === "prompt",
		);

	try {
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline && prompts().length < count) {
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
	return prompts().map((frame) => frame.data as PromptCommand);
}

beforeEach(async () => {
	await sql.unsafe(TRUNCATE);
	const [org] = await db.insert(orgs).values({ name: "Attribution Org" }).returning();
	orgId = org!.id;
	const session = await createSession({ orgId, title: "Attribution", createdBy: "rin" });
	sessionId = session.id;
});

afterAll(async () => {
	await sql.end({ timeout: 5 });
});

describe("prompt commands carry a complete, runnable identity", () => {
	it("a human with an email goes down as attributed-user, and the REAL bridge accepts it", async () => {
		const box = await makeSandbox("tok-attr");
		const queued = await enqueueSessionPrompt({
			orgId,
			sessionId,
			author: "Rin Nakamoto",
			authorKind: "human",
			authorEmail: "rin@example.com",
			body: "Fix the retry cap.",
		});
		expect(queued.ok).toBe(true);
		await takeNextPrompt(orgId, sessionId, new Date(), { traceId: "trace-attr-1" });
		await notifyChange(orgId, "session_event");

		const [command] = await drainPromptCommands(box.id, "tok-attr", 1);
		expect(command).toBeDefined();
		expect(command!.prompt!.mode).toBe("attributed-user");
		expect(command!.prompt!.author_email).toBe("rin@example.com");
		expect(command!.trace_id).toBe("trace-attr-1");

		// THE END-TO-END GUARD: the runtime's own identity gate, not a copy of
		// its rules. This call throwing is the "no turn can run" defect.
		const identity = identityForPrompt(command!.prompt!);
		expect(identity).toEqual({
			mode: "attributed-user",
			name: "Rin Nakamoto",
			email: "rin@example.com",
		});
	});

	it("a human with NO email on file degrades to agent-only — a turn that runs, not a refusal", async () => {
		const box = await makeSandbox("tok-attr");
		const queued = await enqueueSessionPrompt({
			orgId,
			sessionId,
			author: "sso-user-with-no-public-email",
			authorKind: "human",
			body: "Do the thing.",
		});
		expect(queued.ok).toBe(true);
		await takeNextPrompt(orgId, sessionId);
		await notifyChange(orgId, "session_event");

		const [command] = await drainPromptCommands(box.id, "tok-attr", 1);
		expect(command!.prompt!.mode).toBe("agent-only");
		expect(command!.prompt!.author_email).toBeNull();

		expect(identityForPrompt(command!.prompt!)).toEqual({ mode: "agent-only" });
	});

	it("an agent author is ALWAYS agent-only, even if an email somehow landed on the row", async () => {
		const box = await makeSandbox("tok-attr");
		// Bypass the front door to plant the contradiction directly: an
		// agent-authored prompt carrying an email. The route must not attribute a
		// commit to an email an agent supplied.
		await queuePrompt({
			orgId,
			sessionId,
			author: "automation:hourly",
			authorKind: "agent",
			authorEmail: "spoofed@example.com",
			body: "Scheduled work.",
		});
		await takeNextPrompt(orgId, sessionId);
		await notifyChange(orgId, "session_event");

		const [command] = await drainPromptCommands(box.id, "tok-attr", 1);
		expect(command!.prompt!.mode).toBe("agent-only");
		expect(command!.prompt!.author_email).toBeNull();
		expect(identityForPrompt(command!.prompt!)).toEqual({ mode: "agent-only" });
	});

	it("EVERY emitted prompt passes the real identity gate — none may throw", async () => {
		const box = await makeSandbox("tok-attr");
		const authors = [
			{ author: "Rin", authorKind: "human" as const, authorEmail: "rin@example.com" },
			{ author: "No Email", authorKind: "human" as const },
			{ author: "agent:child", authorKind: "agent" as const },
		];
		for (const [index, spec] of authors.entries()) {
			await queuePrompt({ orgId, sessionId, body: `prompt ${index}`, ...spec });
		}
		// Deliver all three (humans first by priority; order is not under test).
		await takeNextPrompt(orgId, sessionId);
		await takeNextPrompt(orgId, sessionId);
		await takeNextPrompt(orgId, sessionId);
		await notifyChange(orgId, "session_event");

		const commands = await drainPromptCommands(box.id, "tok-attr", 3);
		expect(commands).toHaveLength(3);
		for (const command of commands) {
			// The regression that shipped: this exact call threw for every prompt
			// in the product, because author_email was always null and no mode
			// said that was deliberate.
			expect(() => identityForPrompt(command.prompt!)).not.toThrow();
		}
	});

	it("the stored authorEmail round-trips through both enqueue doors", async () => {
		const viaFrontDoor = await enqueueSessionPrompt({
			orgId,
			sessionId,
			author: "Rin",
			authorKind: "human",
			authorEmail: "rin@example.com",
			body: "front door",
		});
		expect(viaFrontDoor.ok).toBe(true);
		const viaRaw = await queuePrompt({
			orgId,
			sessionId,
			author: "Sam",
			authorKind: "human",
			body: "raw, no email",
		});

		const { sessionPrompts } = await import("@core/schema/schema");
		const { eq } = await import("drizzle-orm");
		const rows = await db
			.select()
			.from(sessionPrompts)
			.where(eq(sessionPrompts.sessionId, sessionId));
		const front = rows.find((row) => row.body === "front door");
		const raw = rows.find((row) => row.id === viaRaw.id);
		expect(front!.authorEmail).toBe("rin@example.com");
		expect(raw!.authorEmail).toBeNull();
	});
});
