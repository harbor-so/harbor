#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Publish the sandbox image to a registry a remote provider can pull from.
 *
 * `npm run sandbox:build` tags `harbor-sandbox:latest` on the machine that ran
 * it, which is everything the `docker` provider needs and nothing any remote
 * provider can use. A Fly Machine, a Modal Sandbox and a Northflank service all
 * boot an image *the vendor* pulls, so a local tag is not a smaller version of
 * the right thing — it is unusable.
 *
 * Written as a Node script with an injectable spawn rather than a line in
 * `package.json`, for the same reason `scripts/lint-config.mjs` is: the guards
 * are the valuable part, and a guard nobody can test is a guard that stops
 * working. Plain ESM JavaScript so it runs with no TypeScript toolchain in front
 * of it, matching lint-config.mjs.
 *
 * `sandbox:build` is deliberately left exactly as it was. The laptop path must
 * not grow a registry dependency — that is the product's whole first chapter.
 */

import { spawn } from "node:child_process";

/** The default platform pair. arm64 is not optional in practice — see `buildArgs`. */
const DEFAULT_PLATFORMS = "linux/amd64,linux/arm64";

/**
 * Is this a reference some other machine could pull?
 *
 * The rule docker itself uses: a registry host is the part before the first `/`,
 * and it is a hostname only if it contains a dot or a colon, or is `localhost`.
 * So `harbor-sandbox:latest` and `library/harbor-sandbox` are Docker-Hub-relative
 * names, while `ghcr.io/you/harbor-sandbox` and `registry.fly.io/app` are not.
 *
 * Hub-relative names are rejected rather than pushed. Pushing to Docker Hub under
 * whatever account happens to be logged in is not a thing to do by accident, and
 * the common case — an operator who never changed `HARBOR_SANDBOX_IMAGE` — would
 * otherwise fail deep inside `docker push` with a permissions error about a
 * repository they have never heard of.
 */
export function hasRegistryHost(image) {
	const first = image.split("/")[0];
	if (image.split("/").length < 2) return false;
	return first === "localhost" || first.includes(".") || first.includes(":");
}

/** The `docker buildx build` argv, as data, so a test can assert it. */
export function buildArgs(env = process.env) {
	const image = env.HARBOR_SANDBOX_IMAGE ?? "harbor-sandbox:latest";
	const platforms = env.HARBOR_SANDBOX_PLATFORMS ?? DEFAULT_PLATFORMS;

	const args = [
		"buildx",
		"build",
		"-f",
		"sandbox/Dockerfile",
		"--platform",
		platforms,
		"--tag",
		image,
		"--push",
	];

	// The agent CLIs stay opt-in here exactly as they are in the Dockerfile: ADR
	// 0005's "bring your own agent" claim is false the moment the published image
	// has one baked in by default.
	for (const flag of ["INSTALL_CLAUDE_CODE", "INSTALL_CODEX", "INSTALL_OPENCODE"]) {
		if (env[flag]) args.push("--build-arg", `${flag}=${env[flag]}`);
	}

	args.push(".");
	return { image, platforms, args };
}

/**
 * Why the image must be pushable, spelled out with the fix.
 *
 * Under test, because this is the message that turns "it did not work" into a
 * one-line change, and it is the first wall an operator hits when they move off
 * the `docker` provider.
 */
export function registryErrorMessage(image) {
	return (
		`HARBOR_SANDBOX_IMAGE is ${JSON.stringify(image)}, which has no registry host, so `
		+ "there is nowhere to push it.\n\n"
		+ "Every remote sandbox provider boots an image the VENDOR pulls, so the tag has to "
		+ "name a registry they can reach:\n\n"
		+ "  HARBOR_SANDBOX_IMAGE=ghcr.io/<you>/harbor-sandbox:v1 npm run sandbox:push\n\n"
		+ "If you only use the `docker` provider you do not need this at all — "
		+ "`npm run sandbox:build` is enough. See docs/sandbox-images.md."
	);
}

export async function main({ env = process.env, run = defaultRun, log = console.log } = {}) {
	const { image, platforms, args } = buildArgs(env);

	if (!hasRegistryHost(image)) {
		throw new Error(registryErrorMessage(image));
	}

	// Checked up front rather than left to fail inside the build: `buildx` ships
	// with modern Docker but is absent on older engines and some CI images, and
	// its absence otherwise surfaces as "unknown command", which reads like a
	// broken script rather than a missing plugin.
	const probe = await run("docker", ["buildx", "version"]);
	if (probe !== 0) {
		throw new Error(
			"`docker buildx` is not available, and multi-platform builds need it.\n"
			+ "Install the buildx plugin (it ships with Docker Desktop and recent Docker "
			+ "Engine), or build a single-platform image yourself with `npm run sandbox:build` "
			+ "followed by `docker push`.",
		);
	}

	log(`Building and pushing ${image} for ${platforms} …`);
	const code = await run("docker", args);
	if (code !== 0) throw new Error(`docker buildx build failed with exit code ${code}.`);
	log(`Pushed ${image}.`);
	log(
		"If this is the first push to GHCR, make the package PUBLIC. GHCR defaults to "
		+ "private, Harbor has no per-provider registry credential to offer, and a private "
		+ "image fails the vendor's pull with an authentication error Harbor cannot explain.",
	);
	return image;
}

function defaultRun(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: "inherit" });
		child.on("error", reject);
		child.on("close", (code) => resolve(code ?? 1));
	});
}

// `process.argv[1]` rather than an import.meta.url comparison so this stays
// readable; the test imports the functions above and never triggers this.
const invokedDirectly = process.argv[1]?.endsWith("sandbox-push.mjs");
if (invokedDirectly) {
	main().catch((error) => {
		console.error(`\n${error.message}\n`);
		process.exit(1);
	});
}
