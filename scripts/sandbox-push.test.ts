// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The push script's guards, with an injected spawn — no docker, no registry.
 *
 * The registry-host check is the one that matters. An operator who has never
 * touched `HARBOR_SANDBOX_IMAGE` and decides to try Fly will run this with the
 * default `harbor-sandbox:latest`, and the difference between a useful script and
 * a footgun is whether that fails immediately with the fix in the message or
 * fails deep inside `docker push` talking about a Docker Hub repository they have
 * never heard of.
 */

import { describe, expect, it } from "vitest";
import {
	buildArgs as rawBuildArgs,
	hasRegistryHost as rawHasRegistryHost,
	main as rawMain,
} from "./sandbox-push.mjs";

// `Record<string, string | undefined>` rather than `NodeJS.ProcessEnv`: Next's
// global.d.ts adds a required `NODE_ENV` to that interface, which would force
// every fixture here to carry a variable the script never reads.
type Env = Record<string, string | undefined>;

const hasRegistryHost = rawHasRegistryHost as (image: string) => boolean;
const buildArgs = rawBuildArgs as (env?: Env) => {
	image: string;
	platforms: string;
	args: string[];
};
const main = rawMain as (opts: {
	env?: Env;
	run?: (command: string, args: string[]) => Promise<number>;
	log?: (message: string) => void;
}) => Promise<string>;

/** Records what would have been executed, and reports success for everything. */
function recorder(exitCode = 0) {
	const calls: Array<{ command: string; args: string[] }> = [];
	const run = async (command: string, args: string[]) => {
		calls.push({ command, args });
		return exitCode;
	};
	return { calls, run, log: () => {} };
}

describe("hasRegistryHost", () => {
	it("rejects the local default, which cannot be pushed anywhere", () => {
		expect(hasRegistryHost("harbor-sandbox:latest")).toBe(false);
	});

	it("rejects a Docker-Hub-relative name rather than pushing to whoever is logged in", () => {
		expect(hasRegistryHost("someuser/harbor-sandbox:v1")).toBe(false);
	});

	it("accepts a real registry reference", () => {
		expect(hasRegistryHost("ghcr.io/acme/harbor-sandbox:v1")).toBe(true);
		expect(hasRegistryHost("registry.fly.io/harbor-app:latest")).toBe(true);
		expect(hasRegistryHost("localhost:5000/harbor-sandbox")).toBe(true);
	});
});

describe("main — the registry guard", () => {
	it("refuses the default tag, and the message shows the fix", async () => {
		await expect(main({ env: {}, ...recorder() })).rejects.toThrow(/no registry host/);
		await expect(main({ env: {}, ...recorder() })).rejects.toThrow(
			/HARBOR_SANDBOX_IMAGE=ghcr\.io/,
		);
	});

	it("says that sandbox:build alone is enough for the docker provider", async () => {
		await expect(main({ env: {}, ...recorder() })).rejects.toThrow(/sandbox:build` is enough/);
	});

	it("never invokes docker when the tag is unpushable", async () => {
		const rec = recorder();
		await main({ env: {}, ...rec }).catch(() => {});
		expect(rec.calls).toEqual([]);
	});
});

describe("main — buildx", () => {
	it("fails with an actionable message when buildx is missing", async () => {
		const run = async (_c: string, args: string[]) => (args[1] === "version" ? 1 : 0);
		await expect(
			main({ env: { HARBOR_SANDBOX_IMAGE: "ghcr.io/a/b:1" }, run, log: () => {} }),
		).rejects.toThrow(/buildx` is not available/);
	});

	it("surfaces a non-zero build as an error rather than reporting success", async () => {
		const run = async (_c: string, args: string[]) => (args[1] === "version" ? 0 : 7);
		await expect(
			main({ env: { HARBOR_SANDBOX_IMAGE: "ghcr.io/a/b:1" }, run, log: () => {} }),
		).rejects.toThrow(/exit code 7/);
	});
});

describe("buildArgs", () => {
	it("builds both architectures by default", () => {
		const { platforms, args } = buildArgs({ HARBOR_SANDBOX_IMAGE: "ghcr.io/a/b:1" });
		// arm64 is not a nicety: several sandbox vendors run arm, and an amd64-only
		// image fails at boot with an exec-format error that reads like a Harbor bug.
		expect(platforms).toBe("linux/amd64,linux/arm64");
		expect(args).toContain("--push");
		expect(args).toContain("sandbox/Dockerfile");
	});

	it("honours an explicit platform list", () => {
		const { args } = buildArgs({
			HARBOR_SANDBOX_IMAGE: "ghcr.io/a/b:1",
			HARBOR_SANDBOX_PLATFORMS: "linux/amd64",
		});
		expect(args[args.indexOf("--platform") + 1]).toBe("linux/amd64");
	});

	it("passes the agent CLI flags through, and omits them when unset", () => {
		const withAgent = buildArgs({
			HARBOR_SANDBOX_IMAGE: "ghcr.io/a/b:1",
			INSTALL_CLAUDE_CODE: "1",
		});
		expect(withAgent.args).toContain("INSTALL_CLAUDE_CODE=1");

		// Off by default, so the published image keeps ADR 0005's "bring your own
		// agent" claim true.
		const bare = buildArgs({ HARBOR_SANDBOX_IMAGE: "ghcr.io/a/b:1" });
		expect(bare.args.join(" ")).not.toContain("INSTALL_CLAUDE_CODE");
	});
});
