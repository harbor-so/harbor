// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { NextResponse } from "next/server";
import { assertRepoAccess } from "../../lib/repos.js";
import { createSession, listSessions } from "../../lib/sessions.js";
import { currentSession } from "../../lib/session.js";
import { viewerScmToken } from "../../lib/viewer-scm.js";
import { HarborError } from "@core/kernel/work.js";

export async function GET() {
	const viewer = await currentSession();
	if (!viewer) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
	return NextResponse.json({ sessions: await listSessions(viewer.orgId) });
}

export async function POST(request: Request) {
	const viewer = await currentSession();
	if (!viewer) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

	const body = (await request.json().catch(() => ({}))) as {
		title?: string;
		taskId?: string;
		repoIds?: unknown;
		baseBranch?: unknown;
	};
	const title = body.title?.trim();
	if (!title) return NextResponse.json({ error: "title is required." }, { status: 400 });

	const repoIds
		= Array.isArray(body.repoIds) && body.repoIds.every((id) => typeof id === "string")
			? (body.repoIds as string[])
			: [];

	// The access check happens HERE, before the session exists, and against the
	// requesting user's own token. `assertRepoAccess` re-asks rather than trusting
	// the fact that the repository is connected, because access is not permanent:
	// people leave teams and repositories go private, and a session created after
	// that would clone a repository its requester can no longer read.
	if (repoIds.length > 0) {
		const scm = await viewerScmToken(viewer);
		const token = scm.kind === "available" ? scm.token : null;
		try {
			for (const repoId of repoIds) {
				await assertRepoAccess(viewer.orgId, repoId, token);
			}
		} catch (error) {
			if (error instanceof HarborError) {
				return NextResponse.json({ error: error.message }, { status: 403 });
			}
			throw error;
		}
	}

	try {
		const created = await createSession({
			orgId: viewer.orgId,
			title,
			createdBy: viewer.userName ?? "someone",
			taskId: body.taskId,
			repoIds,
			baseBranch: typeof body.baseBranch === "string" ? body.baseBranch : null,
		});
		return NextResponse.json({ ok: true, key: created.key });
	} catch (error) {
		if (error instanceof HarborError) {
			return NextResponse.json({ error: error.message }, { status: 400 });
		}
		throw error;
	}
}
