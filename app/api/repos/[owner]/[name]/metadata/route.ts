// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@core/schema/index.js";
import { repos } from "@core/schema/schema.js";
import { verifyRepoAccess } from "../../../../../lib/repos.js";
import { currentSession } from "../../../../../lib/session.js";
import { viewerScmToken } from "../../../../../lib/viewer-scm.js";

/**
 * What Harbor knows about one repository, and whether *you* may use it.
 *
 * Answers both halves in one response because a caller deciding whether to
 * offer a repository needs both, and asking twice invites a UI that renders the
 * metadata and forgets the check. `connected` is Harbor's own row; `access` is a
 * live question put to GitHub with the viewer's token.
 *
 * The access answer is **not** cached here and is not the authorisation either.
 * `assertRepoAccess` re-asks at session creation, because access is not
 * permanent — people leave teams and repositories go private, and a check made
 * only when a picker was rendered is a check that expires without anyone
 * noticing.
 */
export const dynamic = "force-dynamic";

export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ owner: string; name: string }> },
) {
	const session = await currentSession();
	if (!session) return NextResponse.json({ error: "No organisation." }, { status: 401 });

	const { owner, name } = await params;
	if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(name)) {
		return NextResponse.json({ error: "Not a repository name. Use owner/name." }, { status: 400 });
	}

	const viewer = await viewerScmToken(session);
	if (viewer.kind === "refused") {
		return NextResponse.json({ error: viewer.error, reason: viewer.reason }, { status: viewer.status });
	}

	const connected = await db.query.repos.findFirst({
		where: and(
			eq(repos.orgId, session.orgId),
			eq(repos.provider, "github"),
			eq(repos.owner, owner),
			eq(repos.name, name),
		),
	});

	const access = await verifyRepoAccess(viewer.token, owner, name);

	return NextResponse.json({
		owner,
		name,
		// Present when the repository has been connected to this org, null when it
		// has not. Null is a real answer — "we can see it, you have not connected
		// it" — and is what the connect button keys off.
		connected: connected
			? {
					id: connected.id,
					default_branch: connected.defaultBranch,
					description: connected.description,
					installation_id: connected.installationId,
					archived: connected.archivedAt !== null,
				}
			: null,
		access: {
			allowed: access.allowed,
			reason: access.reason,
			default_branch: access.defaultBranch ?? connected?.defaultBranch ?? null,
		},
	});
}
