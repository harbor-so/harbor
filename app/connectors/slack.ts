// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Slack.
 *
 * This is the connector that decides whether anyone adopts the product, and the
 * reason is not technical. A background agent spreads by being watched: someone
 * @-mentions it in a public channel, a colleague reads the thread, and now two
 * people use it. A background agent that only exists behind a dashboard login has
 * no such path — every user has to already know it exists and go looking, which
 * means adoption needs a mandate instead of a demonstration.
 *
 * Two rules shape everything below.
 *
 * **Never make a person learn bot syntax.** No `/harbor run --repo=x --branch=y`.
 * You @-mention it and say what you want; if Harbor cannot work out where that
 * should run, it asks with two buttons rather than guessing or erroring. Every
 * command-shaped integration eventually has a wiki page explaining its flags, and
 * that wiki page is where adoption goes to die.
 *
 * **Reply in the thread, always.** A background agent that answers in the channel
 * turns one question into a wall, and a background agent that answers by DM makes
 * the work invisible to exactly the people whose watching is what spreads it.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@core/schema/index.js";
import { artifacts, sessions } from "@core/schema/schema.js";
import { createSession } from "../lib/sessions.js";
import { enqueueSessionPrompt } from "../lib/session-runner.js";
import { linkBaseUrl } from "@core/kernel/urls.js";
import { resolveTarget } from "./routing.js";
import type {
	Connector,
	ConnectorActivity,
	ConnectorArtifact,
	ConnectorContext,
	WebhookResult,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Slack's v0 scheme: HMAC-SHA256 over `v0:<timestamp>:<raw body>`.
 *
 * The timestamp check is not optional and is not a nicety. Without it a captured
 * request is replayable forever, and a replayed `app_mention` starts a fresh
 * session — which is to say, an attacker who saw one valid webhook once can spawn
 * sandboxes indefinitely. Five minutes is Slack's own recommendation and is
 * generous enough to survive clock skew between their servers and yours.
 *
 * harbor-lint-allow-constant: Slack's own v0 signing recommendation. A knob
 * here would only let an operator silently weaken replay protection.
 */
const REPLAY_WINDOW_SECONDS = 60 * 5;

export function verifySlackWebhook(
	rawBody: string,
	headers: Record<string, string | undefined>,
	secret: string,
): boolean {
	const supplied = headers["x-slack-signature"];
	const timestamp = headers["x-slack-request-timestamp"];
	if (!supplied?.startsWith("v0=") || !timestamp) return false;
	if (!/^[0-9a-f]{64}$/i.test(supplied.slice(3))) return false;

	const sent = Number(timestamp);
	if (!Number.isFinite(sent)) return false;
	// `Math.abs` so a request from a clock that is ahead is rejected too. A
	// one-sided check accepts anything stamped in the future, which is trivially
	// forgeable by an attacker who controls the timestamp they are signing over.
	if (Math.abs(Date.now() / 1000 - sent) > REPLAY_WINDOW_SECONDS) return false;

	const expected = createHmac("sha256", secret)
		.update(`v0:${timestamp}:${rawBody}`)
		.digest();
	const actual = Buffer.from(supplied.slice(3), "hex");
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * The team id, from the verified payload.
 *
 * Slack puts it in different places depending on the wrapper, and reading the
 * wrong one on an Enterprise Grid install resolves to the enterprise rather than
 * the workspace. `team_id` at the top level is the one that matches what the
 * OAuth install recorded.
 */
export function resolveSlackAccount(payload: unknown): string | null {
	if (!isRecord(payload)) return null;
	if (typeof payload.team_id === "string") return payload.team_id;
	if (isRecord(payload.team) && typeof payload.team.id === "string") return payload.team.id;
	if (isRecord(payload.event) && typeof payload.event.team === "string") return payload.event.team;
	return null;
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

interface SlackEvent {
	type: string;
	subtype?: string;
	user?: string;
	text?: string;
	channel?: string;
	ts?: string;
	thread_ts?: string;
	bot_id?: string;
}

function parseEvent(payload: unknown): SlackEvent | null {
	if (!isRecord(payload) || !isRecord(payload.event)) return null;
	const event = payload.event;
	if (typeof event.type !== "string") return null;
	return {
		type: event.type,
		subtype: typeof event.subtype === "string" ? event.subtype : undefined,
		user: typeof event.user === "string" ? event.user : undefined,
		text: typeof event.text === "string" ? event.text : undefined,
		channel: typeof event.channel === "string" ? event.channel : undefined,
		ts: typeof event.ts === "string" ? event.ts : undefined,
		thread_ts: typeof event.thread_ts === "string" ? event.thread_ts : undefined,
		bot_id: typeof event.bot_id === "string" ? event.bot_id : undefined,
	};
}

/**
 * `<@U123> fix the login bug` → `fix the login bug`.
 *
 * Slack has five mention encodings and the naive `<@U[A-Z0-9]+>` catches one of
 * them. The others leak into the prompt, which matters more than it sounds:
 * `<#C0192|deploys>` reaching the agent as literal text is a nonsense token in
 * the instruction, and `<https://…|the ticket>` arriving un-unwrapped means the
 * agent is handed markup instead of the URL somebody meant to give it.
 *
 * Link forms keep their label rather than being deleted, because "see <URL|the
 * spec>" becomes meaningless if the words disappear along with the markup.
 */
function stripMentions(text: string): string {
	return text
		// User, bot and workspace mentions, with or without a display label.
		.replace(/<@[UWB][A-Z0-9_]+(\|[^>]*)?>/g, "")
		// User groups: <!subteam^S123|@backend>
		.replace(/<!subteam\^[A-Z0-9_]+(\|[^>]*)?>/g, "")
		// Special mentions: <!here>, <!channel>, <!everyone>
		.replace(/<![a-z]+(\|[^>]*)?>/g, "")
		// Channel links keep their name: <#C0192|deploys> → #deploys
		.replace(/<#[A-Z0-9_]+\|([^>]*)>/g, "#$1")
		.replace(/<#[A-Z0-9_]+>/g, "")
		// Links keep their label if they have one, otherwise the bare URL.
		.replace(/<(https?:\/\/[^>|]+)\|([^>]*)>/g, "$2")
		.replace(/<(https?:\/\/[^>|]+)>/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

/**
 * A mention or a DM becomes a session; a reply in a session's thread becomes a
 * queued prompt in that same session.
 *
 * The thread-continuity half is what makes it feel like a conversation instead of
 * a command line. Somebody says "actually also check the retry cap" three minutes
 * later and it lands in the queue of the session that is already running, rather
 * than starting a second sandbox that knows nothing about the first.
 */
export async function handleSlackWebhook(
	payload: unknown,
	ctx: ConnectorContext,
): Promise<WebhookResult> {
	const event = parseEvent(payload);
	if (!event) return { action: "ignored", reason: "Not a Slack event callback." };

	// A bot's own message, or an edit/deletion. Without this check Harbor replies
	// to itself, and because its reply is also a message in the thread, it does so
	// forever — the classic integration loop that fills a channel in minutes.
	if (event.bot_id || event.subtype) {
		return { action: "ignored", reason: "Bot message or message subtype." };
	}
	if (event.type !== "app_mention" && event.type !== "message") {
		return { action: "ignored", reason: `Slack event ${event.type} is not handled.` };
	}

	const body = stripMentions(event.text ?? "");
	if (!body) return { action: "ignored", reason: "Empty message after removing mentions." };
	if (!event.channel) return { action: "ignored", reason: "Message has no channel." };

	const author = `slack:${event.user ?? "unknown"}`;
	const threadRef = `${event.channel}:${event.thread_ts ?? event.ts}`;

	// Is there already a session for this thread? Matched on the artifact we wrote
	// when the session was created, so the link survives a restart and is visible
	// in the UI rather than living in a cache somewhere.
	const existing = await findSessionForThread(ctx.orgId, threadRef);
	if (existing) {
		// The capped front door, not the raw insert: a Slack thread wired to a
		// retrying workflow is exactly the human-free amplification path the
		// queue-depth cap exists for, and an archived session must refuse rather
		// than silently swallow the message.
		const outcome = await enqueueSessionPrompt({
			orgId: ctx.orgId,
			sessionId: existing.id,
			author,
			authorKind: "human",
			body,
		});
		if (!outcome.ok) {
			return { action: "ignored", reason: outcome.message };
		}
		return { action: "updated", sessionId: existing.id, reason: "Queued into the thread's session." };
	}

	// A plain channel message that is not a mention and not in a known thread is
	// somebody talking to their colleagues. Reading every message in a channel and
	// deciding which ones were meant for us is exactly the "guess" this design
	// refuses to make.
	if (event.type !== "app_mention") {
		return { action: "ignored", reason: "Channel message with no mention and no session thread." };
	}

	const target = await resolveTarget({
		orgId: ctx.orgId,
		text: body,
		channelRef: event.channel,
		channelName: channelNameFor(ctx.config, event.channel),
		config: ctx.config,
	});

	if (target.kind === "unknown") {
		await postClarification(ctx, threadRef, body, target.candidates);
		return {
			action: "clarification_requested",
			reason: "Could not determine the target; asked in the thread.",
		};
	}

	const session = await createSession({
		orgId: ctx.orgId,
		title: body.slice(0, 120),
		createdBy: author,
	});

	await db.insert(artifacts).values({
		orgId: ctx.orgId,
		sessionId: session.id,
		kind: "log",
		title: "slack-thread",
		url: threadArtifactUrl(threadRef),
		payload: { threadRef, channel: event.channel, ts: event.thread_ts ?? event.ts },
	});

	// A freshly created session cannot be over its cap, but the front door also
	// carries the promptability check and the body validation, and two enqueue
	// paths with different rules is how the second one rots.
	const queued = await enqueueSessionPrompt({
		orgId: ctx.orgId,
		sessionId: session.id,
		author,
		authorKind: "human",
		body,
	});
	if (!queued.ok) {
		return { action: "ignored", reason: queued.message };
	}

	await postMessage(ctx, event.channel, event.thread_ts ?? event.ts, [
		`Started a session — <${sessionUrl(session.key)}|open it>`,
		target.kind === "repo"
			? `Working in a repository (${target.reason}).`
			: `Working in an environment (${target.reason}).`,
		"Reply in this thread to add to the queue while it works.",
	].join("\n"));

	return { action: "session_started", sessionId: session.id };
}

/**
 * The thread link is stored in `artifacts.url` as `slack:<channel>:<ts>`, not in
 * the jsonb payload.
 *
 * That looks like an odd place for it until you consider the read: this lookup
 * runs on **every message in every channel the bot can see**, so it has to be one
 * indexed equality test. A jsonb containment scan over every artifact in the org
 * would be the hottest query in the system and would get slower every day the
 * product is used. The payload still carries the structured fields for display.
 */
function threadArtifactUrl(threadRef: string): string {
	return `slack:${threadRef}`;
}

async function findSessionForThread(orgId: string, threadRef: string) {
	const [hit] = await db
		.select({ id: sessions.id, key: sessions.key })
		.from(artifacts)
		.innerJoin(sessions, eq(artifacts.sessionId, sessions.id))
		.where(and(eq(artifacts.orgId, orgId), eq(artifacts.url, threadArtifactUrl(threadRef))))
		.limit(1);
	return hit ?? null;
}

function channelNameFor(config: Record<string, unknown>, channelRef: string): string | null {
	const names = config.channelNames;
	if (!isRecord(names)) return null;
	const name = names[channelRef];
	return typeof name === "string" ? name : null;
}

function sessionUrl(key: string): string {
	// `linkBaseUrl()` rather than reading the variable here: this used `??`, so a
	// blank `HARBOR_PUBLIC_URL=` — the shape `.env.example` ships — produced the
	// bare path `/s/<key>`, which Slack renders as text rather than a link.
	return `${linkBaseUrl()}/s/${key}`;
}

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

/**
 * Every outbound call goes through here, and every one is authorised per call
 * from the connector row rather than from a token cached at boot.
 *
 * A revoked Slack install then stops working immediately rather than at the next
 * process restart, which on a long-lived server can be weeks.
 */
async function slackApi(
	ctx: ConnectorContext,
	method: string,
	body: Record<string, unknown>,
): Promise<void> {
	const token = ctx.config.botToken;
	if (typeof token !== "string" || !token) {
		// Loud, and it names what is missing. A silently skipped reply reads to the
		// user as the agent ignoring them.
		console.error(
			`[slack] cannot call ${method}: this connector row has no botToken. `
				+ "Re-run the Slack install so Harbor can reply in threads.",
		);
		return;
	}

	try {
		const response = await fetch(`https://slack.com/api/${method}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json; charset=utf-8",
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(10_000),
		});
		const result = (await response.json()) as { ok?: boolean; error?: string };
		if (!result.ok) console.error(`[slack] ${method} failed: ${result.error ?? "unknown"}`);
	} catch (error) {
		// An outbound failure must never fail the inbound webhook. Slack retries a
		// non-2xx delivery, and a retry re-runs `handleSlackWebhook` — which would
		// start a second session for the same message because the reply failed.
		console.error(`[slack] ${method} threw:`, error);
	}
}

async function postMessage(
	ctx: ConnectorContext,
	channel: string,
	threadTs: string | undefined,
	text: string,
): Promise<void> {
	await slackApi(ctx, "chat.postMessage", { channel, thread_ts: threadTs, text });
}

/**
 * The picker Harbor shows instead of guessing.
 *
 * The message repeats what was asked, so that clicking a button is the whole of
 * the user's remaining work — they do not have to retype the request into a form.
 */
async function postClarification(
	ctx: ConnectorContext,
	threadRef: string,
	prompt: string,
	candidates: Array<{ id: string; kind: "repo" | "environment"; label: string }>,
): Promise<void> {
	const [channel, ts] = threadRef.split(":");
	if (!channel) return;

	const blocks = [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: `I can do that — which one?\n> ${prompt.slice(0, 200)}`,
			},
		},
		{
			type: "actions",
			elements: candidates.slice(0, 5).map((c) => ({
				type: "button",
				text: { type: "plain_text", text: c.label.slice(0, 75) },
				value: JSON.stringify({ kind: c.kind, id: c.id, prompt: prompt.slice(0, 2000) }),
				action_id: `harbor_target_${c.kind}_${c.id}`,
			})),
		},
	];

	await slackApi(ctx, "chat.postMessage", {
		channel,
		thread_ts: ts,
		text: "Which repository should I work in?",
		blocks,
	});
}

/**
 * Progress back into the thread — five moments, not five hundred.
 *
 * A connector that posts every token produces a thread nobody can read and a rate
 * limit nobody planned for. These are the inflection points a person waiting on
 * the work actually cares about.
 */
export async function postSlackActivity(
	ctx: ConnectorContext,
	activity: ConnectorActivity,
): Promise<void> {
	const [channel, ts] = activity.threadRef.split(":");
	if (!channel) return;

	const prefix = {
		started: ":hourglass_flowing_sand:",
		progress: ":gear:",
		needs_input: ":raising_hand:",
		finished: ":white_check_mark:",
		failed: ":x:",
	}[activity.kind];

	await postMessage(ctx, channel, ts, `${prefix} ${activity.text}`);
}

export async function linkSlackArtifact(
	ctx: ConnectorContext,
	artifact: ConnectorArtifact,
): Promise<void> {
	const [channel, ts] = artifact.threadRef.split(":");
	if (!channel) return;
	const text = artifact.url
		? `:link: ${artifact.title} — <${artifact.url}|open>`
		: `:link: ${artifact.title}`;
	await postMessage(ctx, channel, ts, text);
}

// ---------------------------------------------------------------------------

export const slackConnector: Connector = {
	type: "slack",
	verifyWebhook: verifySlackWebhook,
	resolveAccount: resolveSlackAccount,
	handleWebhook: handleSlackWebhook,
	postActivity: postSlackActivity,
	linkArtifact: linkSlackArtifact,
	outboundWrites: [
		{
			action: "chat.postMessage",
			scope: "chat:write",
			description:
				"Posts a threaded reply in the channel the request came from. Never posts to "
				+ "a channel Harbor was not addressed in, and never posts at the top level of a "
				+ "channel — every message is a thread reply.",
			triggeredBy:
				"A session starting, reaching one of five progress inflection points, producing "
				+ "an artifact, or needing the target clarified.",
		},
	],
};
