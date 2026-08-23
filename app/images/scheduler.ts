// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The image-build tick: decide which repos are due, build one image each, publish on
 * success only.
 *
 * Every guarantee this feature makes is enforced here, and each is a correction of
 * what the obvious version does — the same three the automations tick makes, plus one
 * more:
 *
 *  - **`nextBuildAt` is advanced BEFORE the build runs.** Advanced after, a crash
 *    mid-build leaves the repo due and it rebuilds every tick — a loop that burns a
 *    container per tick against whatever is wedged. Advanced first, a crash costs one
 *    skipped interval.
 *  - **Two ticks cannot both build one repo.** The `one_active_build_per_repo` partial
 *    unique index does it: both ticks INSERT a `running` row, Postgres serialises them,
 *    one lands and the loser records a `skipped` outcome. Not a read-then-write check,
 *    which races under READ COMMITTED and a mock passes every time.
 *  - **A failed build publishes nothing.** The pointer columns advance only inside the
 *    `success` transaction; a failure updates the failure counter and leaves the
 *    pointer exactly as the last good build left it, so a session spawned mid-build
 *    boots the previous image.
 *  - **Repeated failures pause the repo.** `circuitFailureThreshold` consecutive
 *    failures and the repo switches itself off with a stored reason, turning an
 *    unbounded build spend against a broken `setup.sh` into a bounded, visible one.
 *
 * The tick itself decides nothing time- or threshold-dependent: those answers come
 * from the pure `decisions.ts`. This file executes the effects around them.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { and, desc, eq, isNull } from "drizzle-orm";
import { type RepoOverrides, setting } from "@core/kernel/config.js";
import { db, sql } from "@core/schema/index.js";
import { type ImageBuild, imageBuilds, repoImages, repos } from "@core/schema/schema.js";
import { reserveBudget } from "../lib/cost.js";
import { defaultProvider } from "../sandbox/registry.js";
import { type SandboxProvider, isImageBuildingProvider } from "../sandbox/provider.js";
import { evaluateAutoPause, evaluateBuildDue, shouldSkipUnchangedHead } from "./decisions.js";
import { type BuildRequest, type BuildResult, buildRepoImage, repoImageTag, repoImageTagPrefix } from "./builder.js";

const execFileAsync = promisify(execFile);

/** The columns of a repo the tick needs. */
interface RepoRow {
	id: string;
	orgId: string;
	provider: string;
	owner: string;
	name: string;
	defaultBranch: string;
	config: unknown;
}

/**
 * Injectable effects, so the scheduling guarantees can be tested against real
 * Postgres without touching Docker or the network. Production uses the defaults.
 */
export interface ImageTickDeps {
	provider?: SandboxProvider;
	/** Resolve a repo's default-branch HEAD. Defaults to `git ls-remote`. */
	resolveHead?: (repo: RepoRow, overrides: RepoOverrides) => Promise<string>;
	/** Build one image. Defaults to the real builder. */
	build?: (req: BuildRequest) => Promise<BuildResult>;
}

export interface ImageTickResult {
	built: number;
	skipped: number;
	failed: number;
	paused: number;
}

/**
 * One tick. Safe to call from every replica: the advisory lock means exactly one does
 * the work and the rest return immediately. Reserved connection, not pooled, for the
 * same reason the automations tick documents at length — a pooled unlock may run on a
 * different backend and strand the lock, and the symptom (builds run once after a
 * deploy then never again) reproduces only with more than one connection.
 */
export async function tickImageBuilds(
	now = new Date(),
	deps: ImageTickDeps = {},
): Promise<ImageTickResult> {
	const reserved = await sql.reserve();
	try {
		const [lock] = await reserved`
			select pg_try_advisory_lock(hashtext('harbor:image_builds')) as acquired
		`;
		if (!lock?.acquired) return { built: 0, skipped: 0, failed: 0, paused: 0 };
		try {
			return await runDueImageBuilds(now, deps);
		} finally {
			await reserved`select pg_advisory_unlock(hashtext('harbor:image_builds'))`;
		}
	} finally {
		reserved.release();
	}
}

async function runDueImageBuilds(now: Date, deps: ImageTickDeps): Promise<ImageTickResult> {
	const provider = deps.provider ?? defaultProvider();
	const resolveHead = deps.resolveHead ?? gitLsRemoteHead;
	const build = deps.build ?? buildRepoImage;

	const result: ImageTickResult = { built: 0, skipped: 0, failed: 0, paused: 0 };

	// All repos, filtered to the image-building ones in code rather than SQL, because
	// "enabled" is per-repo config in `repos.config`, resolved through `setting()`, not
	// a column. The set is small for a self-hosted deployment and the check is cheap.
	const candidates = await db
		.select({
			id: repos.id,
			orgId: repos.orgId,
			provider: repos.provider,
			owner: repos.owner,
			name: repos.name,
			defaultBranch: repos.defaultBranch,
			config: repos.config,
		})
		.from(repos)
		.where(isNull(repos.archivedAt));

	for (const repo of candidates) {
		const overrides = (repo.config ?? {}) as RepoOverrides;
		if (!setting("imageBuildEnabled", overrides)) continue;

		const pointer = await ensurePointer(repo);
		const due = evaluateBuildDue(pointer, now, overrides);
		if (!due.due) {
			continue;
		}

		// Advance the schedule FIRST — a crash after this point costs one interval, not
		// a rebuild every tick. See the module header.
		const interval = setting("imageBuildIntervalMs", overrides);
		await db
			.update(repoImages)
			.set({ nextBuildAt: new Date(now.getTime() + interval) })
			.where(eq(repoImages.id, pointer.id));

		await buildOne(repo, pointer, overrides, now, provider, resolveHead, build, result);
	}

	return result;
}

async function buildOne(
	repo: RepoRow,
	pointer: PointerRow,
	overrides: RepoOverrides,
	now: Date,
	provider: SandboxProvider,
	resolveHead: NonNullable<ImageTickDeps["resolveHead"]>,
	build: NonNullable<ImageTickDeps["build"]>,
	result: ImageTickResult,
): Promise<void> {
	// Resolve HEAD. A repo whose remote cannot be reached is a real problem that should
	// eventually pause, so a failure here is counted as a build failure rather than a
	// silent skip.
	let headSha: string;
	try {
		headSha = await resolveHead(repo, overrides);
	} catch (error) {
		const slot = await claimBuildSlot(repo, null, now);
		if (slot) {
			const paused = await recordBuildFailure(slot.id, pointer.id, error, now, overrides);
			result.failed += 1;
			if (paused) result.paused += 1;
		} else {
			await recordSkip(repo, null, "another build already active", now);
			result.skipped += 1;
		}
		return;
	}

	// Nothing changed on the default branch: the rebuild would be byte-identical at full
	// cost. Record the skip and move on; the failure counter is untouched.
	if (shouldSkipUnchangedHead(pointer, headSha).skip) {
		await recordSkip(repo, headSha, "head_unchanged", now);
		result.skipped += 1;
		return;
	}

	// Attribute the build's spend to the org cap before doing the work, and refuse if the
	// org is already over. Zero estimate: v1 has no price for a build, but reserving zero
	// still takes the admission path, so an org over its cap is still refused.
	const reservation = await reserveBudget(repo.orgId, 0, {
		kind: "image_build",
		repoId: repo.id,
		actor: "harbor",
		key: `image_build:${repo.id}:${headSha}`,
		repoOverrides: overrides,
		now,
	});
	if (!reservation.ok) {
		await recordSkip(repo, headSha, `budget_refused:${reservation.reason}`, now);
		result.skipped += 1;
		return;
	}

	// The house idiom: both racers INSERT, Postgres serialises them on the partial unique
	// index, the loser gets no row back and records a skip. Not a read-then-write check.
	const slot = await claimBuildSlot(repo, headSha, now);
	if (!slot) {
		await recordSkip(repo, headSha, "another build already active", now);
		result.skipped += 1;
		return;
	}

	try {
		const built = await build({
			orgId: repo.orgId,
			repoId: repo.id,
			provider,
			repo: { name: repo.name, url: cloneUrl(repo), sha: headSha },
			overrides,
		});
		await publishImage(slot.id, pointer.id, built, provider.kind, now);
		result.built += 1;
		await pruneRepoImages(repo.id, provider, built.imageRef, overrides);
	} catch (error) {
		const paused = await recordBuildFailure(slot.id, pointer.id, error, now, overrides);
		result.failed += 1;
		if (paused) result.paused += 1;
	}
}

type PointerRow = typeof repoImages.$inferSelect;

/** Get-or-create the one pointer row for a repo. Idempotent under a concurrent tick. */
async function ensurePointer(repo: RepoRow): Promise<PointerRow> {
	await db
		.insert(repoImages)
		.values({ orgId: repo.orgId, repoId: repo.id })
		.onConflictDoNothing({ target: repoImages.repoId });
	const [row] = await db.select().from(repoImages).where(eq(repoImages.repoId, repo.id)).limit(1);
	// Present by construction: the insert above either created it or lost to a concurrent
	// insert that created it.
	return row as PointerRow;
}

/**
 * The racy INSERT that serialises concurrent builds. Returns the new `running` row, or
 * null if another build is already in flight for this repo.
 *
 * The `onConflictDoNothing` target repeats the index columns AND supplies `where`
 * matching the partial predicate — Postgres raises 42P10 without it, because a bare
 * `on conflict (repo_id)` cannot be matched to a partial index. `where`, not
 * `targetWhere`; the latter is silently ignored.
 */
export async function claimBuildSlot(
	repo: { id: string; orgId: string },
	commitSha: string | null,
	now: Date,
): Promise<ImageBuild | null> {
	const [inserted] = await db
		.insert(imageBuilds)
		.values({
			orgId: repo.orgId,
			repoId: repo.id,
			status: "running",
			commitSha,
			startedAt: now,
			finishedAt: null,
		})
		.onConflictDoNothing({ target: imageBuilds.repoId, where: isNull(imageBuilds.finishedAt) })
		.returning();
	return inserted ?? null;
}

/** Record a build that was decided against — a loser, an unchanged HEAD, a refused budget. */
async function recordSkip(
	repo: { id: string; orgId: string },
	commitSha: string | null,
	reason: string,
	now: Date,
): Promise<void> {
	await db.insert(imageBuilds).values({
		orgId: repo.orgId,
		repoId: repo.id,
		status: "skipped",
		commitSha,
		startedAt: now,
		// A terminal row: finishedAt set, so it is outside the partial unique index and
		// does not collide with an in-flight build.
		finishedAt: now,
		failureReason: reason,
	});
}

/**
 * Publish, transactionally, on success only. Finalise the build row and advance the
 * pointer together, so a crash leaves either the old pointer with a `running` build
 * (reconcilable) or the new pointer with a `success` build — never a pointer advanced
 * past a build the ledger does not show succeeding.
 */
async function publishImage(
	buildId: string,
	pointerId: string,
	built: BuildResult,
	providerKind: string,
	now: Date,
): Promise<void> {
	await db.transaction(async (tx) => {
		await tx
			.update(imageBuilds)
			.set({ status: "success", finishedAt: now, commitSha: built.commitSha })
			.where(eq(imageBuilds.id, buildId));
		await tx
			.update(repoImages)
			.set({
				imageRef: built.imageRef,
				builtFromSha: built.commitSha,
				builtAt: now,
				builtByProvider: providerKind,
				// A success resets the failure streak and lifts any pause.
				consecutiveFailures: 0,
				pausedReason: null,
			})
			.where(eq(repoImages.id, pointerId));
	});
}

/**
 * Record a failed build and advance the failure counter, pausing at the threshold.
 * Returns whether the repo paused. The pointer's image columns are deliberately NOT
 * touched — the previous good image stays published.
 */
async function recordBuildFailure(
	buildId: string,
	pointerId: string,
	error: unknown,
	now: Date,
	overrides: RepoOverrides,
): Promise<boolean> {
	const message = error instanceof Error ? error.message : String(error);
	return db.transaction(async (tx) => {
		await tx
			.update(imageBuilds)
			.set({ status: "failed", finishedAt: now, failureReason: message.slice(0, 2000) })
			.where(eq(imageBuilds.id, buildId));
		const [ptr] = await tx
			.select({ consecutiveFailures: repoImages.consecutiveFailures })
			.from(repoImages)
			.where(eq(repoImages.id, pointerId))
			.limit(1);
		const failures = (ptr?.consecutiveFailures ?? 0) + 1;
		const pause = evaluateAutoPause(failures, overrides);
		await tx
			.update(repoImages)
			.set({
				consecutiveFailures: failures,
				pausedReason: pause.pause
					? `Paused after ${failures} consecutive failed builds. Last error: ${message.slice(0, 500)}`
					: null,
			})
			.where(eq(repoImages.id, pointerId));
		return pause.pause;
	});
}

/** Prune older images past `imageRetentionCount`, keeping the current pointer and recents. */
async function pruneRepoImages(
	repoId: string,
	provider: SandboxProvider,
	currentRef: string,
	overrides: RepoOverrides,
): Promise<void> {
	if (!isImageBuildingProvider(provider)) return;
	try {
		const keepCount = setting("imageRetentionCount", overrides);
		const recent = await db
			.select({ commitSha: imageBuilds.commitSha })
			.from(imageBuilds)
			.where(and(eq(imageBuilds.repoId, repoId), eq(imageBuilds.status, "success")))
			.orderBy(desc(imageBuilds.finishedAt))
			.limit(keepCount);
		const keep = recent
			.filter((row) => row.commitSha !== null)
			.map((row) => repoImageTag(repoId, row.commitSha as string));
		if (!keep.includes(currentRef)) keep.push(currentRef);
		await provider.pruneImages(repoImageTagPrefix(repoId), keep);
	} catch {
		// Pruning is best-effort: disk hygiene must never fail a tick that already
		// published a good image.
	}
}

/**
 * Resolve a repo's default-branch HEAD with `git ls-remote`.
 *
 * Constructs the HTTPS clone URL from the repo's provider, owner and name. This is the
 * github.com / gitlab.com form; a GitHub Enterprise or self-hosted GitLab host is not
 * yet derived here — see ADR 0007's scope note. Injectable, so tests never hit the
 * network and an enterprise deployment can supply its own resolver.
 */
async function gitLsRemoteHead(repo: RepoRow, overrides: RepoOverrides): Promise<string> {
	const { stdout } = await execFileAsync(
		"git",
		["ls-remote", cloneUrl(repo), `refs/heads/${repo.defaultBranch}`],
		{ timeout: setting("imageBuildTimeoutMs", overrides), shell: false },
	);
	const sha = stdout.split(/\s+/)[0] ?? "";
	if (!/^[0-9a-f]{40}$/i.test(sha)) {
		throw new Error(
			`could not resolve ${repo.defaultBranch} HEAD for ${repo.owner}/${repo.name}: `
			+ "git ls-remote returned no matching ref.",
		);
	}
	return sha;
}

/** The HTTPS clone URL. github.com / gitlab.com form; see the resolver's note. */
function cloneUrl(repo: RepoRow): string {
	const host = repo.provider === "gitlab" ? "gitlab.com" : "github.com";
	return `https://${host}/${repo.owner}/${repo.name}.git`;
}
