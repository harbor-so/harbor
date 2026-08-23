// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { NextResponse } from "next/server";
import { joinSession, sessionByKey } from "../../../../lib/sessions.js";
import { enqueueSessionPrompt } from "../../../../lib/session-runner.js";
import { currentSession } from "../../../../lib/session.js";
import { assertNever } from "../../../../sandbox/decisions.js";

/**
 * Add a prompt to a session's queue.
 *
 * The author comes from the signed-in viewer, never from the request body — a
 * client that can name its own author can put words in a colleague's mouth, and
 * attribution nobody can trust is worse than none.
 *
 * Through `enqueueSessionPrompt`, never `queuePrompt` directly. The capped
 * front door used to have zero production callers — every path, including this
 * human-facing one, called the raw insert and bypassed both the queue-depth
 * cap and the promptability check, so the cap was implemented, documented,
 * tested and unreachable. The refusal statuses below are the cap's whole
 * point: 429 for a full queue is what a well-behaved client backs off on.
 */
export async function POST(request: Request, { params }: { params: Promise<{ key: string }> }) {
	const viewer = await currentSession();
	if (!viewer) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

	const { key } = await params;
	const session = await sessionByKey(viewer.orgId, key);
	if (!session) return NextResponse.json({ error: "No such session." }, { status: 404 });

	const body = (await request.json().catch(() => ({}))) as { body?: string };
	const author = viewer.userName ?? "someone";

	// Posting is also joining. Somebody who was sent the link and immediately
	// typed should appear in the room, not be invisible until they reload.
	await joinSession(session.id, viewer.orgId, author, "human");

	const outcome = await enqueueSessionPrompt({
		orgId: viewer.orgId,
		sessionId: session.id,
		author,
		authorKind: "human",
		// The viewer's git identity, when their sign-in exposes one. This is the
		// difference between a commit authored by the person who asked and a
		// bot-attributed one; it comes from the session cookie, never the body.
		authorEmail: viewer.userEmail,
		// Also from the cookie, never the body, and for a sharper reason than the
		// email: this is the identity whose OAuth token opens the pull request for
		// this session's work. A client that could name it could have Harbor open a
		// pull request as a colleague.
		authorUserId: viewer.userId,
		body: body.body ?? "",
	});

	if (outcome.ok) return NextResponse.json({ ok: true, seq: outcome.seq });

	// Exhaustive, no default: a new refusal reason is a compile error here, not
	// a silently mis-mapped status code.
	switch (outcome.reason) {
		case "queue_full":
			return NextResponse.json(
				{ error: outcome.message, reason: outcome.reason, depth: outcome.depth, cap: outcome.cap },
				{ status: 429 },
			);
		case "session_unknown":
			return NextResponse.json({ error: outcome.message, reason: outcome.reason }, { status: 404 });
		case "session_not_promptable":
		case "prompt_rejected":
			return NextResponse.json({ error: outcome.message, reason: outcome.reason }, { status: 400 });
	}
	return assertNever(outcome.reason, "enqueue refusal");
}
