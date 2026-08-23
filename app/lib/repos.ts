// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Connecting a repository, and the access check that makes Harbor multi-tenant.
 *
 * The tempting shape is to let a single shared GitHub App installation perform
 * every git operation and do **no per-user repository access check at all**. It
 * works, it is less code, and it is defensible for a tool built for one internal
 * team where everybody can already read everything. It is disqualifying the moment
 * a deployment has contractors, a second team, or an intern: any user could start
 * a session against any repository the App is installed on, and the App's reach is
 * the union of every repository anyone connected.
 *
 * `connectRepo` therefore verifies access with the **requesting user's own**
 * source-control token before writing a row, and `assertRepoAccess` re-checks at
 * session creation. The check fails closed: an unreadable answer denies. This is
 * authority, not liveness, and ADR 0003 explains why those two fail in opposite
 * directions.
 */

import { and, eq, isNull } from "drizzle-orm";
import { db } from "@core/schema/index.js";
import { environmentRepos, environments, repos, sessionRepos } from "@core/schema/schema.js";
import { HarborError } from "@core/kernel/work.js";

export interface ConnectRepoInput {
	orgId: string;
	provider?: string;
	owner: string;
	name: string;
	defaultBranch?: string;
	description?: string;
	installationId?: string | null;
	/**
	 * The user's own SCM token. Required, and deliberately not optional with a
	 * fallback to the App installation token: an optional access check is an access
	 * check that is skipped in exactly the deployment that needed it.
	 */
	userToken: string;
}

/**
 * Ask the source-control host whether *this user* can see this repository.
 *
 * Injectable `fetch` so tests drive fabricated responses rather than reaching the
 * network. A test that has to hit GitHub is a test that gets deleted the first
 * time CI is offline.
 */
export type Fetcher = typeof fetch;

export async function verifyRepoAccess(
	userToken: string,
	owner: string,
	name: string,
	fetcher: Fetcher = fetch,
): Promise<{ allowed: boolean; reason: string; defaultBranch?: string }> {
	try {
		const response = await fetcher(`https://api.github.com/repos/${owner}/${name}`, {
			headers: {
				authorization: `Bearer ${userToken}`,
				accept: "application/vnd.github+json",
				"user-agent": "harbor",
			},
			signal: AbortSignal.timeout(10_000),
		});

		if (response.status === 404 || response.status === 403) {
			// GitHub returns 404 rather than 403 for a private repository the token
			// cannot see, deliberately, so that the existence of a private repo is not
			// leaked. Both mean the same thing to us and neither is an error to retry.
			return { allowed: false, reason: `${owner}/${name} is not visible to your account.` };
		}
		if (!response.ok) {
			// FAIL CLOSED. This is authority: an answer we could not obtain is not an
			// answer we may assume. The opposite rule applies to sandbox liveness, and
			// the asymmetry is deliberate — see ADR 0003.
			return {
				allowed: false,
				reason:
					`GitHub returned ${response.status} while checking access to ${owner}/${name}. `
					+ "Harbor treats an unreadable permission as denied rather than assuming "
					+ "authority it could not confirm. Try again in a moment.",
			};
		}

		const body = (await response.json()) as { default_branch?: string; permissions?: { pull?: boolean } };
		// `permissions.pull` is only present when the token is a user token, which is
		// exactly the case we care about. Its absence means we were handed something
		// else — an App token, most likely — and that is a programming error, not a
		// permission grant.
		if (body.permissions && body.permissions.pull !== true) {
			return { allowed: false, reason: `Your account cannot read ${owner}/${name}.` };
		}

		return { allowed: true, reason: "ok", defaultBranch: body.default_branch };
	} catch (error) {
		return {
			allowed: false,
			reason:
				`Could not reach GitHub to check access to ${owner}/${name}: `
				+ `${(error as Error).message}. Treated as denied.`,
		};
	}
}

export async function connectRepo(input: ConnectRepoInput, fetcher: Fetcher = fetch) {
	const owner = input.owner.trim();
	const name = input.name.trim();
	if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(name)) {
		throw new HarborError(
			`"${input.owner}/${input.name}" is not a repository name. Use owner/name.`,
		);
	}

	const access = await verifyRepoAccess(input.userToken, owner, name, fetcher);
	if (!access.allowed) throw new HarborError(access.reason);

	const [row] = await db
		.insert(repos)
		.values({
			orgId: input.orgId,
			provider: input.provider ?? "github",
			owner,
			name,
			// Read from the API rather than defaulted to `main`, because a repository
			// whose default is `master` or `develop` would otherwise have every session
			// branch from a ref that does not exist, and the failure surfaces inside
			// sandbox boot where it is least legible.
			defaultBranch: access.defaultBranch ?? input.defaultBranch ?? "main",
			description: input.description ?? null,
			installationId: input.installationId ?? null,
		})
		.onConflictDoUpdate({
			target: [repos.orgId, repos.provider, repos.owner, repos.name],
			set: {
				archivedAt: null,
				defaultBranch: access.defaultBranch ?? input.defaultBranch ?? "main",
				installationId: input.installationId ?? null,
			},
		})
		.returning();

	return row!;
}

/**
 * The check at session creation. Separate from `connectRepo` because access is
 * not permanent: somebody leaves a team, a repository is made private, an App
 * installation is removed. Checking only at connect time means a user keeps
 * access to a repository they were removed from for as long as the row survives.
 */
export async function assertRepoAccess(
	orgId: string,
	repoId: string,
	userToken: string | null,
	fetcher: Fetcher = fetch,
): Promise<void> {
	const repo = await db.query.repos.findFirst({
		where: and(eq(repos.id, repoId), eq(repos.orgId, orgId)),
	});
	if (!repo) throw new HarborError("No such repository in this organisation.");

	if (!userToken) {
		throw new HarborError(
			`Cannot verify your access to ${repo.owner}/${repo.name}: your account has no `
				+ "source-control identity. Sign in with GitHub rather than SSO, or ask an "
				+ "administrator to start this session. Harbor will not fall back to the shared "
				+ "app installation for an access check, because that would mean every user of "
				+ "this deployment can reach every repository the app can.",
		);
	}

	const access = await verifyRepoAccess(userToken, repo.owner, repo.name, fetcher);
	if (!access.allowed) throw new HarborError(access.reason);
}

export async function listRepos(orgId: string) {
	return db
		.select()
		.from(repos)
		.where(and(eq(repos.orgId, orgId), isNull(repos.archivedAt)))
		.orderBy(repos.owner, repos.name);
}

/**
 * Archive rather than delete.
 *
 * `session_repos` references a repository, and those rows are the historical
 * record of what a session actually worked on. A hard delete either cascades and
 * destroys that history, or fails on the foreign key and produces an error the
 * user reads as a bug. Archiving hides it from every picker and keeps the record.
 */
export async function archiveRepo(orgId: string, repoId: string): Promise<void> {
	await db
		.update(repos)
		.set({ archivedAt: new Date() })
		.where(and(eq(repos.orgId, orgId), eq(repos.id, repoId)));
}

/**
 * Snapshot an environment (or an ad-hoc selection) into a session.
 *
 * Called once, at creation, and never recomputed — which is the whole reason
 * `session_repos` exists as a table rather than a join through `environments`.
 * Resolving the environment on every read would mean editing an environment
 * silently changes the workspace under a running agent, and deleting one strands
 * every session that referenced it.
 */
export async function snapshotSessionRepos(input: {
	orgId: string;
	sessionId: string;
	repoIds: string[];
	baseBranch?: string | null;
}): Promise<void> {
	if (input.repoIds.length === 0) return;
	if (input.repoIds.length > 10) {
		throw new HarborError(
			"A session can work in at most 10 repositories. Beyond that the agent's context "
				+ "is spent on directory listings rather than on the task.",
		);
	}

	const rows = await db
		.select()
		.from(repos)
		.where(eq(repos.orgId, input.orgId));

	const values = input.repoIds.map((repoId, position) => {
		const repo = rows.find((candidate) => candidate.id === repoId);
		if (!repo) throw new HarborError("A selected repository does not exist in this org.");
		return {
			orgId: input.orgId,
			sessionId: input.sessionId,
			repoId,
			position,
			// The first repository is primary and its branch is the session default.
			baseBranch: (position === 0 ? input.baseBranch : null) ?? repo.defaultBranch,
		};
	});

	await db.insert(sessionRepos).values(values).onConflictDoNothing();
}

export async function createEnvironment(input: {
	orgId: string;
	name: string;
	description?: string;
	repoIds: string[];
}) {
	if (input.repoIds.length === 0) {
		throw new HarborError("An environment needs at least one repository.");
	}
	if (input.repoIds.length > 10) {
		throw new HarborError("An environment can hold at most 10 repositories.");
	}

	return db.transaction(async (tx) => {
		const [environment] = await tx
			.insert(environments)
			.values({
				orgId: input.orgId,
				name: input.name.trim(),
				description: input.description ?? null,
			})
			.returning();

		await tx.insert(environmentRepos).values(
			input.repoIds.map((repoId, position) => ({
				orgId: input.orgId,
				environmentId: environment!.id,
				repoId,
				position,
			})),
		);

		return environment!;
	});
}
