// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * A signed-chat demo you can watch happen.
 *
 * Two agents, each with their own Ed25519 keypair, register under one org API key
 * and hold a real conversation through the running server — every message signed
 * on the client and verified on ingest. It exists to prove the whole path end to
 * end (register → create → join → sign → send → read back), and to hand you a
 * channel URL you can open in a browser to talk to the agents yourself, which is
 * the human↔agent half.
 *
 * Needs the app running against the same database:
 *   DATABASE_URL=... npm run dev         # in one terminal
 *   DATABASE_URL=... npm run demo:chat   # in another
 */

import { db, sql } from "@core/schema/index.js";
import { apiKeys, orgs } from "@core/schema/schema.js";
import { ChatClient } from "@app/lib/chat-client.js";
import { generateKeypair } from "@app/lib/signing.js";
import { hashApiKey, mintApiKey } from "@core/kernel/keys.js";

const BASE = process.env.HARBOR_URL ?? "http://localhost:3000";

async function main() {
	// A throwaway org with one API key — the credential the agents authenticate
	// their connection with. Their identities are their keypairs, not this key.
	const [org] = await db.insert(orgs).values({ name: "Chat Demo" }).returning();
	const rawKey = mintApiKey();
	await db.insert(apiKeys).values({ orgId: org!.id, keyHash: hashApiKey(rawKey), label: "chat demo" });

	// `true` = extractable, because a script is a fine place to hold a key in the
	// clear; a browser would use a non-extractable one.
	const scoutKp = await generateKeypair(true);
	const builderKp = await generateKeypair(true);
	const scout = new ChatClient({ baseUrl: BASE, apiKey: rawKey, keypair: scoutKp, displayName: "scout" });
	const builder = new ChatClient({ baseUrl: BASE, apiKey: rawKey, keypair: builderKp, displayName: "builder" });

	await scout.register();
	await builder.register();

	const channel = await scout.createChannel({
		title: "agent room",
		members: [{ pubkey: builderKp.publicKeyHex, displayName: "builder", kind: "agent" }],
	});
	await builder.join(channel.key);

	// A real back-and-forth. Each send() signs locally, then posts; the server
	// rejects anything whose signature or id does not check out.
	await scout.send(channel, "found a flaky test in auth — taking a look");
	await builder.send(channel, "ack, I'll stay out of the auth module then");
	await scout.send(channel, "it was a race in token refresh. fixed, all yours");
	await builder.send(channel, "thanks — picking it up now");

	// Read the transcript back the way any member would.
	const events = await scout.fetchEvents(channel.key);
	const names: Record<string, string> = {
		[scoutKp.publicKeyHex]: "scout",
		[builderKp.publicKeyHex]: "builder",
	};

	console.log(`\n  channel "${channel.title}"  ${BASE}/c/${channel.key}\n`);
	for (const event of events as unknown as Array<{ kind: string; pubkey: string; content: string; seq: number }>) {
		const who = names[event.pubkey] ?? `${event.pubkey.slice(0, 8)}…`;
		if (event.kind === "message") console.log(`  #${event.seq}  ${who.padEnd(8)} ${event.content}`);
		else console.log(`  #${event.seq}  · ${who} ${event.kind.replace("_", " ")}`);
	}

	console.log(
		`\n  Open ${BASE}/c/${channel.key} in a browser to join as a human and\n` +
			"  message the agents — same room, same signed events.\n",
	);
}

main()
	.then(() => sql.end())
	.catch(async (error) => {
		console.error(error);
		await sql.end();
		process.exit(1);
	});
