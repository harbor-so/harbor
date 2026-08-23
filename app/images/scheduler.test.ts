// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The scheduling guarantees, against real Postgres.
 *
 * These are the guarantees that ARE database behaviour — the one-active-build index,
 * the success-only pointer advance, the failure counter — so they are tested against
 * the real database with the build and HEAD-resolution effects injected, never mocked
 * away. A mock would happily pass a read-then-write concurrency check that the index is
 * here to make impossible. The suite truncates in `beforeEach` so cases cannot poison
 * each other.
 */

import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, sql } from "@core/schema/index.js";
import { imageBuilds, orgs, repoImages, repos } from "@core/schema/schema.js";
import { recordCost } from "../lib/cost.js";
import type { SandboxProvider } from "../sandbox/provider.js";
import type { BuildRequest, BuildResult } from "./builder.js";
import { claimBuildSlot, tickImageBuilds } from "./scheduler.js";

let orgId: string;
let repoId: string;

/** A provider the scheduler only reads `.kind` from; not image-building, so prune is skipped. */
const fakeProvider = { name: "fake", kind: "ephemeral" } as unknown as SandboxProvider;

/** A build that succeeds at whatever SHA it is handed. */
function succeedingBuild(): (req: BuildRequest) => Promise<BuildResult> {
	return async (req) => ({
		imageRef: `harbor-repo-${req.repoId}:${req.repo.sha.slice(0, 12)}`,
		commitSha: req.repo.sha,
		provider: "fake",
		log: "ok",
	});
}

/** A build that always fails, as a broken setup.sh would. */
function failingBuild(): (req: BuildRequest) => Promise<BuildResult> {
	return async () => {
		throw new Error("setup.sh exited 1");
	};
}

async function seedRepo(config: Record<string, unknown>): Promise<void> {
	const [org] = await db.insert(orgs).values({ name: "acme" }).returning({ id: orgs.id });
	orgId = org!.id;
	const [repo] = await db
		.insert(repos)
		.values({ orgId, provider: "github", owner: "acme", name: "web", config })
		.returning({ id: repos.id });
	repoId = repo!.id;
}

/** Force the repo due again by moving its next build into the past. */
async function makeDue(): Promise<void> {
	await db
		.update(repoImages)
		.set({ nextBuildAt: new Date(Date.now() - 60_000) })
		.where(eq(repoImages.repoId, repoId));
}

async function pointer() {
	const [row] = await db.select().from(repoImages).where(eq(repoImages.repoId, repoId)).limit(1);
	return row;
}

beforeEach(async () => {
	// Cascades to repos, repo_images, image_builds and cost_events, all of which
	// reference orgs — so each case starts from an empty world.
	await sql`truncate table orgs cascade`;
	await seedRepo({ imageBuildEnabled: true });
});

afterAll(async () => {
	await sql.end();
});

describe("claimBuildSlot — the concurrency guarantee is the index, not a code path", () => {
	it("lets exactly one of two simultaneous claims win, against real Postgres", async () => {
		const now = new Date();
		const [a, b] = await Promise.all([
			claimBuildSlot({ id: repoId, orgId }, "sha1", now),
			claimBuildSlot({ id: repoId, orgId }, "sha1", now),
		]);

		const winners = [a, b].filter((row) => row !== null);
		expect(winners).toHaveLength(1);

		// And the database agrees: exactly one in-flight build for the repo.
		const active = await db
			.select({ id: imageBuilds.id })
			.from(imageBuilds)
			.where(and(eq(imageBuilds.repoId, repoId), isNull(imageBuilds.finishedAt)));
		expect(active).toHaveLength(1);
	});

	it("lets a new build start once the previous one has finished", async () => {
		const now = new Date();
		const first = await claimBuildSlot({ id: repoId, orgId }, "sha1", now);
		expect(first).not.toBeNull();
		// Second claim while the first is still running is refused.
		expect(await claimBuildSlot({ id: repoId, orgId }, "sha1", now)).toBeNull();

		// Finish the first, and the next claim succeeds — the index is partial on running.
		await db
			.update(imageBuilds)
			.set({ status: "success", finishedAt: now })
			.where(eq(imageBuilds.id, first!.id));
		expect(await claimBuildSlot({ id: repoId, orgId }, "sha2", now)).not.toBeNull();
	});
});

describe("tickImageBuilds", () => {
	it("publishes the pointer on success and records a success build", async () => {
		const result = await tickImageBuilds(new Date(), {
			provider: fakeProvider,
			resolveHead: async () => "a".repeat(40),
			build: succeedingBuild(),
		});
		expect(result.built).toBe(1);

		const p = await pointer();
		expect(p?.imageRef).toBe(`harbor-repo-${repoId}:${"a".repeat(12)}`);
		expect(p?.builtFromSha).toBe("a".repeat(40));
		expect(p?.builtAt).not.toBeNull();
		expect(p?.consecutiveFailures).toBe(0);

		const builds = await db.select().from(imageBuilds).where(eq(imageBuilds.repoId, repoId));
		expect(builds.filter((b) => b.status === "success")).toHaveLength(1);
	});

	it("a failed build publishes nothing and leaves the previous pointer intact", async () => {
		// First, a good image at sha 'aaaa…'.
		await tickImageBuilds(new Date(), {
			provider: fakeProvider,
			resolveHead: async () => "a".repeat(40),
			build: succeedingBuild(),
		});
		const before = await pointer();
		expect(before?.imageRef).toBe(`harbor-repo-${repoId}:${"a".repeat(12)}`);

		// Now a build at a NEW sha that fails.
		await makeDue();
		const result = await tickImageBuilds(new Date(), {
			provider: fakeProvider,
			resolveHead: async () => "b".repeat(40),
			build: failingBuild(),
		});
		expect(result.failed).toBe(1);

		const after = await pointer();
		// The pointer is exactly the previous good image — a session spawned now boots it.
		expect(after?.imageRef).toBe(before?.imageRef);
		expect(after?.builtFromSha).toBe("a".repeat(40));
		expect(after?.consecutiveFailures).toBe(1);
		const failed = await db
			.select()
			.from(imageBuilds)
			.where(and(eq(imageBuilds.repoId, repoId), eq(imageBuilds.status, "failed")));
		expect(failed).toHaveLength(1);
	});

	it("skips a rebuild when the default-branch HEAD has not moved", async () => {
		await tickImageBuilds(new Date(), {
			provider: fakeProvider,
			resolveHead: async () => "a".repeat(40),
			build: succeedingBuild(),
		});
		await makeDue();
		const result = await tickImageBuilds(new Date(), {
			provider: fakeProvider,
			resolveHead: async () => "a".repeat(40), // unchanged
			build: succeedingBuild(),
		});
		expect(result.built).toBe(0);
		expect(result.skipped).toBe(1);
		const skipped = await db
			.select()
			.from(imageBuilds)
			.where(and(eq(imageBuilds.repoId, repoId), eq(imageBuilds.status, "skipped")));
		expect(skipped).toHaveLength(1);
		expect(skipped[0]?.failureReason).toBe("head_unchanged");
	});

	it("auto-pauses after the configured number of consecutive failures", async () => {
		// Lower the threshold for this repo to 2.
		await db.update(repos).set({ config: { imageBuildEnabled: true, circuitFailureThreshold: 2 } }).where(eq(repos.id, repoId));

		for (let i = 0; i < 2; i++) {
			await makeDue();
			await tickImageBuilds(new Date(), {
				provider: fakeProvider,
				resolveHead: async () => `${i}`.repeat(40),
				build: failingBuild(),
			});
		}
		const paused = await pointer();
		expect(paused?.consecutiveFailures).toBe(2);
		expect(paused?.pausedReason).toContain("Paused after 2 consecutive failed builds");

		// A paused repo is not due: a further tick builds nothing, even forced due.
		await makeDue();
		const result = await tickImageBuilds(new Date(), {
			provider: fakeProvider,
			resolveHead: async () => "c".repeat(40),
			build: failingBuild(),
		});
		expect(result.built + result.failed).toBe(0);
	});

	it("refuses to build when the org is over its spend cap, and records the skip", async () => {
		// A tiny cap, and a day's spend already past it. The build's own estimate is
		// zero, so the refusal has to come from spend already counted, not the estimate.
		await recordCost({ orgId, key: "seed-spend", kind: "image_build", microUsd: 1_000, actor: "harbor" });
		await db
			.update(repos)
			.set({ config: { imageBuildEnabled: true, maxSpendPerDayMicroUsd: 1 } })
			.where(eq(repos.id, repoId));
		const result = await tickImageBuilds(new Date(), {
			provider: fakeProvider,
			resolveHead: async () => "a".repeat(40),
			build: succeedingBuild(),
		});
		expect(result.built).toBe(0);
		expect(result.skipped).toBe(1);
		const skipped = await db
			.select()
			.from(imageBuilds)
			.where(and(eq(imageBuilds.repoId, repoId), eq(imageBuilds.status, "skipped")));
		expect(skipped[0]?.failureReason).toContain("budget_refused");
		// Nothing was published.
		expect((await pointer())?.imageRef).toBeNull();
	});

	it("does nothing for a repo that has not opted in", async () => {
		await db.update(repos).set({ config: {} }).where(eq(repos.id, repoId));
		const result = await tickImageBuilds(new Date(), {
			provider: fakeProvider,
			resolveHead: async () => "a".repeat(40),
			build: succeedingBuild(),
		});
		expect(result).toEqual({ built: 0, skipped: 0, failed: 0, paused: 0 });
		// No pointer row is even created for a repo that never opted in.
		expect(await pointer()).toBeUndefined();
	});
});
