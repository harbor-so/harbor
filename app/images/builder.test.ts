// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The builder's contract, without Docker or a network.
 *
 * The build mechanics live in the provider and are exercised by the provider contract
 * against real Docker. What is tested here is the orchestration the builder owns: it
 * refuses a provider that cannot build, and it hands the provider a config that puts
 * the box in `build` mode with the right repo pinned — the two things a wrong value in
 * would make every build silently produce the wrong image.
 */

import { describe, expect, it } from "vitest";
import { setting } from "@core/kernel/config.js";
import type { ImageBuildConfig, ImageBuildingProvider, SandboxProvider } from "../sandbox/provider.js";
import { localProvider } from "../sandbox/providers/local.js";
import { buildRepoImage, repoImageTag } from "./builder.js";

/** A provider the builder narrows to and records the build config it receives. */
function recordingProvider(): SandboxProvider & ImageBuildingProvider & { calls: ImageBuildConfig[] } {
	const calls: ImageBuildConfig[] = [];
	const provider = {
		name: "rec",
		kind: "snapshot",
		buildsImages: true,
		calls,
		buildImage: async (config: ImageBuildConfig) => {
			calls.push(config);
			return { imageRef: config.targetTag, provider: "rec", log: "ok" };
		},
		pruneImages: async () => [],
	};
	return provider as unknown as SandboxProvider & ImageBuildingProvider & { calls: ImageBuildConfig[] };
}

const REPO = { name: "web", url: "https://github.com/acme/web.git", sha: "a".repeat(40) };

describe("buildRepoImage", () => {
	it("refuses a provider that cannot build images, by name", async () => {
		await expect(
			buildRepoImage({ orgId: "o", repoId: "r", provider: localProvider(), repo: REPO }),
		).rejects.toThrow(/cannot build images/);
	});

	it("boots the base in build mode with the repo pinned to the SHA", async () => {
		const provider = recordingProvider();
		const result = await buildRepoImage({ orgId: "o", repoId: "repo-1", provider, repo: REPO });

		expect(provider.calls).toHaveLength(1);
		const config = provider.calls[0]!;
		// Empty imageBaseImage means "use sandboxImage".
		expect(config.base).toBe(setting("sandboxImage"));
		expect(config.targetTag).toBe(repoImageTag("repo-1", REPO.sha));
		expect(config.workspace).toBe("/workspace");
		expect(config.env.HARBOR_BOOT_MODE).toBe("build");
		expect(JSON.parse(config.env.HARBOR_REPOS!)).toEqual([
			{ name: "web", url: REPO.url, ref: REPO.sha },
		]);

		expect(result.imageRef).toBe(config.targetTag);
		expect(result.commitSha).toBe(REPO.sha);
	});

	it("builds from a per-repo base image override when set", async () => {
		const provider = recordingProvider();
		await buildRepoImage({
			orgId: "o",
			repoId: "repo-1",
			provider,
			repo: REPO,
			overrides: { imageBaseImage: "acme/base:1" },
		});
		expect(provider.calls[0]!.base).toBe("acme/base:1");
	});

	it("does not let caller env shadow the boot mode", async () => {
		const provider = recordingProvider();
		await buildRepoImage({
			orgId: "o",
			repoId: "repo-1",
			provider,
			repo: REPO,
			env: { HARBOR_BOOT_MODE: "fresh", SOME_TOKEN: "secret" },
		});
		const config = provider.calls[0]!;
		expect(config.env.HARBOR_BOOT_MODE).toBe("build");
		// The caller's own extra env still rides along (e.g. credentials).
		expect(config.env.SOME_TOKEN).toBe("secret");
	});
});
