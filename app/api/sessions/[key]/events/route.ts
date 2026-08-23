// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { NextResponse } from "next/server";
import { orgIdForKey } from "@core/kernel/auth.js";
import { currentSession } from "../../../../lib/session.js";
import { eventPage } from "../../../../lib/session-events.js";
import { sessionByKey } from "../../../../lib/sessions.js";
import { HarborError } from "@core/kernel/work.js";

/**
 * Page through a session's retained history.
 *
 * This is the endpoint the contract promised and nobody built: `truncated:
 * true` on a snapshot tells the client "the rest is fetched by page", and until
 * this route existed there was no page to fetch — a client that reconnected
 * after a busy 500-event window had a permanent hole it could not fill, while
 * the contract told it a fetch was available.
 *
 * Two cursors, both exclusive seqs: `?before=` walks backwards from a truncated
 * snapshot's first event; `?after=` walks forwards to fill a reconnect gap.
 * Both at once is a 400 — see `eventPage` for why. `limit` is clamped by
 * `eventPage` to `maxSnapshotEvents`, so a caller cannot ask this route for a
 * larger payload than the snapshot it is supplementing.
 *
 * Auth is byte-for-byte the stream route's: a presented credential is judged on
 * its own and never falls back to the browser's ambient session.
 */
export const dynamic = "force-dynamic";

function cursorParam(value: string | null): number | null | "invalid" {
	if (value === null || value === "") return null;
	if (!/^\d{1,15}$/.test(value)) return "invalid";
	return Number(value);
}

export async function GET(request: Request, { params }: { params: Promise<{ key: string }> }) {
	const { key } = await params;

	const authorization = request.headers.get("authorization");
	const orgId = authorization
		? await orgIdForKey(authorization)
		: ((await currentSession())?.orgId ?? null);
	if (!orgId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

	// Scoped by org: another tenant's key is indistinguishable from one never
	// minted, for the oracle reason the stream route states.
	const session = await sessionByKey(orgId, key);
	if (!session) return NextResponse.json({ error: "No such session." }, { status: 404 });

	const url = new URL(request.url);
	const before = cursorParam(url.searchParams.get("before"));
	const after = cursorParam(url.searchParams.get("after"));
	const limitRaw = cursorParam(url.searchParams.get("limit"));
	if (before === "invalid" || after === "invalid" || limitRaw === "invalid") {
		// Unlike the stream's resume cursor, a garbled value here IS a 400: this
		// is an explicit fetch, not an automatic reconnect, and a silent fallback
		// would hand back a page the caller did not ask for.
		return NextResponse.json(
			{ error: "Cursors and limit must be non-negative integers." },
			{ status: 400 },
		);
	}

	try {
		const page = await eventPage(orgId, session.id, {
			...(before !== null ? { before } : {}),
			...(after !== null ? { after } : {}),
			...(limitRaw !== null ? { limit: limitRaw } : {}),
		});
		return NextResponse.json(page);
	} catch (error) {
		if (error instanceof HarborError) {
			return NextResponse.json({ error: error.message }, { status: 400 });
		}
		throw error;
	}
}
