// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@core/schema/index.js";
import { sessions } from "@core/schema/schema.js";
import { resolveSession } from "../../../../lib/session-access.js";
import { notifyChange } from "@core/kernel/work.js";

/**
 * File a session away.
 *
 * `promptability` has refused prompts to archived sessions since it was written,
 * with a message that says "unarchive it, or start a new session" — and there
 * was nothing that could archive one and nothing that could unarchive one. The
 * status existed, the refusal existed, and the door had no handle on either
 * side.
 *
 * Archiving is a **deliberate human act**, which is why it is not undone by
 * typing into the room: a room that quietly reopens because somebody replied to
 * an old link is a room that was never really filed away. Undoing it is
 * `POST /unarchive`, a second deliberate act.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ key: string }> }) {
	const { key } = await params;
	const access = await resolveSession(request, key);
	if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

	if (access.session.status === "archived") {
		// Idempotent rather than a conflict: two clicks on a slow connection is the
		// common case, and an error there reads as "it did not work".
		return NextResponse.json({ key, status: "archived", changed: false });
	}

	await db
		.update(sessions)
		.set({ status: "archived", lastActivityAt: new Date() })
		.where(and(eq(sessions.id, access.session.id), eq(sessions.orgId, access.orgId)));
	await notifyChange(access.orgId, "session_archived");

	return NextResponse.json({ key, status: "archived", changed: true });
}
