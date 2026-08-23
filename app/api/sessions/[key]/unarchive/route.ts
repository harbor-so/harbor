// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@core/schema/index.js";
import { sessions } from "@core/schema/schema.js";
import { resolveSession } from "../../../../lib/session-access.js";
import { notifyChange } from "@core/kernel/work.js";

/**
 * Take a session back out of the archive.
 *
 * The status it returns to is **derived, not remembered**, and that is a
 * deliberate refusal to add a column. Storing `status_before_archive` would be
 * one more piece of state that can disagree with reality — a session archived
 * while a turn was in flight would come back `active` with nothing running, and
 * the tick would either wedge on it or quietly correct it, which is a worse
 * outcome than the small honest approximation here.
 *
 * So: a session that has produced events comes back `completed`, and one that
 * never ran comes back `created`. Both are promptable, which is the only
 * property anybody was actually reaching for. If it turns out somebody wanted
 * the exact prior status, that is a feature with a real design, not a column
 * added on the way past.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ key: string }> }) {
	const { key } = await params;
	const access = await resolveSession(request, key);
	if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

	if (access.session.status !== "archived") {
		return NextResponse.json({
			key,
			status: access.session.status,
			changed: false,
			note: "This session is not archived.",
		});
	}

	// `next_event_seq` starts at 1, so "has ever emitted an event" is `> 1`. The
	// off-by-one matters: `> 0` is true for a session created a second ago and
	// would report every one of them as `completed`.
	const status = access.session.nextEventSeq > 1 ? "completed" : "created";

	await db
		.update(sessions)
		.set({ status, lastActivityAt: new Date() })
		.where(and(eq(sessions.id, access.session.id), eq(sessions.orgId, access.orgId)));
	await notifyChange(access.orgId, "session_unarchived");

	return NextResponse.json({ key, status, changed: true });
}
