// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Which branch a session's work goes to, and why it is pinned to the session
 * rather than to the lease that happens to be held right now.
 *
 * ## The trap this module exists to avoid
 *
 * Harbor's branch convention is `harbor/lse_<claim_id>`, and it is load-bearing:
 * given any branch, `parseHarborBranch` recovers the lease, and the lease carries
 * the intent, the holder, the window and the cost rows. Naming a branch after the
 * lease is right.
 *
 * Deriving it *afresh on every turn* is not. `completeTurn` releases the lease
 * whenever the prompt queue drains — correctly, because holding one through an
 * idle hour locks a task out of the pool for nothing — so a session's third
 * prompt, sent an hour after its second, runs under a **different claim id**.
 * Re-deriving would push turn 3 to a second branch, cut from base, carrying none
 * of turns 1–2's commits. The follow-up would silently lose the work it was
 * following up on, and there would be two pull requests where the user asked for
 * one.
 *
 * So: **the first push names the lease the work began under, and every later turn
 * reads that name back** from `session_repos.working_branch` — a column that has
 * existed since the schema was written, whose comment already said this is what
 * it is for, and which nothing had ever written to.
 *
 * Traceability survives intact, at one extra hop. The branch names the first
 * lease; the first lease names the session; every later lease over that session
 * shares its scope. "Why does this branch exist and who authorised it" is still
 * answerable with zero inference — it just answers with a list where it used to
 * answer with a single row, which is the truthful shape when several leases
 * contributed to one branch.
 *
 * ## Resolved per turn, not injected at spawn
 *
 * The sandbox learns its branch on the prompt command rather than from a spawn-
 * time environment variable, which is the ordering `harborBranchName`'s own
 * docstring argues for: a box outlives the lease that booted it, and a spawn
 * retried under a new lease would otherwise push to the old lease's branch.
 * Resolving at the moment the prompt is sent is the latest point at which the
 * answer is knowable, so it is the point where it is decided.
 */

import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@core/schema/index.js";
import { claims, repos, sessionRepos, sessions } from "@core/schema/schema.js";
import { GitAttributionError, harborBranchName } from "./provider.js";

export interface PushTarget {
	/** Where the sandbox pushes. Null means "do not push"; the turn still runs. */
	branch: string | null;
	/** What the branch was cut from, for the PR base and the compare URL. */
	base: string | null;
	repoId: string | null;
	/** Why there is no branch, for the log line the sandbox emits. */
	reason?: "no_repo" | "no_lease" | "claim_unusable";
}

/** The session's primary repository — the one the workspace's `cwd` is in. */
async function primaryRepo(sessionId: string): Promise<{
	repoId: string;
	baseBranch: string;
	workingBranch: string | null;
	defaultBranch: string;
} | null> {
	const [row] = await db
		.select({
			repoId: sessionRepos.repoId,
			baseBranch: sessionRepos.baseBranch,
			workingBranch: sessionRepos.workingBranch,
			defaultBranch: repos.defaultBranch,
		})
		.from(sessionRepos)
		.innerJoin(repos, eq(sessionRepos.repoId, repos.id))
		.where(eq(sessionRepos.sessionId, sessionId))
		.orderBy(asc(sessionRepos.position))
		.limit(1);
	return row ?? null;
}

/**
 * The branch this turn should push to.
 *
 * Called on the command stream, which is a hot path re-run on every drain, so it
 * is two indexed reads and no writes. The pin is written once, later, by the
 * ingest path when a push is actually reported — deriving a name here and
 * recording it as though it had been used would leave `working_branch` naming a
 * branch that does not exist on the remote.
 */
export async function resolvePushBranch(orgId: string, sessionId: string): Promise<PushTarget> {
	const repo = await primaryRepo(sessionId);
	if (!repo) return { branch: null, base: null, repoId: null, reason: "no_repo" };

	const base = repo.baseBranch || repo.defaultBranch;

	// The pin wins whenever it exists, and it is the common case from the second
	// push onward. No lease lookup, no derivation, no way for a new claim id to
	// move a branch that already has commits on it.
	if (repo.workingBranch) {
		return { branch: repo.workingBranch, base, repoId: repo.repoId };
	}

	const [session] = await db
		.select({ taskId: sessions.taskId })
		.from(sessions)
		.where(and(eq(sessions.id, sessionId), eq(sessions.orgId, orgId)))
		.limit(1);
	if (!session?.taskId) return { branch: null, base, repoId: repo.repoId, reason: "no_lease" };

	const [held] = await db
		.select({ id: claims.id })
		.from(claims)
		.where(and(eq(claims.taskId, session.taskId), isNull(claims.releasedAt)))
		.limit(1);
	if (!held) return { branch: null, base, repoId: repo.repoId, reason: "no_lease" };

	try {
		return { branch: harborBranchName(held.id), base, repoId: repo.repoId };
	} catch (error) {
		// `harborBranchName` refuses to interpolate an id that is not shaped like
		// one. That is a programming error rather than a configuration one, so it is
		// logged and the turn proceeds without a push — a session that runs and
		// pushes nothing is recoverable; a 500 on the command stream is a box that
		// never receives its prompt.
		if (!(error instanceof GitAttributionError)) throw error;
		console.error(`[branch] refusing to derive a branch for session ${sessionId}:`, error.message);
		return { branch: null, base, repoId: repo.repoId, reason: "claim_unusable" };
	}
}

/**
 * Record the branch a push actually landed on, once.
 *
 * Conditional on `working_branch IS NULL` **inside the UPDATE** rather than
 * checked and then written. Two pushes reported concurrently — a redelivered
 * ingest batch is the ordinary way this happens — would otherwise both read null
 * and both write, and the second write could name a branch derived from a lease
 * taken after the first push. As a predicate, the second matches zero rows.
 *
 * Returns the branch that is pinned after the call, which is not always the one
 * passed in: a caller that lost the race gets the winner's branch back, which is
 * the value it must use for the pull request.
 */
export async function pinWorkingBranch(input: {
	sessionId: string;
	repoId: string;
	branch: string;
}): Promise<string> {
	const pinned = await db
		.update(sessionRepos)
		.set({ workingBranch: input.branch })
		.where(
			and(
				eq(sessionRepos.sessionId, input.sessionId),
				eq(sessionRepos.repoId, input.repoId),
				isNull(sessionRepos.workingBranch),
			),
		)
		.returning({ branch: sessionRepos.workingBranch });

	if (pinned.length > 0) return input.branch;

	const [existing] = await db
		.select({ branch: sessionRepos.workingBranch })
		.from(sessionRepos)
		.where(and(eq(sessionRepos.sessionId, input.sessionId), eq(sessionRepos.repoId, input.repoId)))
		.limit(1);
	return existing?.branch ?? input.branch;
}
