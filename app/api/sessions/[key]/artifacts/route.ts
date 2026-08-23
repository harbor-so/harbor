// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@core/schema/index.js";
import { artifacts } from "@core/schema/schema.js";
import { resolveSession } from "../../../../lib/session-access.js";

/**
 * What a session produced: branches, pull requests, screenshots, files, logs.
 *
 * Until now these were reachable only inside a session snapshot, where they
 * share the snapshot's event budget — so on a busy session the artifacts a
 * person actually wants can be squeezed out by a burst of tool calls. This route
 * has its own budget and its own index (`artifacts_session_idx` on
 * `(session_id, created_at)`), so "what came out of this" is answerable
 * regardless of how noisy the transcript was.
 *
 * `merged_at` is included and is only ever set from a verified source-control
 * webhook, never by an agent — `record_artifact`'s enum excludes `pull_request`
 * precisely so that an agent cannot assert its own work merged.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ key: string }> }) {
	const { key } = await params;
	const access = await resolveSession(request, key);
	if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

	const url = new URL(request.url);
	const kind = url.searchParams.get("kind");

	const rows = await db
		.select()
		.from(artifacts)
		.where(eq(artifacts.sessionId, access.session.id))
		.orderBy(desc(artifacts.createdAt));

	// Filtered here rather than in SQL because the list is already bounded by one
	// session and a second index for an optional filter would earn nothing.
	const selected = kind ? rows.filter((row) => row.kind === kind) : rows;

	return NextResponse.json({
		artifacts: selected.map((row) => ({
			id: row.id,
			kind: row.kind,
			title: row.title,
			url: row.url,
			payload: row.payload,
			merged_at: row.mergedAt?.toISOString() ?? null,
			created_at: row.createdAt.toISOString(),
		})),
	});
}
