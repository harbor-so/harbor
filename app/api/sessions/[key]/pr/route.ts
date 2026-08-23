// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@core/schema/index.js";
import { artifacts } from "@core/schema/schema.js";
import { scmIdentitySummary } from "../../../../git/credentials.js";
import { resolveSession } from "../../../../lib/session-access.js";
import { currentSession } from "../../../../lib/session.js";

/**
 * The pull request this session produced — or the reason there isn't one.
 *
 * The reason is the point. "No pull request" has several causes with completely
 * different remedies, and a route that returns 404 for all of them sends
 * everybody to the same wrong place:
 *
 *  - nothing has been pushed yet → wait, or prompt it;
 *  - a branch was pushed and no PR opened → almost always a missing
 *    source-control identity, which the requester fixes in Settings in ten
 *    seconds once somebody tells them;
 *  - it was opened → here it is, with whether it merged.
 *
 * So this returns 200 with a `state` in every case except an unknown session.
 * The branch artifact is included when there is one, because its compare URL is
 * the thing a person clicks when Harbor refused to open the PR itself.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ key: string }> }) {
	const { key } = await params;
	const access = await resolveSession(request, key);
	if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

	const [pullRequest] = await db
		.select()
		.from(artifacts)
		.where(
			and(eq(artifacts.sessionId, access.session.id), eq(artifacts.kind, "pull_request")),
		)
		.orderBy(desc(artifacts.createdAt))
		.limit(1);

	if (pullRequest) {
		return NextResponse.json({
			state: pullRequest.mergedAt ? "merged" : "open",
			pull_request: {
				title: pullRequest.title,
				url: pullRequest.url,
				payload: pullRequest.payload,
				merged_at: pullRequest.mergedAt?.toISOString() ?? null,
				created_at: pullRequest.createdAt.toISOString(),
			},
		});
	}

	const [branch] = await db
		.select()
		.from(artifacts)
		.where(and(eq(artifacts.sessionId, access.session.id), eq(artifacts.kind, "branch")))
		.orderBy(desc(artifacts.createdAt))
		.limit(1);

	if (!branch) {
		return NextResponse.json({
			state: "no_branch",
			reason:
				"Nothing has been pushed from this session yet, so there is nothing to open a "
				+ "pull request from.",
		});
	}

	// A branch but no pull request. The overwhelmingly common cause is that the
	// requester has no source-control identity, so Harbor pushed and handed back a
	// compare URL rather than opening the PR as the bot — which it will not do,
	// because a bot-authored PR can be approved by the person who asked for it.
	const viewer = await currentSession();
	const scm = viewer?.userId ? await scmIdentitySummary(viewer.userId) : null;

	return NextResponse.json({
		state: "branch_only",
		branch: {
			title: branch.title,
			url: branch.url,
			payload: branch.payload,
			created_at: branch.createdAt.toISOString(),
		},
		reason: scm?.connected
			? "A branch was pushed and no pull request has been recorded for it yet."
			: "A branch was pushed but no pull request was opened. Harbor opens pull requests "
				+ "with the requesting person's own token — GitHub does not let an author approve "
				+ "their own pull request, which is what stops agent code being merged unreviewed "
				+ "— and it will not fall back to opening one as the bot. Connect a source-control "
				+ "identity in Settings, or open it by hand from the compare URL above.",
	});
}
