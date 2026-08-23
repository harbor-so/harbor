// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { NextResponse } from "next/server";
import { resolveSession } from "../../../../lib/session-access.js";
import { participantsOf } from "../../../../lib/sessions.js";

/**
 * Who is in the room — humans and agents in one list, because they are one row
 * shape.
 *
 * Membership has exactly one event: opening the link. There is no invite, no
 * owner and no removal, which is why this reads as a list rather than as an
 * access-control surface. `last_seen_at` is a fact about attention, not a
 * liveness flag — computing "online" at read time is the same discipline
 * `agent_presence` uses, and for the same reason: the participant who crashed is
 * exactly the one who will not clear their own flag.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ key: string }> }) {
	const { key } = await params;
	const access = await resolveSession(request, key);
	if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

	const rows = await participantsOf(access.session.id);
	return NextResponse.json({
		participants: rows.map((row) => ({
			participant: row.participant,
			kind: row.kind,
			joined_at: row.joinedAt?.toISOString() ?? null,
			last_seen_at: row.lastSeenAt?.toISOString() ?? null,
		})),
	});
}
