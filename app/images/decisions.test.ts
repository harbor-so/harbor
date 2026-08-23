// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Zero mocks, zero database, exact boundaries.
 *
 * The bugs that reach production in scheduling code are off-by-one on a threshold
 * edge and a missing branch on a state nobody pictured — the freshness cutoff that
 * is one millisecond too tight and disables the feature, the "due" comparison that
 * drifts a tick every interval. Both are exactly what a pure module makes cheap to
 * cover, so every assertion here is a millisecond either side of a boundary, read
 * through `setting()` rather than a literal so it stays correct when a default is
 * retuned.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { setting } from "@core/kernel/config.js";
import {
	evaluateAutoPause,
	evaluateBuildDue,
	evaluateImageFreshness,
	shouldSkipUnchangedHead,
	type ImagePointer,
} from "./decisions.js";

/** A fixed instant. Every test is written relative to it; nothing reads a clock. */
const NOW = new Date("2026-01-01T12:00:00.000Z");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const ahead = (ms: number): Date => new Date(NOW.getTime() + ms);

/** A published, freshly-scheduled pointer. Tests override the one field they exercise. */
function pointer(overrides: Partial<ImagePointer> = {}): ImagePointer {
	return {
		imageRef: "harbor-repo-abc:latest",
		builtFromSha: "sha-old",
		builtAt: NOW,
		nextBuildAt: NOW,
		consecutiveFailures: 0,
		pausedReason: null,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// The import boundary
// ---------------------------------------------------------------------------

describe("module boundary", () => {
	const source = readFileSync(new URL("./decisions.ts", import.meta.url), "utf8");
	const specifiers = [...source.matchAll(/\bfrom\s+"([^"]+)"/g)].map((match) => match[1]!);

	it("imports only from config — no database, no git, no container runtime", () => {
		expect(new Set(specifiers)).toEqual(new Set(["@core/kernel/config.js"]));
	});
});

// ---------------------------------------------------------------------------
// evaluateBuildDue
// ---------------------------------------------------------------------------

describe("evaluateBuildDue", () => {
	it("a never-scheduled repo (null nextBuildAt) is due immediately", () => {
		expect(evaluateBuildDue(pointer({ nextBuildAt: null }), NOW)).toEqual({
			due: true,
			reason: "never_scheduled",
		});
	});

	it("is due at exactly nextBuildAt — the inclusive edge, so cadence does not drift", () => {
		expect(evaluateBuildDue(pointer({ nextBuildAt: NOW }), NOW)).toEqual({
			due: true,
			reason: "interval_elapsed",
		});
	});

	it("is due one millisecond past nextBuildAt", () => {
		expect(evaluateBuildDue(pointer({ nextBuildAt: ago(1) }), NOW).due).toBe(true);
	});

	it("is not due one millisecond before nextBuildAt, and reports the wait", () => {
		expect(evaluateBuildDue(pointer({ nextBuildAt: ahead(1) }), NOW)).toEqual({
			due: false,
			reason: "not_yet_due",
			msUntilDue: 1,
		});
	});

	it("a paused repo is never due, even past its next build time", () => {
		expect(
			evaluateBuildDue(pointer({ nextBuildAt: ago(10_000), pausedReason: "broke" }), NOW),
		).toEqual({ due: false, reason: "paused" });
	});
});

// ---------------------------------------------------------------------------
// shouldSkipUnchangedHead
// ---------------------------------------------------------------------------

describe("shouldSkipUnchangedHead", () => {
	it("skips when the current image's SHA equals the live HEAD", () => {
		expect(shouldSkipUnchangedHead(pointer({ builtFromSha: "sha-x" }), "sha-x")).toEqual({
			skip: true,
			reason: "head_unchanged",
		});
	});

	it("does not skip when HEAD has advanced", () => {
		expect(shouldSkipUnchangedHead(pointer({ builtFromSha: "sha-x" }), "sha-y")).toEqual({
			skip: false,
			reason: "head_advanced",
		});
	});

	it("never skips a repo that has no published image", () => {
		expect(shouldSkipUnchangedHead(pointer({ imageRef: null }), "sha-x")).toEqual({
			skip: false,
			reason: "no_current_image",
		});
		expect(shouldSkipUnchangedHead(pointer({ builtFromSha: null }), "sha-x")).toEqual({
			skip: false,
			reason: "no_current_image",
		});
	});
});

// ---------------------------------------------------------------------------
// evaluateAutoPause
// ---------------------------------------------------------------------------

describe("evaluateAutoPause", () => {
	const threshold = setting("circuitFailureThreshold");

	it("does not pause one failure below the threshold", () => {
		expect(evaluateAutoPause(threshold - 1).pause).toBe(false);
	});

	it("pauses at exactly the threshold — the inclusive edge", () => {
		expect(evaluateAutoPause(threshold).pause).toBe(true);
	});

	it("stays paused above the threshold and reports the numbers", () => {
		expect(evaluateAutoPause(threshold + 1)).toEqual({
			pause: true,
			consecutiveFailures: threshold + 1,
			threshold,
		});
	});

	it("honours a per-repo override of the threshold", () => {
		expect(evaluateAutoPause(2, { circuitFailureThreshold: 2 }).pause).toBe(true);
		expect(evaluateAutoPause(2, { circuitFailureThreshold: 3 }).pause).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// evaluateImageFreshness
// ---------------------------------------------------------------------------

describe("evaluateImageFreshness", () => {
	const threshold = setting("imageMaxAgeMs");

	it("a repo with no published image is not bootable, distinct from stale", () => {
		expect(evaluateImageFreshness(pointer({ imageRef: null }), NOW)).toEqual({
			bootable: false,
			reason: "no_published_image",
		});
	});

	it("is bootable one millisecond inside the cutoff", () => {
		const decision = evaluateImageFreshness(pointer({ builtAt: ago(threshold - 1) }), NOW);
		expect(decision.bootable).toBe(true);
	});

	it("is stale at exactly the cutoff — the inclusive edge", () => {
		expect(evaluateImageFreshness(pointer({ builtAt: ago(threshold) }), NOW)).toMatchObject({
			bootable: false,
			reason: "stale",
			ageMs: threshold,
			thresholdMs: threshold,
		});
	});

	it("is stale well past the cutoff", () => {
		expect(evaluateImageFreshness(pointer({ builtAt: ago(threshold * 10) }), NOW).bootable).toBe(
			false,
		);
	});

	it("a shorter per-repo cutoff makes a borderline image stale", () => {
		const built = pointer({ builtAt: ago(threshold - 1) });
		expect(
			evaluateImageFreshness(built, NOW, { imageMaxAgeMs: threshold - 2 }).bootable,
		).toBe(false);
	});
});
