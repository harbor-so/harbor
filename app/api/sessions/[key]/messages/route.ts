// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { NextResponse } from "next/server";
import { resolveSession } from "../../../../lib/session-access.js";
import { promptsOf } from "../../../../lib/sessions.js";

/**
 * The conversation: every prompt, in order, with its author intact.
 *
 * Distinct from `/events`, and the distinction is the one the schema makes.
 * `session_events` is the agent's *timeline* — tool calls, messages, lifecycle —
 * and is compacted as it grows. `session_prompts` is what *people said*, is
 * never compacted, and is the thing somebody scrolls back through six months
 * later to answer "who asked for this".
 *
 * `author` and `author_kind` are always present because the column is NOT NULL
 * and is stamped from the signed-in viewer rather than the request body. The
 * queue position is visible too: a caller can see that #3 is still queued behind
 * #2, which is the whole reason input queues rather than interleaving.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ key: string }> }) {
	const { key } = await params;
	const access = await resolveSession(request, key);
	if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

	const prompts = await promptsOf(access.session.id);
	return NextResponse.json({
		messages: prompts.map((prompt) => ({
			id: prompt.id,
			seq: prompt.seq,
			author: prompt.author,
			author_kind: prompt.authorKind,
			body: prompt.body,
			status: prompt.status,
			created_at: prompt.createdAt?.toISOString() ?? null,
			delivered_at: prompt.deliveredAt?.toISOString() ?? null,
		})),
	});
}
