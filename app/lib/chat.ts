// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Chat: the signed-event ingest pipeline, and the rooms it flows into.
 *
 * This is the server half of the primitive `src/lib/signing.ts` defines. Its whole
 * job is to be the one place an event is admitted, so the trust boundary lives in
 * exactly one function (`ingestEvent`) and cannot be half-applied on some path.
 *
 * The order of checks in `ingestEvent` is the design, not incidental:
 *
 *   1. resolve the org from the CONNECTION, never the event body (the caller
 *      already proved which tenant it is — by API key or by session);
 *   2. verify the event's id and signature (crypto);
 *   3. bind the author's pubkey to a principal registered in THAT org — a key
 *      registered in another tenant cannot post here;
 *   4. require channel membership BEFORE anything is persisted or fanned out, so a
 *      private channel cannot leak through the ingest path;
 *   5. only then assign a per-channel `seq` and store.
 *
 * Steps 3 and 4 are the two Harbor cares about most: they are how "which tenant"
 * and "which room" stay properties of the server's own state rather than claims a
 * signed event gets to make about itself.
 */

import { and, asc, desc, eq, gt, sql as raw } from "drizzle-orm";
import { db } from "@core/schema/index.js";
import { channelMembers, channels, chatEvents, principals } from "@core/schema/schema.js";
import type { Channel, ChannelMember, ChatEvent, Principal } from "@core/schema/schema.js";
import { setting } from "@core/kernel/config.js";
import { publish } from "@core/kernel/bus.js";
import { EVENT_KINDS, computeId, isEphemeral, verifyEvent } from "./signing.js";
import type { EventKind, SignedEvent } from "./signing.js";
import { HarborError } from "@core/kernel/work.js";

/**
 * Kinds a client is allowed to author.
 *
 * Membership and lifecycle events (`join`, `leave`, `system`, `channel_create`)
 * are authored by the SERVER in response to an already-authenticated action, so a
 * client asserting one is refused — otherwise anyone could forge "X joined" or a
 * second "channel created" into the log.
 */
const CLIENT_KINDS = new Set<EventKind>(["message", "reaction", "typing", "presence"]);

const PUBKEY = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The db handle or a transaction on it — mirrors the pattern in work.ts. */
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Short, URL-safe, unguessable channel key.
 *
 * 22 chars of the same reduced base32 sessions uses (no i/l/o/u), because the key
 * is the credential for a group channel and also gets read aloud and pasted into
 * chat. Kept local rather than imported from sessions.ts: chat does not depend on
 * the coordination feature, and a shared minter would couple two things that
 * should be free to diverge.
 */
const KEY_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export function mintChannelKey(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(22));
	let key = "";
	for (const byte of bytes) key += KEY_ALPHABET[byte % KEY_ALPHABET.length];
	return key;
}

/** What the caller's connection already proved: which tenant it belongs to. */
export interface ConnContext {
	orgId: string;
}

// ---------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------

export interface RegisterPrincipalInput {
	orgId: string;
	pubkey: string;
	kind?: "human" | "agent";
	displayName: string;
	userId?: string;
}

/**
 * Register (or update) a public key as a principal in an org.
 *
 * Idempotent on (org, pubkey): re-registering the same key just refreshes the
 * display name, which is what a client generating its key once and announcing it
 * on every load should do. The private key is never sent here — only the public
 * half, which is the identity.
 */
export async function registerPrincipal(input: RegisterPrincipalInput): Promise<Principal> {
	const pubkey = input.pubkey.trim().toLowerCase();
	if (!PUBKEY.test(pubkey)) {
		throw new HarborError("A public key must be 64 hex characters (an Ed25519 key).");
	}
	const displayName = input.displayName.trim();
	if (!displayName) throw new HarborError("A principal needs a display name.");

	const [row] = await db
		.insert(principals)
		.values({
			orgId: input.orgId,
			pubkey,
			kind: input.kind ?? "human",
			displayName,
			userId: input.userId ?? null,
		})
		.onConflictDoUpdate({
			target: [principals.orgId, principals.pubkey],
			set: { displayName, kind: input.kind ?? "human" },
		})
		.returning();
	return row!;
}

export async function principalByPubkey(
	orgId: string,
	pubkey: string,
): Promise<Principal | undefined> {
	return db.query.principals.findFirst({
		where: and(eq(principals.orgId, orgId), eq(principals.pubkey, pubkey.toLowerCase())),
	});
}

// ---------------------------------------------------------------------------
// Channels & membership
// ---------------------------------------------------------------------------

export interface CreateChannelInput {
	orgId: string;
	title: string;
	kind?: "group" | "direct" | "task";
	/** Creator's pubkey — must already be a registered principal in the org. */
	createdBy: string;
	taskId?: string;
	/** Extra members to seed (for a direct channel, the other party). */
	members?: Array<{ pubkey: string; displayName: string; kind?: "human" | "agent" }>;
}

export async function createChannel(input: CreateChannelInput): Promise<Channel> {
	const title = input.title.trim();
	if (!title) throw new HarborError("A channel needs a title.");

	const creator = await principalByPubkey(input.orgId, input.createdBy);
	if (!creator) {
		throw new HarborError("Register your key as a principal before creating a channel.");
	}

	return db.transaction(async (tx) => {
		const [channel] = await tx
			.insert(channels)
			.values({
				orgId: input.orgId,
				key: mintChannelKey(),
				kind: input.kind ?? "group",
				title,
				taskId: input.taskId ?? null,
				createdBy: creator.pubkey,
			})
			.returning();

		const seed = [
			{ pubkey: creator.pubkey, displayName: creator.displayName, kind: creator.kind },
			...(input.members ?? []),
		];
		for (const member of seed) {
			await addMember(tx, input.orgId, channel!.id, member);
		}

		// The room's first durable event, server-authored: it exists so an empty
		// channel still has a beginning in the log, and so `channel_create` is a
		// real event other clients can react to rather than a silent row.
		await appendDurable(tx, {
			orgId: input.orgId,
			channelId: channel!.id,
			pubkey: creator.pubkey,
			authorKind: creator.kind,
			kind: "channel_create",
			content: title,
			tags: [],
			sig: null,
			authoredAt: new Date(),
		});
		return channel!;
	});
}

export async function channelByKey(orgId: string, key: string): Promise<Channel | undefined> {
	return db.query.channels.findFirst({
		where: and(eq(channels.orgId, orgId), eq(channels.key, key)),
	});
}

export async function channelById(orgId: string, id: string): Promise<Channel | undefined> {
	if (!UUID.test(id)) return undefined;
	return db.query.channels.findFirst({
		where: and(eq(channels.orgId, orgId), eq(channels.id, id)),
	});
}

/** Insert a membership row if absent. Returns whether it was newly created. */
async function addMember(
	tx: Executor,
	orgId: string,
	channelId: string,
	member: { pubkey: string; displayName: string; kind?: string },
): Promise<boolean> {
	const inserted = await tx
		.insert(channelMembers)
		.values({
			orgId,
			channelId,
			pubkey: member.pubkey.toLowerCase(),
			kind: member.kind ?? "human",
			displayName: member.displayName,
		})
		.onConflictDoNothing({ target: [channelMembers.channelId, channelMembers.pubkey] })
		.returning({ id: channelMembers.id });
	return inserted.length > 0;
}

/**
 * Opening a channel is joining it.
 *
 * Idempotent, and only the first join writes a `join` event — reloading the page
 * must not spam the log. On a rejoin the row's `lastSeenAt` is refreshed so
 * presence stays honest.
 */
export async function joinChannel(
	orgId: string,
	channelId: string,
	member: { pubkey: string; displayName: string; kind?: "human" | "agent" },
): Promise<{ joined: boolean }> {
	const pubkey = member.pubkey.toLowerCase();
	if (!PUBKEY.test(pubkey)) throw new HarborError("Malformed public key.");

	const joined = await db.transaction(async (tx) => {
		const isNew = await addMember(tx, orgId, channelId, { ...member, pubkey });
		if (isNew) {
			await appendDurable(tx, {
				orgId,
				channelId,
				pubkey,
				authorKind: member.kind ?? "human",
				kind: "join",
				content: member.displayName,
				tags: [],
				sig: null,
				authoredAt: new Date(),
			});
		} else {
			await tx
				.update(channelMembers)
				.set({ lastSeenAt: new Date() })
				.where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.pubkey, pubkey)));
		}
		return isNew;
	});

	await notifyChat(orgId, channelId, joined ? "join" : "seen");
	return { joined };
}

export async function memberOf(
	channelId: string,
	pubkey: string,
): Promise<ChannelMember | undefined> {
	return db.query.channelMembers.findFirst({
		where: and(
			eq(channelMembers.channelId, channelId),
			eq(channelMembers.pubkey, pubkey.toLowerCase()),
		),
	});
}

/**
 * May this caller read this channel?
 *
 * The org boundary is the hard one and is already enforced upstream (the channel
 * was looked up scoped to the connection's org). Within an org:
 *
 *   - `group` / `task` channels follow the unlisted-document model sessions
 *     established: possession of the key is the grant, so anyone in the org who
 *     reached the URL may read.
 *   - `direct` channels are private, so a caller must present a pubkey that is a
 *     member. This is the "check membership before you can subscribe" rule,
 *     applied to the one channel kind where it matters.
 *
 * See Known Limitations in CHAT.md: for a `direct` channel this trusts the caller
 * to present its own pubkey, which the org boundary bounds but does not yet prove
 * per-user. Writes are unaffected — those always require a signature.
 */
export async function mayRead(channel: Channel, callerPubkey?: string): Promise<boolean> {
	if (channel.kind !== "direct") return true;
	if (!callerPubkey || !PUBKEY.test(callerPubkey)) return false;
	return Boolean(await memberOf(channel.id, callerPubkey));
}

export async function membersOf(channelId: string): Promise<ChannelMember[]> {
	return db
		.select()
		.from(channelMembers)
		.where(eq(channelMembers.channelId, channelId))
		.orderBy(asc(channelMembers.joinedAt));
}

export async function listChannels(
	orgId: string,
	opts: { memberPubkey?: string; limit?: number } = {},
): Promise<Channel[]> {
	const limit = opts.limit ?? 50;
	if (opts.memberPubkey) {
		// Channels this principal is actually in — the agent-facing listing, so an
		// agent never sees rooms it was not added to.
		const rows = await db
			.select({ channel: channels })
			.from(channelMembers)
			.innerJoin(channels, eq(channelMembers.channelId, channels.id))
			.where(
				and(
					eq(channelMembers.orgId, orgId),
					eq(channelMembers.pubkey, opts.memberPubkey.toLowerCase()),
				),
			)
			.orderBy(desc(channels.lastActivityAt))
			.limit(limit);
		return rows.map((r) => r.channel);
	}
	return db
		.select()
		.from(channels)
		.where(eq(channels.orgId, orgId))
		.orderBy(desc(channels.lastActivityAt))
		.limit(limit);
}

// ---------------------------------------------------------------------------
// The event log
// ---------------------------------------------------------------------------

interface DurableInput {
	orgId: string;
	channelId: string;
	id?: string;
	pubkey: string;
	authorKind: string;
	kind: EventKind;
	content: string;
	tags: string[][];
	sig: string | null;
	authoredAt: Date;
}

/**
 * Append one durable event, assigning its per-channel `seq`.
 *
 * The `seq` comes from a row-locked counter on the channel, exactly as sessions
 * allocates a prompt's number and for the same reason: `max(seq)+1` lets two
 * concurrent posts read the same maximum and collide, silently dropping a message
 * the instant two people (or two agents) speak at once. `UPDATE ... RETURNING`
 * serialises them.
 *
 * A server-authored event has no `id` of its own, so one is derived from the same
 * canonical hash a signed event uses — the log stays uniformly content-addressed.
 * The insert is `ON CONFLICT DO NOTHING` on that id, so a redelivered event is a
 * no-op; a `seq` burned on the rare duplicate is a harmless gap, since ordering
 * needs monotonicity, not contiguity.
 */
async function appendDurable(
	tx: Executor,
	input: DurableInput,
): Promise<{ event: ChatEvent; duplicate: boolean }> {
	const id =
		input.id ??
		(await computeId({
			pubkey: input.pubkey,
			channelId: input.channelId,
			kind: input.kind,
			createdAt: Math.floor(input.authoredAt.getTime() / 1000),
			content: input.content,
			tags: input.tags,
		}));

	const [channel] = await tx
		.update(channels)
		.set({ nextSeq: raw`${channels.nextSeq} + 1`, lastActivityAt: new Date() })
		.where(and(eq(channels.id, input.channelId), eq(channels.orgId, input.orgId)))
		.returning({ seq: channels.nextSeq });
	if (!channel) throw new HarborError("No such channel.");
	const seq = channel.seq - 1;

	const inserted = await tx
		.insert(chatEvents)
		.values({
			id,
			orgId: input.orgId,
			channelId: input.channelId,
			pubkey: input.pubkey,
			authorKind: input.authorKind,
			kind: input.kind,
			seq,
			content: input.content,
			tags: input.tags,
			sig: input.sig,
			authoredAt: input.authoredAt,
		})
		.onConflictDoNothing({ target: chatEvents.id })
		.returning();

	if (inserted.length === 0) {
		const existing = await tx.query.chatEvents.findFirst({ where: eq(chatEvents.id, id) });
		return { event: existing!, duplicate: true };
	}
	return { event: inserted[0]!, duplicate: false };
}

export type IngestResult =
	| { ok: true; ephemeral: true }
	| { ok: true; ephemeral: false; event: ChatEvent; duplicate: boolean };

/**
 * The one door every client-authored event comes through.
 *
 * Everything here is a refusal the caller must not be able to skip by reaching a
 * different endpoint — which is why there is exactly one of these and the REST and
 * MCP layers are thin wrappers over it.
 */
export async function ingestEvent(ctx: ConnContext, event: SignedEvent): Promise<IngestResult> {
	if (!EVENT_KINDS.includes(event.kind)) throw new HarborError(`Unknown event kind "${event.kind}".`);
	if (!CLIENT_KINDS.has(event.kind)) {
		throw new HarborError(`Events of kind "${event.kind}" are authored by the server, not clients.`);
	}
	const maxContent = setting("chatMaxContentChars");
	if (typeof event.content !== "string" || event.content.length > maxContent) {
		throw new HarborError(`Content is required and must be at most ${maxContent} characters.`);
	}
	if (!Array.isArray(event.tags)) throw new HarborError("Tags must be an array.");

	// The signature and id are checked before the database is touched at all — an
	// unverifiable event should cost one hash and one curve op, not a query.
	const verified = await verifyEvent(event);
	if (!verified.ok) throw new HarborError(`Rejected: ${verified.reason}`);

	// The author must be a principal in the org the CONNECTION resolved to. This
	// is the line that stops a key registered in another tenant from posting here,
	// and it is why ingest takes `ctx.orgId` rather than reading it off the event.
	const author = await principalByPubkey(ctx.orgId, event.pubkey);
	if (!author) throw new HarborError("Unknown author. Register your key as a principal first.");

	const channel = await channelById(ctx.orgId, event.channelId);
	if (!channel) throw new HarborError("No such channel.");

	// Membership is checked before persist AND before fan-out. A non-member cannot
	// write to a channel, and — because the same check gates the stream — cannot
	// read one either.
	const membership = await memberOf(channel.id, author.pubkey);
	if (!membership) throw new HarborError("You are not a member of this channel.");

	const authoredAt = new Date((event.createdAt || Math.floor(Date.now() / 1000)) * 1000);

	if (isEphemeral(event.kind)) {
		// Typing and presence are wake signals, never rows. They carry who, so a
		// listener can render "X is typing" without a re-read.
		await notifyChat(ctx.orgId, channel.id, event.kind, {
			pubkey: author.pubkey,
			displayName: author.displayName,
		});
		return { ok: true, ephemeral: true };
	}

	const stored = await db.transaction(async (tx) => {
		const result = await appendDurable(tx, {
			orgId: ctx.orgId,
			channelId: channel.id,
			id: event.id,
			pubkey: author.pubkey,
			authorKind: author.kind,
			kind: event.kind,
			content: event.content,
			tags: event.tags,
			sig: event.sig,
			authoredAt,
		});
		// The author has, by definition, seen their own message: advance their read
		// cursor so it never counts against their own unread.
		if (!result.duplicate) {
			await tx
				.update(channelMembers)
				.set({ lastSeenSeq: result.event.seq, lastSeenAt: new Date() })
				.where(
					and(
						eq(channelMembers.channelId, channel.id),
						eq(channelMembers.pubkey, author.pubkey),
					),
				);
		}
		return result;
	});

	if (!stored.duplicate) await notifyChat(ctx.orgId, channel.id, event.kind, undefined, stored.event.seq);
	return { ok: true, ephemeral: false, event: stored.event, duplicate: stored.duplicate };
}

/**
 * The full conversation, oldest first — what a page renders on first paint.
 *
 * System and membership events are included so the room reads as a history
 * ("X joined") rather than only the messages. A caller that wants messages only
 * can filter on `kind`.
 */
export async function eventsOf(
	orgId: string,
	channelId: string,
	opts: { sinceSeq?: number; limit?: number } = {},
): Promise<ChatEvent[]> {
	const conditions = [eq(chatEvents.orgId, orgId), eq(chatEvents.channelId, channelId)];
	if (opts.sinceSeq !== undefined) conditions.push(gt(chatEvents.seq, opts.sinceSeq));
	return db
		.select()
		.from(chatEvents)
		.where(and(...conditions))
		.orderBy(asc(chatEvents.seq))
		.limit(opts.limit ?? 500);
}

/**
 * Read a channel as a member, advancing that member's cursor.
 *
 * The batch primitive: an agent that was mentioned three times
 * while it was busy pulls all three at once here — everything past its cursor in
 * one call — instead of one event per turn. The cursor advances to the last event
 * returned, so the next read is only what is genuinely new.
 */
export async function readChannel(
	orgId: string,
	channelId: string,
	pubkey: string,
): Promise<{ events: ChatEvent[]; cursor: number }> {
	const member = await memberOf(channelId, pubkey);
	if (!member) throw new HarborError("You are not a member of this channel.");

	const rows = await eventsOf(orgId, channelId, { sinceSeq: member.lastSeenSeq });
	const cursor = rows.length > 0 ? rows[rows.length - 1]!.seq : member.lastSeenSeq;
	if (cursor > member.lastSeenSeq) {
		await db
			.update(channelMembers)
			.set({ lastSeenSeq: cursor, lastSeenAt: new Date() })
			.where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.pubkey, pubkey.toLowerCase())));
	}
	return { events: rows, cursor };
}

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

/**
 * Wake the channel's listeners.
 *
 * A dedicated NOTIFY channel (`harbor_chat`) separate from the coordination
 * dashboard's `harbor_changes`, so a busy backlog does not refresh every open
 * chat and vice versa. The payload names the channel and (for durable events) the
 * new `seq` so a listener can fetch exactly what it is missing; ephemeral events
 * carry their small actor inline because there is no row to fetch. Kept well under
 * NOTIFY's 8000-byte cap — the message body is never in here.
 */
export async function notifyChat(
	orgId: string,
	channelId: string,
	kind: string,
	actor?: { pubkey: string; displayName: string },
	seq?: number,
): Promise<void> {
	try {
		const payload = JSON.stringify({ orgId, channelId, kind, seq, actor });
		await publish("harbor_chat", payload);
	} catch (error) {
		console.error("[chat notify] ignored:", error);
	}
}
