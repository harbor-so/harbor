// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@core/schema/index.js";
import { sessions } from "@core/schema/schema.js";
import { resolveSession } from "../../../../lib/session-access.js";
import { currentSession } from "../../../../lib/session.js";
import { notifyChange } from "@core/kernel/work.js";

/**
 * The button a person presses on realising they asked for the wrong thing.
 *
 * `stop` and `shutdown` are different verbs and this is `stop`: it interrupts
 * the turn and **leaves the box up**. Killing the container would throw away a
 * warm workspace at the exact moment the person is about to say what they
 * actually meant, and the follow-up prompt would pay a full cold boot for a
 * correction that took four words.
 *
 * The mechanism is `sessions.paused_reason`, whose column comment has always
 * said "set by a budget or by a human" while nothing in the product was the
 * human. Writing it here is enough: the commands SSE route derives the `stop`
 * bridge command from persisted state on every drain, so a box that was
 * disconnected at the moment of the click still receives it on reconnect. That
 * is the whole reason commands are derived rather than queued in memory.
 *
 * `{"stopped": false}` resumes. One route rather than two because pausing and
 * resuming are one column, and splitting them is how one of the pair ends up
 * without the org scope.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ key: string }> }) {
	const { key } = await params;
	const access = await resolveSession(request, key);
	if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

	let stopped = true;
	let note: string | null = null;
	if (request.headers.get("content-type")?.includes("application/json")) {
		try {
			const body = (await request.json()) as { stopped?: unknown; reason?: unknown };
			if (typeof body.stopped === "boolean") stopped = body.stopped;
			if (typeof body.reason === "string" && body.reason.trim()) note = body.reason.trim();
		} catch {
			return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
		}
	}

	// Attributed like every other human act on a session. `paused_reason` is shown
	// to whoever prompts next and "paused" tells them nothing they can act on;
	// "stopped by rin" tells them who to ask.
	const viewer = await currentSession();
	const who = viewer?.userName ?? "someone";
	const reason = stopped ? (note ?? `Stopped by ${who}.`) : null;

	await db
		.update(sessions)
		.set({ pausedReason: reason, lastActivityAt: new Date() })
		.where(and(eq(sessions.id, access.session.id), eq(sessions.orgId, access.orgId)));

	// The NOTIFY is what wakes the commands stream; without it the box waits for
	// its next keep-alive tick to notice.
	await notifyChange(access.orgId, "session_paused");

	return NextResponse.json({
		key,
		stopped,
		paused_reason: reason,
		note: stopped
			? "The agent is asked to wind up and keep its work. The sandbox stays up, so a "
				+ "follow-up prompt does not pay a cold boot."
			: "The queue resumes on the next tick.",
	});
}
