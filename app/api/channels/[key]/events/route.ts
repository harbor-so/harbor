// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { NextResponse } from "next/server";
import { channelByKey, eventsOf, ingestEvent, mayRead, membersOf } from "../../../../lib/chat.js";
import { resolveConn } from "../../../../lib/conn.js";
import type { SignedEvent } from "../../../../lib/signing.js";

export const dynamic = "force-dynamic";

/**
 * Read a channel's history, oldest first.
 *
 * `?since=<seq>` returns only what is new, which is what a live client fetches
 * after the stream tells it a higher seq exists — the message body never rides the
 * NOTIFY, so the client comes here for it. `?as=<pubkey>` names the caller so a
 * private (direct) channel can check membership before returning a single row.
 */
export async function GET(request: Request, { params }: { params: Promise<{ key: string }> }) {
	const conn = await resolveConn(request);
	if (!conn) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

	const { key } = await params;
	const channel = await channelByKey(conn.orgId, key);
	if (!channel) return NextResponse.json({ error: "No such channel." }, { status: 404 });

	const url = new URL(request.url);
	const as = url.searchParams.get("as") ?? undefined;
	if (!(await mayRead(channel, as))) {
		return NextResponse.json({ error: "Not a member of this channel." }, { status: 403 });
	}

	const sinceRaw = url.searchParams.get("since");
	const sinceSeq = sinceRaw ? Number.parseInt(sinceRaw, 10) : undefined;
	const [events, members] = await Promise.all([
		eventsOf(conn.orgId, channel.id, { sinceSeq: Number.isFinite(sinceSeq) ? sinceSeq : undefined }),
		membersOf(channel.id),
	]);

	return NextResponse.json({
		channel: { id: channel.id, key: channel.key, kind: channel.kind, title: channel.title },
		// A pubkey → who-they-are map so a client can attribute a message without a
		// second round trip. It is public information; the private key stays home.
		members: members.map((m) => ({ pubkey: m.pubkey, displayName: m.displayName, kind: m.kind })),
		events,
	});
}

/**
 * Ingest one signed event.
 *
 * The same door for a browser and an agent — both POST a `SignedEvent` here and
 * both go through `ingestEvent`, so the signature check, the org binding and the
 * membership gate are applied once, in one place, to every writer.
 *
 * The URL key names the channel; the event body carries its own `channelId`. We
 * pin the body to the URL so a client cannot present a signature for one channel
 * while posting to another.
 */
export async function POST(request: Request, { params }: { params: Promise<{ key: string }> }) {
	const conn = await resolveConn(request);
	if (!conn) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

	const { key } = await params;
	const channel = await channelByKey(conn.orgId, key);
	if (!channel) return NextResponse.json({ error: "No such channel." }, { status: 404 });

	const event = (await request.json().catch(() => null)) as SignedEvent | null;
	if (!event || typeof event !== "object") {
		return NextResponse.json({ error: "A signed event is required." }, { status: 400 });
	}
	if (event.channelId !== channel.id) {
		return NextResponse.json(
			{ error: "Event channelId does not match this channel." },
			{ status: 400 },
		);
	}

	try {
		const result = await ingestEvent({ orgId: conn.orgId }, event);
		return NextResponse.json(
			result.ephemeral
				? { ok: true, ephemeral: true }
				: { ok: true, ephemeral: false, seq: result.event.seq, duplicate: result.duplicate },
		);
	} catch (error) {
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : "Rejected." },
			{ status: 400 },
		);
	}
}
