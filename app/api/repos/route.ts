// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { NextResponse } from "next/server";
import { createScmProvider } from "../../git/github.js";
import { listsRepositories } from "../../git/provider.js";
import { connectRepo, listRepos } from "../../lib/repos.js";
import { currentSession } from "../../lib/session.js";
import { viewerScmToken } from "../../lib/viewer-scm.js";
import { HarborError } from "@core/kernel/work.js";

/**
 * Repositories: the ones this org has connected, and the ones you could connect.
 *
 * `connectRepo` existed, was tested, and had **no caller** — so onboarding a
 * repository meant inserting a row by hand, and the per-user access check that
 * makes Harbor multi-tenant ran in exactly zero production paths. This route is
 * that caller.
 *
 * The picker is `?available=1` on this same route rather than
 * `/api/repos/available`, because the next route down is `/api/repos/[owner]`
 * and a static segment silently shadows a dynamic one. A GitHub account named
 * `available` is unlikely and the failure — that user's repositories become
 * unreachable through Harbor with no error anywhere — is not the kind worth
 * leaving in for a tidier URL.
 *
 * POST takes `owner`/`name` and nothing about permissions, deliberately. What
 * the requester may do is read from their own token inside `connectRepo`, not
 * from the request body — a client that can assert its own access is a client
 * that can connect any repository the app can see.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	const session = await currentSession();
	if (!session) return NextResponse.json({ error: "No organisation." }, { status: 401 });

	const params = new URL(request.url).searchParams;
	if (params.get("available") === "1") return listAvailable(session, params);

	const rows = await listRepos(session.orgId);
	return NextResponse.json({
		repos: rows.map((repo) => ({
			id: repo.id,
			provider: repo.provider,
			owner: repo.owner,
			name: repo.name,
			default_branch: repo.defaultBranch,
			description: repo.description,
			installation_id: repo.installationId,
			created_at: repo.createdAt?.toISOString() ?? null,
		})),
	});
}

/**
 * What the signed-in person could connect, read from GitHub **with their own
 * token**. Two people in the same org see different answers, and that is the
 * point: listing through the app installation would show everyone every
 * repository the app is installed on, which is the multi-tenancy hole
 * `verifyRepoAccess` exists to close, reintroduced at the one place a user goes
 * looking for repositories.
 *
 * A provider that cannot enumerate returns 501 naming itself rather than an
 * empty array, because an empty picker on a working deployment is
 * indistinguishable from "you have no repositories" and sends people looking in
 * the wrong place.
 */
async function listAvailable(
	session: NonNullable<Awaited<ReturnType<typeof currentSession>>>,
	params: URLSearchParams,
) {
	const viewer = await viewerScmToken(session);
	if (viewer.kind === "refused") {
		return NextResponse.json({ error: viewer.error, reason: viewer.reason }, { status: viewer.status });
	}

	const selection = createScmProvider();
	if (!selection.ok) {
		return NextResponse.json({ error: selection.message, reason: selection.reason }, { status: 501 });
	}
	if (!listsRepositories(selection.provider)) {
		return NextResponse.json(
			{
				error:
					`The ${selection.provider.id} provider cannot list repositories. `
					+ "Connect one by owner and name instead.",
				reason: "listing_not_supported",
			},
			{ status: 501 },
		);
	}

	const requested = Number(params.get("limit") ?? "");
	const listing = await selection.provider.listRepositories(viewer.token, {
		limit: Number.isFinite(requested) && requested > 0 ? requested : undefined,
	});

	if (listing.kind === "unavailable") {
		// The user's problem to fix versus the host's, given different statuses: a
		// 503 tells a client to retry, a 403 tells a person to reconnect.
		const status = listing.reason === "token_invalid" || listing.reason === "forbidden" ? 403 : 503;
		return NextResponse.json({ error: listing.detail, reason: listing.reason }, { status });
	}

	return NextResponse.json({
		repositories: listing.repositories,
		truncated: listing.truncated,
		listed_as: viewer.login,
	});
}

export async function POST(request: Request) {
	const session = await currentSession();
	if (!session) return NextResponse.json({ error: "No organisation." }, { status: 401 });

	let body: { owner?: unknown; name?: unknown; installation_id?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
	}

	if (typeof body.owner !== "string" || typeof body.name !== "string") {
		return NextResponse.json(
			{ error: "Provide `owner` and `name`, as they appear in the repository URL." },
			{ status: 400 },
		);
	}

	const viewer = await viewerScmToken(session);
	if (viewer.kind === "refused") {
		return NextResponse.json({ error: viewer.error, reason: viewer.reason }, { status: viewer.status });
	}

	try {
		const repo = await connectRepo({
			orgId: session.orgId,
			owner: body.owner,
			name: body.name,
			installationId: typeof body.installation_id === "string" ? body.installation_id : null,
			userToken: viewer.token,
		});
		return NextResponse.json({
			repo: {
				id: repo.id,
				owner: repo.owner,
				name: repo.name,
				default_branch: repo.defaultBranch,
			},
		});
	} catch (error) {
		if (error instanceof HarborError) {
			// A refused access check is a 403, not a 500: the request was well-formed
			// and the answer was "no". The message is the one `verifyRepoAccess`
			// wrote, which already distinguishes "not visible to you" from "GitHub
			// was unreachable, so this was treated as denied".
			return NextResponse.json({ error: error.message }, { status: 403 });
		}
		throw error;
	}
}
