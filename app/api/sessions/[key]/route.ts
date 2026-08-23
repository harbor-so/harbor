// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { NextResponse } from "next/server";
import { snapshotSession } from "../../../lib/session-events.js";
import { resolveSession } from "../../../lib/session-access.js";

/**
 * One session, as a snapshot.
 *
 * The same document the stream emits as its first frame, available without
 * holding a stream open — which is what a poller, a CLI, a Slack unfurl or a
 * server-rendered page actually wants. It carries `snapshot_through_seq`, so a
 * client that fetches this and then attaches to `?after=<that>` gets the
 * documented no-loss guarantee without a second snapshot.
 *
 * Deliberately not a bare `sessions` row: the row alone answers almost nothing a
 * caller has ever wanted, and building the interesting parts twice is how the
 * page view and the stream view drift.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ key: string }> }) {
	const { key } = await params;
	const access = await resolveSession(request, key);
	if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

	const snapshot = await snapshotSession(access.orgId, key);
	// `resolveSession` already found the row, so a null here means it was deleted
	// between the two reads. 404 is still the honest answer.
	if (!snapshot) return NextResponse.json({ error: "No such session." }, { status: 404 });

	return NextResponse.json(snapshot);
}
