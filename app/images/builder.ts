// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Produce one prebuilt repo image. It builds; it does not publish.
 *
 * This is the effectful middle layer between the pure scheduling decisions
 * (`decisions.ts`) and the container runtime (`ImageBuildingProvider`). It resolves
 * what to build from and what to publish it as, then hands the mechanics — run a
 * container in `build` mode, run `setup.sh`, `docker commit` — to the provider,
 * exactly as `manager.ts` hands a spawn's mechanics to `provider.create`.
 *
 * What this module refuses to do:
 *
 *  - **Publish the pointer.** Advancing `repo_images` is the scheduler's job and must
 *    happen transactionally, on success only. This function returns the built image;
 *    it never writes to the database. Keeping the write out of here is what lets a
 *    failed build leave the previous pointer untouched — there is no code path from a
 *    build failure to a pointer update, because the build path cannot touch pointers.
 *  - **Run on a provider that cannot build.** The provider is narrowed through
 *    `isImageBuildingProvider`; the `local` provider has no `buildImage` and is
 *    refused with a typed error rather than a `buildImage is not a function` crash.
 *  - **Swallow a broken `setup.sh`.** A non-zero setup throws out of `buildImage` and
 *    straight out of here. Nothing here catches it to publish anyway.
 */

import { type RepoOverrides, setting } from "@core/kernel/config.js";
import { BAKED_WORKSPACE_ROOT } from "../contracts/index.js";
import { SandboxProviderError, isImageBuildingProvider, type SandboxProvider } from "../sandbox/provider.js";

/** A repository to bake, pinned to the exact commit the image will be built at. */
export interface BuildRepo {
	/** Directory name under the workspace root; also the git remote's short name. */
	name: string;
	/** The clone URL. */
	url: string;
	/** The default-branch HEAD to build at. Pins the image to a commit for the skip check. */
	sha: string;
}

export interface BuildRequest {
	orgId: string;
	repoId: string;
	provider: SandboxProvider;
	repo: BuildRepo;
	/**
	 * Extra environment for the build container, merged UNDER the required keys.
	 * Carries git credentials for cloning a private repo where the deployment provides
	 * them; the `HARBOR_BOOT_MODE` and `HARBOR_REPOS` keys always win over it.
	 */
	env?: Record<string, string>;
	overrides?: RepoOverrides;
}

export interface BuildResult {
	/** The published image handle, to store in the pointer. */
	imageRef: string;
	/** The commit the image was built at, to store as `builtFromSha`. */
	commitSha: string;
	/** The provider that built it, to store as `builtByProvider`. */
	provider: string;
	/** A bounded tail of the build log, for the `image_builds` record. */
	log: string;
}

/** The image reference a repo's builds publish to, tagged by the built commit. */
export function repoImageTag(repoId: string, sha: string): string {
	return `${repoImageTagPrefix(repoId)}:${sha.slice(0, 12)}`;
}

/**
 * The tag prefix all of a repo's images share, for pruning.
 *
 * Keyed on the repo id, which is a uuid — already lowercase and made only of hex and
 * dashes, every one of which is legal in a docker repository name — so no sanitising
 * is needed and two repos can never collide on a prefix.
 */
export function repoImageTagPrefix(repoId: string): string {
	return `harbor-repo-${repoId}`;
}

/**
 * Build and return one image. Throws `SandboxProviderError` on any build failure,
 * including a non-zero `setup.sh` — which the provider classifies as a config error,
 * not a transient one, so one repo's broken setup never opens the provider's circuit.
 */
export async function buildRepoImage(req: BuildRequest): Promise<BuildResult> {
	if (!isImageBuildingProvider(req.provider)) {
		throw new SandboxProviderError({
			message:
				`Provider ${JSON.stringify(req.provider.name)} cannot build images. Image building is `
				+ "enabled for this repo but the configured provider does not implement it; disable "
				+ "imageBuildEnabled for the repo or configure a provider that can build.",
			errorType: "invalid_config",
			provider: req.provider.name,
			operation: "build_image",
		});
	}

	// Empty base means "use the fleet's sandbox image", so a repo image is always the
	// base sandbox image with dependencies baked on top and the two cannot drift.
	const base = setting("imageBaseImage", req.overrides) || setting("sandboxImage", req.overrides);
	const workspace = "/workspace";
	const targetTag = repoImageTag(req.repoId, req.repo.sha);

	const built = await req.provider.buildImage({
		base,
		targetTag,
		workspace,
		env: {
			// Caller-supplied env (credentials) first, so nothing it carries can shadow
			// the keys that define what the build actually is.
			...(req.env ?? {}),
			HARBOR_BOOT_MODE: "build",
			// Provision into the baked staging path, NOT the workspace volume — a volume
			// is invisible to `docker commit`, so a build that wrote to it would bake an
			// empty tree. See BAKED_WORKSPACE_ROOT. A `repo_image` boot copies it back out.
			HARBOR_WORKSPACE_ROOT: BAKED_WORKSPACE_ROOT,
			HARBOR_REPOS: JSON.stringify([{ name: req.repo.name, url: req.repo.url, ref: req.repo.sha }]),
		},
		// A build runs unrestricted: it needs the network to install dependencies and a
		// writable root to install them into, and it runs the same setup.sh a fresh boot
		// runs. Isolation features are a session concern, not a build one.
		features: {},
		timeoutMs: setting("imageBuildTimeoutMs", req.overrides),
	});

	return {
		imageRef: built.imageRef,
		commitSha: req.repo.sha,
		provider: built.provider,
		log: built.log,
	};
}
