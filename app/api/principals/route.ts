// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { NextResponse } from "next/server";
import { registerPrincipal } from "../../lib/chat.js";
import { resolveConn } from "../../lib/conn.js";

/**
 * Announce a public key as a principal in the caller's org.
 *
 * A browser calls this once, after generating its keypair, to make its identity
 * resolvable; an agent calls it to register the key it will sign with. The `kind`
 * is decided by HOW the caller authenticated, not by what it claims: a session is
 * a human, a bearer key is an agent. That keeps "is this an agent?" a fact about
 * the connection rather than a self-assertion in the body.
 *
 * The private key is never in this request — only the public half, which is the
 * identity.
 */
export async function POST(request: Request) {
	const conn = await resolveConn(request);
	if (!conn) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

	const body = (await request.json().catch(() => ({}))) as {
		pubkey?: string;
		displayName?: string;
	};
	if (!body.pubkey) return NextResponse.json({ error: "pubkey is required." }, { status: 400 });

	const kind = conn.via === "key" ? "agent" : "human";
	const displayName = body.displayName?.trim() || conn.userName || (kind === "agent" ? "agent" : "someone");

	try {
		const principal = await registerPrincipal({
			orgId: conn.orgId,
			pubkey: body.pubkey,
			kind,
			displayName,
			userId: conn.via === "session" ? conn.userId : undefined,
		});
		return NextResponse.json({
			ok: true,
			principal: { pubkey: principal.pubkey, kind: principal.kind, displayName: principal.displayName },
		});
	} catch (error) {
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : "Could not register." },
			{ status: 400 },
		);
	}
}
