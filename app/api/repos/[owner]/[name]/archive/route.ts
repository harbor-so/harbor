// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@core/schema/index.js";
import { repos } from "@core/schema/schema.js";
import { archiveRepo } from "../../../../../lib/repos.js";
import { currentSession } from "../../../../../lib/session.js";

/**
 * Archive a repository, or bring it back.
 *
 * Archiving rather than deleting is `archiveRepo`'s decision and its reasoning
 * is there: `session_repos` rows are the historical record of what a session
 * actually worked on, and a hard delete either destroys that history or fails on
 * the foreign key in a way a person reads as a bug.
 *
 * Unarchive is the same route with `{"archived": false}` rather than a second
 * endpoint, because the two are one property and splitting them produces the
 * usual asymmetry where one path checks org scope and the other forgets.
 */
export const dynamic = "force-dynamic";

export async function POST(
	request: Request,
	{ params }: { params: Promise<{ owner: string; name: string }> },
) {
	const session = await currentSession();
	if (!session) return NextResponse.json({ error: "No organisation." }, { status: 401 });

	const { owner, name } = await params;

	let archived = true;
	if (request.headers.get("content-type")?.includes("application/json")) {
		try {
			const body = (await request.json()) as { archived?: unknown };
			if (typeof body.archived === "boolean") archived = body.archived;
		} catch {
			return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
		}
	}

	const repo = await db.query.repos.findFirst({
		where: and(
			eq(repos.orgId, session.orgId),
			eq(repos.provider, "github"),
			eq(repos.owner, owner),
			eq(repos.name, name),
		),
	});
	// Scoped to the org, so a repository in somebody else's tenancy is "no such
	// repository" rather than a refusal that confirms it exists.
	if (!repo) return NextResponse.json({ error: "No such repository." }, { status: 404 });

	if (archived) {
		await archiveRepo(session.orgId, repo.id);
	} else {
		await db
			.update(repos)
			.set({ archivedAt: null })
			.where(and(eq(repos.orgId, session.orgId), eq(repos.id, repo.id)));
	}

	return NextResponse.json({ id: repo.id, owner, name, archived });
}
