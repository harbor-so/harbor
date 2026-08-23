// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The container entrypoint for an image build. It boots, it does not serve.
 *
 * A build runs the exact same provisioning a fresh session runs — clone the pinned
 * SHA, run `.harbor/setup.sh` — but with no control plane, no session, no agent and
 * no bridge. So it reuses the supervisor's pure `boot()` sequence in `build` mode and
 * then *exits*, rather than going through `main()`, which connects a `Bridge` to a
 * control-plane URL that does not exist at build time and would hang trying.
 *
 * What this module refuses to do: connect to the control plane, start an agent, open
 * a tunnel, or exit zero on a failed `setup.sh`. In `build` mode `hookPolicy` makes
 * setup fatal, so a non-zero setup makes `boot()` return `failed` and this process
 * exits 1 — which the docker provider reads as "do not commit", so a broken setup
 * never becomes a published image. The provider does the `docker commit` from
 * outside, only after this exits 0.
 *
 * The bridge is a stdout sink: boot events and warnings are printed as JSON so they
 * land in `docker logs`, which the provider tails into the `image_builds` record for
 * the human debugging a failed build. There is no other consumer.
 */

import { AGENT_RUNTIMES } from "../app/contracts/agent.js";
import { validateConfig } from "../core/kernel/config.js";
import { boot, parseRepos, type BridgeSink, type SupervisorConfig } from "./supervisor.js";

async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
	try {
		// The one coherence gate a build shares with a boot: setup's timeout must fit
		// inside the outer budget, or the build is killed while behaving as configured.
		validateConfig();
	} catch (error) {
		console.error(`[build-entry] configuration is incoherent: ${(error as Error).message}`);
		return 1;
	}

	let repos;
	try {
		repos = parseRepos(env.HARBOR_REPOS ?? "[]");
	} catch (error) {
		console.error(`[build-entry] HARBOR_REPOS: ${(error as Error).message}`);
		return 1;
	}
	if (repos.length === 0) {
		console.error("[build-entry] HARBOR_REPOS is empty; a build with no repository to clone is a no-op.");
		return 1;
	}

	const config: SupervisorConfig = {
		// The control plane is absent at build time. These four are structurally
		// required by boot()'s config shape but never read by the boot path — the
		// bridge that would use them is a stdout sink, and no agent runs.
		controlUrl: "",
		sandboxId: env.HARBOR_SANDBOX_ID ?? "build",
		sessionId: env.HARBOR_SESSION_ID ?? "build",
		token: "",
		fencingToken: 0,
		// Irrelevant in build mode — no agent is started — but the type requires one.
		runtime: AGENT_RUNTIMES[0],
		workspaceRoot: (env.HARBOR_WORKSPACE_ROOT ?? "/workspace").trim(),
		repos,
		// The whole point: `build` makes setup.sh fatal and start.sh skipped.
		requestedBootMode: "build",
	};

	const sink: BridgeSink = {
		emit: (event) => {
			console.log(JSON.stringify(event));
		},
	};

	const outcome = await boot(config, sink, env);
	return outcome.kind === "ready" ? 0 : 1;
}

// Only when executed, never when imported by a test.
if (process.argv[1] !== undefined && process.argv[1].endsWith("build-entry.js")) {
	main().then(
		(code) => process.exit(code),
		(error) => {
			console.error("[build-entry] unhandled:", error);
			process.exit(1);
		},
	);
}

export { main as runBuildEntry };
