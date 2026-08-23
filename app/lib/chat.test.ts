// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Chat ingest tests, against real Postgres.
 *
 * The properties that matter are all ones a mock would wave through: a per-channel
 * sequence that survives two authors posting at once, a membership gate that
 * refuses a non-member before anything is stored, and a signature check that no
 * endpoint can skip. So these run against the same database the product does.
 */

import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, sql } from "@core/schema/index.js";
import { channels, chatEvents, orgs } from "@core/schema/schema.js";
import { generateKeypair, signEvent, type Keypair, type UnsignedEvent } from "./signing.js";
import {
	createChannel,
	eventsOf,
	ingestEvent,
	joinChannel,
	listChannels,
	readChannel,
	registerPrincipal,
} from "./chat.js";

let orgId: string;

async function principal(name: string, kind: "human" | "agent" = "human") {
	const kp = await generateKeypair();
	await registerPrincipal({ orgId, pubkey: kp.publicKeyHex, kind, displayName: name });
	return kp;
}

async function message(kp: Keypair, channelId: string, content: string, kind: UnsignedEvent["kind"] = "message") {
	return signEvent(
		{
			pubkey: kp.publicKeyHex,
			channelId,
			kind,
			createdAt: Math.floor(Date.now() / 1000),
			content,
			tags: [],
		},
		kp.privateKey,
	);
}

beforeEach(async () => {
	await sql`truncate table chat_events, channel_members, channels, principals, orgs cascade`;
	const [org] = await db.insert(orgs).values({ name: "Chat Org" }).returning();
	orgId = org!.id;
});

afterAll(async () => {
	await sql.end();
});

describe("principals", () => {
	it("registers a key and is idempotent on re-register", async () => {
		const kp = await generateKeypair();
		const first = await registerPrincipal({ orgId, pubkey: kp.publicKeyHex, displayName: "Ada" });
		const second = await registerPrincipal({ orgId, pubkey: kp.publicKeyHex, displayName: "Ada L." });
		expect(second.id).toBe(first.id);
		expect(second.displayName).toBe("Ada L.");
	});

	it("rejects a malformed public key", async () => {
		await expect(registerPrincipal({ orgId, pubkey: "nothex", displayName: "x" })).rejects.toThrow(
			/64 hex/,
		);
	});
});

describe("channels", () => {
	it("makes the creator a member and writes a channel_create event", async () => {
		const alice = await principal("Alice");
		const channel = await createChannel({ orgId, title: "General", createdBy: alice.publicKeyHex });
		const history = await eventsOf(orgId, channel.id);
		expect(history).toHaveLength(1);
		expect(history[0]!.kind).toBe("channel_create");
		const mine = await listChannels(orgId, { memberPubkey: alice.publicKeyHex });
		expect(mine.map((c) => c.id)).toContain(channel.id);
	});

	it("refuses to create a channel for an unregistered key", async () => {
		const stranger = await generateKeypair();
		await expect(
			createChannel({ orgId, title: "x", createdBy: stranger.publicKeyHex }),
		).rejects.toThrow(/register/i);
	});
});

describe("ingest", () => {
	it("accepts a signed message from a member and stamps author kind from the principal", async () => {
		const bot = await principal("Helper", "agent");
		const channel = await createChannel({ orgId, title: "Room", createdBy: bot.publicKeyHex });
		const event = await message(bot, channel.id, "on it");
		const result = await ingestEvent({ orgId }, event);
		expect(result.ephemeral).toBe(false);
		if (!result.ephemeral) {
			expect(result.event.content).toBe("on it");
			expect(result.event.authorKind).toBe("agent");
			expect(result.event.sig).toBe(event.sig);
		}
	});

	it("rejects an author who never registered", async () => {
		const alice = await principal("Alice");
		const channel = await createChannel({ orgId, title: "Room", createdBy: alice.publicKeyHex });
		const ghost = await generateKeypair();
		const event = await message(ghost, channel.id, "hi");
		await expect(ingestEvent({ orgId }, event)).rejects.toThrow(/unknown author/i);
	});

	it("rejects a registered principal who is not a member of the channel", async () => {
		const alice = await principal("Alice");
		const bob = await principal("Bob");
		const channel = await createChannel({ orgId, title: "Room", createdBy: alice.publicKeyHex });
		const event = await message(bob, channel.id, "let me in");
		await expect(ingestEvent({ orgId }, event)).rejects.toThrow(/not a member/i);
	});

	it("rejects a tampered event", async () => {
		const alice = await principal("Alice");
		const channel = await createChannel({ orgId, title: "Room", createdBy: alice.publicKeyHex });
		const event = await message(alice, channel.id, "real");
		await expect(ingestEvent({ orgId }, { ...event, content: "forged" })).rejects.toThrow(/rejected/i);
	});

	it("refuses a server-authored kind sent by a client", async () => {
		const alice = await principal("Alice");
		const channel = await createChannel({ orgId, title: "Room", createdBy: alice.publicKeyHex });
		const event = await message(alice, channel.id, "fake join", "join");
		await expect(ingestEvent({ orgId }, event)).rejects.toThrow(/authored by the server/i);
	});

	it("does not persist ephemeral typing events", async () => {
		const alice = await principal("Alice");
		const channel = await createChannel({ orgId, title: "Room", createdBy: alice.publicKeyHex });
		const before = await eventsOf(orgId, channel.id);
		const event = await message(alice, channel.id, "", "typing");
		const result = await ingestEvent({ orgId }, event);
		expect(result.ephemeral).toBe(true);
		const after = await eventsOf(orgId, channel.id);
		expect(after).toHaveLength(before.length);
	});

	it("dedupes a redelivered event by id", async () => {
		const alice = await principal("Alice");
		const channel = await createChannel({ orgId, title: "Room", createdBy: alice.publicKeyHex });
		const event = await message(alice, channel.id, "once");
		const first = await ingestEvent({ orgId }, event);
		const second = await ingestEvent({ orgId }, event);
		expect(second.ephemeral).toBe(false);
		if (!second.ephemeral && !first.ephemeral) {
			expect(second.duplicate).toBe(true);
			expect(second.event.seq).toBe(first.event.seq);
		}
		const rows = await db
			.select()
			.from(chatEvents)
			.where(and(eq(chatEvents.channelId, channel.id), eq(chatEvents.kind, "message")));
		expect(rows).toHaveLength(1);
	});

	it("gives concurrent posts from two authors distinct sequence numbers", async () => {
		const alice = await principal("Alice");
		const bob = await principal("Bob");
		const channel = await createChannel({ orgId, title: "Room", createdBy: alice.publicKeyHex });
		await joinChannel(orgId, channel.id, { pubkey: bob.publicKeyHex, displayName: "Bob" });

		const events = await Promise.all([
			message(alice, channel.id, "from alice"),
			message(bob, channel.id, "from bob"),
		]);
		// Fire both ingests at once; the seq counter must serialise them.
		const results = await Promise.all(events.map((e) => ingestEvent({ orgId }, e)));
		const seqs = results.map((r) => (r.ephemeral ? -1 : r.event.seq));
		expect(new Set(seqs).size).toBe(2);

		const [channelRow] = await db.select().from(channels).where(eq(channels.id, channel.id));
		// channel_create (1) + join (2) + two messages (3,4) => nextSeq is 5.
		expect(channelRow!.nextSeq).toBe(5);
	});
});

describe("readChannel batching", () => {
	it("returns everything past the member's cursor, then advances it", async () => {
		const alice = await principal("Alice");
		const bot = await principal("Watcher", "agent");
		const channel = await createChannel({ orgId, title: "Room", createdBy: alice.publicKeyHex });
		await joinChannel(orgId, channel.id, {
			pubkey: bot.publicKeyHex,
			displayName: "Watcher",
			kind: "agent",
		});

		// Three messages arrive while the agent is "busy".
		for (const text of ["one", "two", "three"]) {
			await ingestEvent({ orgId }, await message(alice, channel.id, text));
		}

		const first = await readChannel(orgId, channel.id, bot.publicKeyHex);
		const bodies = first.events.filter((e) => e.kind === "message").map((e) => e.content);
		// All three in one batch, not one per call.
		expect(bodies).toEqual(["one", "two", "three"]);

		// Nothing new since — the cursor advanced.
		const second = await readChannel(orgId, channel.id, bot.publicKeyHex);
		expect(second.events).toHaveLength(0);
		expect(second.cursor).toBe(first.cursor);
	});
});
