// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Every decision the prebuilt-image pipeline makes, and not one line of I/O.
 *
 * The scheduler talks to Postgres, a git remote and a container runtime. This file
 * decides. The split is the same one `src/sandbox/decisions.ts` draws and for the
 * same reason: "is a build due at the exact interval edge", "does an unchanged HEAD
 * skip the rebuild", "does the third consecutive failure pause the repo", and "is a
 * ninety-minute-old image still fresh enough to boot from" are one-line assertions
 * against a pure function and an afternoon of fixture surgery against a function
 * that reads a clock, a database and `git ls-remote`.
 *
 * What this module refuses to do:
 *
 *  - **Read the clock.** Every time-based decision takes `now: Date`. A function
 *    that calls `Date.now()` cannot be tested at its own boundary, so the boundary
 *    goes untested and the off-by-one on the staleness cutoff ships to the one
 *    place it silently disables the feature.
 *  - **Hardcode a threshold.** The interval, the freshness cutoff and the failure
 *    limit all come from `setting()` with the repository's overrides threaded
 *    through, so a monorepo that legitimately needs a longer interval is a config
 *    change rather than a fork.
 *  - **Touch a database, a git remote or a container.** It imports `../config.js`
 *    and nothing else, and a test asserts that import list mechanically — because
 *    purity here is a property somebody breaks in one line by importing `db` "just
 *    to look up the repo's overrides", and the assertion is the only version of
 *    "keep this pure" that survives a hurry.
 *
 * Decisions return a typed reason rather than a bare boolean, so the scheduler can
 * record *why* a tick built, skipped or paused into `image_builds` — "skipped" is
 * useless in a support conversation, "skipped: head_unchanged" ends it.
 */

import { type RepoOverrides, setting } from "@core/kernel/config.js";

/**
 * The subset of a `repo_images` row the decisions read.
 *
 * Narrow on purpose: a decision that accepted the whole Drizzle row would be one
 * refactor away from reaching for a column it should not, and the structural type
 * lets a test construct a pointer with a single literal instead of a full row.
 */
export interface ImagePointer {
	/** The published image handle, or null for a repo that has opted in but never built one. */
	imageRef: string | null;
	/** The default-branch commit the published image was built at, or null if there is none. */
	builtFromSha: string | null;
	/** When the published image was built, or null if there is none. */
	builtAt: Date | null;
	/** When the next build is due. Null the first time a repo is seen, before it is scheduled. */
	nextBuildAt: Date | null;
	consecutiveFailures: number;
	/** Non-null means the repo auto-paused after repeated failures and is excluded from the tick. */
	pausedReason: string | null;
}

export type BuildDueDecision =
	| { due: true; reason: "never_scheduled" | "interval_elapsed" }
	| { due: false; reason: "paused" }
	| { due: false; reason: "not_yet_due"; msUntilDue: number };

/**
 * Is a build due for this repo right now?
 *
 * A paused repo is never due — the pause is the whole point of the failure counter,
 * and a paused repo that kept building would burn a sandbox per tick against
 * whatever is broken. A repo seen for the first time (`nextBuildAt === null`) is due
 * immediately: unlike an hourly automation, whose "do not fire on creation" rule
 * exists so a human is not surprised, an operator who enables image building wants
 * the first image built promptly, and the crash-loop protection the automation rule
 * really buys is provided instead by the scheduler advancing `nextBuildAt` *before*
 * it builds. After that, due is a plain comparison, and the boundary is inclusive:
 * at exactly `nextBuildAt` the build is due, because a cadence that skipped the
 * instant it was scheduled for would drift one tick later every interval.
 */
export function evaluateBuildDue(
	pointer: ImagePointer,
	now: Date,
	_overrides?: RepoOverrides,
): BuildDueDecision {
	if (pointer.pausedReason !== null) return { due: false, reason: "paused" };
	if (pointer.nextBuildAt === null) return { due: true, reason: "never_scheduled" };

	const msUntilDue = pointer.nextBuildAt.getTime() - now.getTime();
	if (msUntilDue <= 0) return { due: true, reason: "interval_elapsed" };
	return { due: false, reason: "not_yet_due", msUntilDue };
}

export type UnchangedHeadDecision =
	| { skip: true; reason: "head_unchanged" }
	| { skip: false; reason: "no_current_image" | "head_advanced" };

/**
 * Should the rebuild be skipped because the default branch has not moved?
 *
 * The cheapest build is the one not run. If the current image was built from the
 * exact commit the default branch still points at, rebuilding it produces a
 * byte-for-byte equivalent image at full compute cost, so the tick skips it and
 * records why. A repo with no current image never skips — there is nothing to be
 * equivalent to, and skipping would leave it permanently imageless. The comparison
 * is exact-SHA rather than "newer than", because a force-push that moves HEAD
 * backwards is a real change the image must reflect.
 */
export function shouldSkipUnchangedHead(
	pointer: ImagePointer,
	currentHeadSha: string,
): UnchangedHeadDecision {
	if (pointer.imageRef === null || pointer.builtFromSha === null) {
		return { skip: false, reason: "no_current_image" };
	}
	if (pointer.builtFromSha === currentHeadSha) return { skip: true, reason: "head_unchanged" };
	return { skip: false, reason: "head_advanced" };
}

export interface AutoPauseDecision {
	pause: boolean;
	consecutiveFailures: number;
	threshold: number;
}

/**
 * Has this repo failed enough consecutive builds to pause itself?
 *
 * Reuses `circuitFailureThreshold`, the same limit the automations use, for the
 * same reason: a repo whose `setup.sh` is broken will keep failing, and a build
 * that fires every interval against it spends real compute forever until somebody
 * notices. The threshold is inclusive — at exactly the limit the repo pauses — and
 * the count is *consecutive*, so a single success anywhere resets it and a repo
 * that fails intermittently is never paused for a transient flake.
 */
export function evaluateAutoPause(
	consecutiveFailures: number,
	overrides?: RepoOverrides,
): AutoPauseDecision {
	const threshold = setting("circuitFailureThreshold", overrides);
	return { pause: consecutiveFailures >= threshold, consecutiveFailures, threshold };
}

export type ImageFreshnessDecision =
	| { bootable: true; ageMs: number; thresholdMs: number }
	| { bootable: false; reason: "no_published_image" }
	| { bootable: false; reason: "stale"; ageMs: number; thresholdMs: number };

/**
 * Is the published image fresh enough for a spawn to boot from?
 *
 * This is the gate that keeps a stalled pipeline from silently degrading sessions.
 * If builds stop — the repo paused, the runtime is down, every recent build failed —
 * the pointer stops advancing, and without a cutoff a session would keep booting an
 * ever-staler image whose baked dependencies drift further from the repo every hour.
 * Past `imageMaxAgeMs` the boot instead falls through to `fresh`, paying a cold start
 * that is *correct*. A repo with no published image is `no_published_image`, distinct
 * from `stale`, so the boot event can say which — "we have never built one" and "the
 * one we have is too old" are different operator problems. The cutoff is inclusive at
 * the edge, matching the inactivity timeout: an image exactly at the limit is stale.
 */
export function evaluateImageFreshness(
	pointer: ImagePointer,
	now: Date,
	overrides?: RepoOverrides,
): ImageFreshnessDecision {
	if (pointer.imageRef === null || pointer.builtAt === null) {
		return { bootable: false, reason: "no_published_image" };
	}
	const thresholdMs = setting("imageMaxAgeMs", overrides);
	const ageMs = now.getTime() - pointer.builtAt.getTime();
	if (ageMs >= thresholdMs) return { bootable: false, reason: "stale", ageMs, thresholdMs };
	return { bootable: true, ageMs, thresholdMs };
}
