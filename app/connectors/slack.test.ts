// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Slack connector tests.
 *
 * Outbound calls are suppressed by leaving `botToken` out of the config, which
 * makes `slackApi` log and return rather than reach the network. That is a real
 * production path — a connector row whose install was revoked — so exercising it
 * here tests something rather than merely avoiding a mock.
 */

import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, sql } from "@core/schema/index.js";
import { artifacts, orgs, repos, sessionPrompts, sessions } from "@core/schema/schema.js";
import {
	handleSlackWebhook,
	resolveSlackAccount,
	verifySlackWebhook,
} from "./slack.js";
import type { ConnectorContext } from "./types.js";

let orgId: string;
let repoId: string;
let savedKey: string | undefined;

const ctx = (config: Record<string, unknown> = {}): ConnectorContext => ({
	orgId,
	connectorId: "00000000-0000-0000-0000-000000000000",
	externalAccountId: "T_TEAM",
	config,
	traceId: "trace-slack",
});

beforeEach(async () => {
	await sql`truncate table cost_events, circuit_breakers, automation_runs, automations, artifacts, session_events, sandboxes, session_repos, secrets, user_scm_tokens, environment_repos, environments, repos, activity, session_prompts, session_participants, sessions, runs, agent_presence, events, claims, tasks, projects, api_keys, digests, connectors, users, orgs cascade`;
	savedKey = process.env.ANTHROPIC_API_KEY;
	delete process.env.ANTHROPIC_API_KEY;

	const [org] = await db.insert(orgs).values({ name: "Slack Org" }).returning();
	orgId = org!.id;
	const [repo] = await db
		.insert(repos)
		.values({ orgId, owner: "acme", name: "api" })
		.returning();
	repoId = repo!.id;
});

afterAll(async () => {
	if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
	await sql.end();
});

// ---------------------------------------------------------------------------

describe("signature verification", () => {
	const secret = "slack-signing-secret";
	const body = JSON.stringify({ type: "event_callback" });

	const sign = (timestamp: string, payload = body) =>
		`v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${payload}`).digest("hex")}`;

	it("accepts a correctly signed, fresh request", () => {
		const ts = String(Math.floor(Date.now() / 1000));
		expect(
			verifySlackWebhook(body, { "x-slack-signature": sign(ts), "x-slack-request-timestamp": ts }, secret),
		).toBe(true);
	});

	it("rejects a tampered body", () => {
		const ts = String(Math.floor(Date.now() / 1000));
		expect(
			verifySlackWebhook(
				`${body} `,
				{ "x-slack-signature": sign(ts), "x-slack-request-timestamp": ts },
				secret,
			),
		).toBe(false);
	});

	/**
	 * Without the timestamp check a captured request is replayable forever, and a
	 * replayed app_mention starts a fresh session. An attacker who observed one
	 * valid webhook once could then spawn sandboxes indefinitely.
	 */
	it("rejects a replayed request outside the window", () => {
		const old = String(Math.floor(Date.now() / 1000) - 60 * 10);
		expect(
			verifySlackWebhook(
				body,
				{ "x-slack-signature": sign(old), "x-slack-request-timestamp": old },
				secret,
			),
		).toBe(false);
	});

	/**
	 * A one-sided check accepts anything stamped in the future, which is trivially
	 * forgeable by whoever controls the timestamp being signed over.
	 */
	it("rejects a request stamped in the future", () => {
		const ahead = String(Math.floor(Date.now() / 1000) + 60 * 10);
		expect(
			verifySlackWebhook(
				body,
				{ "x-slack-signature": sign(ahead), "x-slack-request-timestamp": ahead },
				secret,
			),
		).toBe(false);
	});

	it("rejects a missing or malformed signature", () => {
		const ts = String(Math.floor(Date.now() / 1000));
		expect(verifySlackWebhook(body, { "x-slack-request-timestamp": ts }, secret)).toBe(false);
		expect(
			verifySlackWebhook(
				body,
				{ "x-slack-signature": "v0=nothex", "x-slack-request-timestamp": ts },
				secret,
			),
		).toBe(false);
	});
});

describe("account resolution", () => {
	it("reads team_id from the envelope", () => {
		expect(resolveSlackAccount({ team_id: "T123", event: {} })).toBe("T123");
	});

	it("returns null when no account can be established", () => {
		expect(resolveSlackAccount({ event: {} })).toBeNull();
		expect(resolveSlackAccount("nope")).toBeNull();
	});
});

// ---------------------------------------------------------------------------

const mention = (text: string, over: Record<string, unknown> = {}) => ({
	team_id: "T_TEAM",
	event: {
		type: "app_mention",
		user: "U_RIN",
		text: `<@U_BOT> ${text}`,
		channel: "C_ENG",
		ts: "1700000000.000100",
		...over,
	},
});

describe("starting sessions", () => {
	it("starts a session and queues the prompt, with the mention stripped", async () => {
		const result = await handleSlackWebhook(mention("fix the retry cap in acme/api"), ctx());
		expect(result.action).toBe("session_started");

		const [session] = await db.select().from(sessions).where(eq(sessions.orgId, orgId));
		expect(session).toBeDefined();
		expect(session!.createdBy).toBe("slack:U_RIN");

		const [prompt] = await db
			.select()
			.from(sessionPrompts)
			.where(eq(sessionPrompts.sessionId, session!.id));
		expect(prompt!.body).toBe("fix the retry cap in acme/api");
		expect(prompt!.author).toBe("slack:U_RIN");
	});

	/**
	 * The thread link has to be stored as an indexed exact-match value, because
	 * this lookup runs on every message in every channel the bot can see.
	 */
	it("records the thread link as an artifact so continuity survives a restart", async () => {
		await handleSlackWebhook(mention("do a thing in acme/api"), ctx());
		const [artifact] = await db.select().from(artifacts).where(eq(artifacts.orgId, orgId));
		expect(artifact!.url).toBe("slack:C_ENG:1700000000.000100");
	});

	/**
	 * The behaviour that makes it feel like a conversation instead of a command
	 * line: a follow-up joins the queue of the session already running rather than
	 * booting a second sandbox that knows nothing about the first.
	 */
	it("queues a thread reply into the existing session rather than starting a second", async () => {
		await handleSlackWebhook(mention("start work in acme/api"), ctx());

		const reply = await handleSlackWebhook(
			{
				team_id: "T_TEAM",
				event: {
					type: "message",
					user: "U_MAYA",
					text: "also check the retry cap while you are in there",
					channel: "C_ENG",
					ts: "1700000000.000200",
					thread_ts: "1700000000.000100",
				},
			},
			ctx(),
		);

		expect(reply.action).toBe("updated");
		expect(await db.select().from(sessions).where(eq(sessions.orgId, orgId))).toHaveLength(1);

		const prompts = await db
			.select()
			.from(sessionPrompts)
			.where(eq(sessionPrompts.orgId, orgId));
		expect(prompts).toHaveLength(2);
		// Attribution is per prompt, not per session — the room has no owner.
		expect(prompts.map((p) => p.author).sort()).toEqual(["slack:U_MAYA", "slack:U_RIN"]);
	});

	it("asks rather than guessing when the target is ambiguous", async () => {
		await db.insert(repos).values({ orgId, owner: "acme", name: "web" });
		const result = await handleSlackWebhook(mention("something is broken"), ctx());
		expect(result.action).toBe("clarification_requested");
		expect(await db.select().from(sessions).where(eq(sessions.orgId, orgId))).toHaveLength(0);
	});
});

describe("messages Harbor must ignore", () => {
	/**
	 * Harbor's own replies are messages in the thread. Without this check it
	 * answers itself, and because the answer is also a message, it does so forever
	 * — the classic integration loop that fills a channel in minutes.
	 */
	it("ignores messages from a bot", async () => {
		const result = await handleSlackWebhook(
			mention("hello", { bot_id: "B_HARBOR" }),
			ctx(),
		);
		expect(result.action).toBe("ignored");
		expect(await db.select().from(sessions).where(eq(sessions.orgId, orgId))).toHaveLength(0);
	});

	it("ignores edits and deletions", async () => {
		const result = await handleSlackWebhook(
			mention("hello", { subtype: "message_changed" }),
			ctx(),
		);
		expect(result.action).toBe("ignored");
	});

	/**
	 * Reading every message in a channel and deciding which were meant for us is
	 * exactly the guess this design refuses to make.
	 */
	it("ignores a channel message that is neither a mention nor in a known thread", async () => {
		const result = await handleSlackWebhook(
			{
				team_id: "T_TEAM",
				event: {
					type: "message",
					user: "U_RIN",
					text: "anyone know why the build is red",
					channel: "C_ENG",
					ts: "1700000000.000300",
				},
			},
			ctx(),
		);
		expect(result.action).toBe("ignored");
		expect(await db.select().from(sessions).where(eq(sessions.orgId, orgId))).toHaveLength(0);
	});

	it("ignores a mention with no text once the mention itself is removed", async () => {
		const result = await handleSlackWebhook(
			{ team_id: "T_TEAM", event: { type: "app_mention", user: "U_RIN", text: "<@U_BOT>", channel: "C_ENG", ts: "1" } },
			ctx(),
		);
		expect(result.action).toBe("ignored");
	});
});

describe("org scoping", () => {
	/**
	 * The bug this asserts against is the one the README used to document as known
	 * and open: connector rows selected by type alone, so two orgs sharing a
	 * connector type delivered each other's messages.
	 */
	it("never writes into another org", async () => {
		const [other] = await db.insert(orgs).values({ name: "Other Org" }).returning();
		await db.insert(repos).values({ orgId: other!.id, owner: "other", name: "svc" });

		await handleSlackWebhook(mention("work in acme/api"), ctx());

		const theirs = await db
			.select()
			.from(sessions)
			.where(and(eq(sessions.orgId, other!.id)));
		expect(theirs).toHaveLength(0);
		expect(await db.select().from(sessions).where(eq(sessions.orgId, orgId))).toHaveLength(1);
	});
});
