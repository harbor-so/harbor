// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { NextResponse } from "next/server";
import { channelByKey, joinChannel, mayRead } from "../../../../lib/chat.js";
import { resolveConn } from "../../../../lib/conn.js";

/**
 * Join a channel by its key.
 *
 * Opening a group channel's link should put you in the room, so this is what the
 * SDK and an agent call after discovering a channel. For a browser the room page
 * joins on the server as it renders; this endpoint is the agent-facing equivalent.
 * Idempotent — joining twice is the common case, not an error.
 */
export async function POST(request: Request, { params }: { params: Promise<{ key: string }> }) {
	const conn = await resolveConn(request);
	if (!conn) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

	const { key } = await params;
	const channel = await channelByKey(conn.orgId, key);
	if (!channel) return NextResponse.json({ error: "No such channel." }, { status: 404 });

	const body = (await request.json().catch(() => ({}))) as {
		pubkey?: string;
		displayName?: string;
		kind?: "human" | "agent";
	};
	if (!body.pubkey) return NextResponse.json({ error: "pubkey is required." }, { status: 400 });

	// A direct channel has a fixed roster: you cannot add yourself to someone
	// else's DM by knowing its key. Group and task channels are link-joinable.
	if (channel.kind === "direct" && !(await mayRead(channel, body.pubkey))) {
		return NextResponse.json({ error: "This channel is private." }, { status: 403 });
	}

	try {
		const result = await joinChannel(conn.orgId, channel.id, {
			pubkey: body.pubkey,
			displayName: body.displayName?.trim() || conn.userName || "someone",
			kind: body.kind ?? (conn.via === "key" ? "agent" : "human"),
		});
		return NextResponse.json({ ok: true, id: channel.id, ...result });
	} catch (error) {
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : "Could not join." },
			{ status: 400 },
		);
	}
}
