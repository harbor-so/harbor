// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { NextResponse } from "next/server";
import { createChannel, listChannels } from "../../lib/chat.js";
import { resolveConn } from "../../lib/conn.js";

/**
 * List the caller's channels, or create one.
 *
 * A browser session lists every channel in the org (the dashboard view); an agent
 * with a key lists only the channels its pubkey is a member of, passed as `?as=`.
 * That difference is intentional — the dashboard is an operator surface, an
 * agent should only see rooms it was actually added to.
 */
export async function GET(request: Request) {
	const conn = await resolveConn(request);
	if (!conn) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

	const as = new URL(request.url).searchParams.get("as") ?? undefined;
	const channels = await listChannels(conn.orgId, { memberPubkey: as });
	return NextResponse.json({
		channels: channels.map((c) => ({
			key: c.key,
			id: c.id,
			kind: c.kind,
			title: c.title,
			lastActivityAt: c.lastActivityAt,
		})),
	});
}

export async function POST(request: Request) {
	const conn = await resolveConn(request);
	if (!conn) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

	const body = (await request.json().catch(() => ({}))) as {
		title?: string;
		kind?: "group" | "direct" | "task";
		createdBy?: string;
		members?: Array<{ pubkey: string; displayName: string; kind?: "human" | "agent" }>;
	};
	if (!body.title) return NextResponse.json({ error: "title is required." }, { status: 400 });
	if (!body.createdBy) {
		return NextResponse.json({ error: "createdBy (your pubkey) is required." }, { status: 400 });
	}

	try {
		const channel = await createChannel({
			orgId: conn.orgId,
			title: body.title,
			kind: body.kind,
			createdBy: body.createdBy,
			members: body.members,
		});
		return NextResponse.json({ ok: true, key: channel.key, id: channel.id });
	} catch (error) {
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : "Could not create channel." },
			{ status: 400 },
		);
	}
}
