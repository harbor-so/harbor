// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * One suite every provider must pass, instead of a checklist every provider
 * claims to have read.
 *
 * TypeScript can prove that a provider has a `stop` method. It cannot prove that
 * calling `stop` twice does not throw, that `findByAttemptId` returns `null` only
 * when it is certain, or that a bad image is classified as configuration rather
 * than as a transient outage — and those three are the properties the spawn saga
 * and the circuit breaker are built on top of. A provider that gets any of them
 * wrong compiles perfectly and breaks the layer above in ways that read as
 * "Harbor is flaky".
 *
 * So the contract is executable. `describeProviderContract` is exported: a new
 * backend adds one call to it and inherits the whole suite, which is the cheapest
 * possible way to make "implements the interface" mean something.
 *
 * **Skips are loud.** When docker is not installed the docker suite prints why
 * and skips; it never quietly passes. A green run that tested nothing is worse
 * than a red one, because it is trusted.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import {
	SandboxProviderError,
	assertFeaturesSupported,
	featureEnabled,
	isImageBuildingProvider,
	isLive,
	isPersistentProvider,
	isSnapshotProvider,
	normalizeProviderState,
	resumeStrategyFor,
} from "../provider.js";
import type {
	CreateSandboxConfig,
	EphemeralProvider,
	SandboxProvider,
} from "../provider.js";
import { classifyDockerFailure, dockerProvider, volumeName } from "./docker.js";
import { flyProvider } from "./fly.js";
import { localProvider } from "./local.js";
import { SANDBOX_PROVIDER_NAMES } from "../registry.js";
import { blaxelProvider } from "./blaxel.js";
import { cloudflareProvider } from "./cloudflare.js";
import { codesandboxProvider } from "./codesandbox.js";
import { daytonaProvider } from "./daytona.js";
import { e2bProvider } from "./e2b.js";
import { modalProvider } from "./modal.js";
import { morphProvider } from "./morph.js";
import { northflankProvider } from "./northflank.js";
import { runloopProvider } from "./runloop.js";
import { vercelProvider } from "./vercel.js";
import { providerFor } from "../registry.js";

// ---------------------------------------------------------------------------
// The reusable contract
// ---------------------------------------------------------------------------

/**
 * Per-test ceiling for the cases that talk to a real backend.
 *
 * Not a Harbor tunable — it is vitest's own limit, and test files are exempt from
 * the config lint for exactly this reason. It is generous because the alternative
 * is a suite that passes on the machine it was written on and flakes on a busy CI
 * runner where `docker run` plus `docker commit` of a cold image genuinely takes
 * half a minute. A flaky lifecycle test gets retried, then skipped, then deleted.
 */
const PROVIDER_TEST_TIMEOUT_MS = 120_000;

export interface ProviderContractSpec {
	label: string;
	provider: SandboxProvider;
	/** A config for a throwaway box that will stay up long enough to be inspected. */
	config(): CreateSandboxConfig;
	/** A config whose image (or runtime) cannot possibly work. */
	brokenImageConfig(): CreateSandboxConfig;
	/** Remove whatever the box left behind. Must tolerate a box that never existed. */
	cleanup(config: CreateSandboxConfig): Promise<void>;
}

export function describeProviderContract(spec: ProviderContractSpec): void {
	describe(`${spec.label} provider contract`, () => {
		const created: CreateSandboxConfig[] = [];

		function fresh(): CreateSandboxConfig {
			const config = spec.config();
			created.push(config);
			return config;
		}

		afterEach(async () => {
			while (created.length > 0) await spec.cleanup(created.pop()!);
		});

		test("create → inspect → stop is the whole lifecycle", async () => {
			const config = fresh();
			const box = await spec.provider.create(config);

			expect(box.externalId).toBeTruthy();
			expect(box.attemptId).toBe(config.attemptId);
			expect(box.provider).toBe(spec.provider.name);

			const running = await spec.provider.inspect(box.externalId);
			expect(running).not.toBeNull();
			// Not asserting `running` exactly: a box may legitimately still be
			// `starting`. What must hold is that it reads as alive, because that is the
			// property every caller branches on.
			expect(isLive(running!.state)).toBe(true);
			expect(running!.attemptId).toBe(config.attemptId);

			expect(await spec.provider.stop(box.externalId, { graceMs: 2_000 })).toBe("stopped");

			// After a stop the box is either gone from the backend entirely or present
			// and not live. Both are correct; what would not be correct is still
			// reading as live.
			const after = await spec.provider.inspect(box.externalId);
			if (after) expect(isLive(after.state)).toBe(false);
		}, PROVIDER_TEST_TIMEOUT_MS);

		test("findByAttemptId finds the box it created, and only that one", async () => {
			const config = fresh();
			const box = await spec.provider.create(config);

			const found = await spec.provider.findByAttemptId(config.attemptId);
			expect(found).not.toBeNull();
			expect(found!.externalId).toBe(box.externalId);
			expect(found!.attemptId).toBe(config.attemptId);

			// The reconciliation question for an attempt that never reached the
			// backend. `null` here is what lets the saga spawn; anything else and a
			// legitimate first spawn would be refused forever.
			expect(await spec.provider.findByAttemptId(randomUUID())).toBeNull();

			await spec.provider.stop(box.externalId, { graceMs: 2_000 });
		}, PROVIDER_TEST_TIMEOUT_MS);

		test("listManaged sees the box while it lives and forgets it once stopped", async () => {
			const config = fresh();
			const box = await spec.provider.create(config);

			// The orphan sweep reads this list as the complete population of running
			// boxes, so a created box must appear — with the attempt label intact,
			// because that label is the only join back to the database row.
			const during = await spec.provider.listManaged();
			const mine = during.find((entry) => entry.attemptId === config.attemptId);
			expect(mine).toBeDefined();
			expect(mine!.externalId).toBe(box.externalId);

			await spec.provider.stop(box.externalId, { graceMs: 2_000 });

			// Live boxes only: every entry is a stop candidate, and a stopped
			// container kept for post-mortems must not be one.
			const after = await spec.provider.listManaged();
			expect(after.find((entry) => entry.attemptId === config.attemptId)).toBeUndefined();
		}, PROVIDER_TEST_TIMEOUT_MS);

		test("stop is idempotent, and says which kind of nothing it did", async () => {
			const config = fresh();
			const box = await spec.provider.create(config);

			expect(await spec.provider.stop(box.externalId, { graceMs: 2_000 })).toBe("stopped");
			// The second call must not throw. The stop path is retried by a timeout
			// sweep, by a user pressing the button twice, and by the reconciler after an
			// ambiguous failure; a provider that throws on the second one turns a
			// successful cleanup into a `session_error` on the timeline.
			expect(["already_stopped", "absent"]).toContain(
				await spec.provider.stop(box.externalId, { graceMs: 2_000 }),
			);
		}, PROVIDER_TEST_TIMEOUT_MS);

		test("an impossible image is a configuration error, not a transient one", async () => {
			const config = spec.brokenImageConfig();
			created.push(config);

			const error = await spec.provider.create(config).then(
				() => null,
				(caught: unknown) => caught,
			);

			expect(error).toBeInstanceOf(SandboxProviderError);
			const providerError = error as SandboxProviderError;
			// The classification, not the message, is the contract: `transient` here
			// would count a typo in HARBOR_SANDBOX_IMAGE towards opening the circuit,
			// and three sessions with the same typo would then hide a genuine provider
			// outage behind a user error.
			expect(["not_found", "invalid_config"]).toContain(providerError.errorType);
			expect(providerError.tripsCircuit).toBe(false);
			expect(providerError.provider).toBe(spec.provider.name);
		});

		test("a feature the provider does not implement is refused, never ignored", async () => {
			const config = { ...fresh(), features: { a_feature_no_backend_has: true } };

			const error = await spec.provider.create(config).then(
				() => null,
				(caught: unknown) => caught,
			);

			expect(error).toBeInstanceOf(SandboxProviderError);
			expect((error as SandboxProviderError).errorType).toBe("invalid_config");
		});
	});
}

// ---------------------------------------------------------------------------
// Pure decisions — zero mocks, exact boundaries
// ---------------------------------------------------------------------------

describe("provider decisions", () => {
	test("liveness fails open: an unrecognised state reads as live", () => {
		expect(isLive("unknown")).toBe(true);
		// The deny-list boundary. Only these two may produce `false`.
		expect(isLive("exited")).toBe(false);
		expect(isLive("gone")).toBe(false);
		expect(isLive("starting")).toBe(true);
		expect(isLive("running")).toBe(true);
		expect(isLive("paused")).toBe(true);
	});

	test("a backend state nobody has seen before normalises to unknown, not to dead", () => {
		expect(normalizeProviderState("running")).toBe("running");
		expect(normalizeProviderState("EXITED")).toBe("exited");
		expect(normalizeProviderState("  Paused  ")).toBe("paused");
		expect(normalizeProviderState("created")).toBe("starting");
		// The whole point: docker 30 inventing `hibernating` must not reap live boxes.
		expect(normalizeProviderState("hibernating")).toBe("unknown");
		expect(isLive(normalizeProviderState("hibernating"))).toBe(true);
		expect(normalizeProviderState("")).toBe("unknown");
	});

	test("features are off unless explicitly on", () => {
		const config = { features: { on: true, off: false } } as unknown as CreateSandboxConfig;
		expect(featureEnabled(config, "on")).toBe(true);
		expect(featureEnabled(config, "off")).toBe(false);
		expect(featureEnabled(config, "never_mentioned")).toBe(false);
	});

	test("an unsupported feature that is off is not an error", () => {
		const provider = { name: "test", supportedFeatures: ["known"] };
		const config = { features: { unknown_feature: false } } as unknown as CreateSandboxConfig;
		// Only a feature asked *for* is refused. A map that carries `false` for
		// everything a caller considered is normal and must not fail a spawn.
		expect(() => assertFeaturesSupported(provider, config, "create")).not.toThrow();
		expect(() =>
			assertFeaturesSupported(
				provider,
				{ features: { unknown_feature: true } } as unknown as CreateSandboxConfig,
				"create",
			),
		).toThrow(SandboxProviderError);
	});

	test("docker failures are classified so the breaker treats them differently", () => {
		expect(classifyDockerFailure("Error: No such container: abc", 1)).toBe("not_found");
		expect(
			classifyDockerFailure(
				"pull access denied for nope, repository does not exist or may require 'docker login': denied",
				1,
			),
		).toBe("not_found");
		expect(
			classifyDockerFailure("docker: invalid reference format: repository name must be lowercase", 1),
		).toBe("invalid_config");
		expect(classifyDockerFailure("Cannot connect to the Docker daemon at unix:///var/run/docker.sock", 1))
			.toBe("transient");
		expect(classifyDockerFailure("write /var/lib/docker: no space left on device", 1))
			.toBe("quota_exceeded");
		expect(classifyDockerFailure("toomanyrequests: You have reached your pull rate limit", 1))
			.toBe("rate_limited");
		// A missing CLI is configuration: retrying will not install docker, and
		// counting it would open the circuit on every deployment that forgot it.
		expect(classifyDockerFailure("", "ENOENT")).toBe("invalid_config");
		expect(classifyDockerFailure("something nobody has written a pattern for", 1)).toBe("unknown");
	});

	test("tripsCircuit reads from the contract, not from a second opinion", () => {
		const transient = new SandboxProviderError({
			message: "x",
			errorType: "transient",
			provider: "docker",
			operation: "create",
		});
		const config = new SandboxProviderError({
			message: "x",
			errorType: "invalid_config",
			provider: "docker",
			operation: "create",
		});
		expect(transient.tripsCircuit).toBe(true);
		expect(config.tripsCircuit).toBe(false);
	});

	test("resume strategy is chosen by kind, and every kind has one", () => {
		expect(resumeStrategyFor(dockerProvider()).kind).toBe("snapshot_restore");
		expect(resumeStrategyFor(localProvider())).toEqual({
			kind: "fresh_boot",
			reason: "provider_is_ephemeral",
		});
	});

	test("the registry has no stubs: an unknown name fails immediately and lists what works", () => {
		expect(providerFor("docker").name).toBe("docker");
		expect(providerFor("local").name).toBe("local");
		try {
			// A name that is not in the union. Every provider that IS in the union has
			// a real implementation behind it (that is the no-stubs rule), so the name
			// exercised here must be one nobody has built.
			providerFor("nonexistent-backend");
			throw new Error("expected providerFor to refuse an unimplemented provider");
		} catch (error) {
			expect(error).toBeInstanceOf(SandboxProviderError);
			expect((error as SandboxProviderError).errorType).toBe("invalid_config");
			expect((error as SandboxProviderError).message).toContain("docker");
		}
	});
});

// ---------------------------------------------------------------------------
// Type-level contract — these assertions run at `tsc --noEmit`, not at runtime
// ---------------------------------------------------------------------------

describe("capabilities are types, not runtime booleans", () => {
	test("calling a capability the provider lacks does not compile", () => {
		const ephemeral: EphemeralProvider = localProvider();
		// @ts-expect-error An EphemeralProvider has no restoreFromSnapshot. This line
		// failing to error means the union collapsed and the whole point of the file
		// was lost — a silent `undefined` call on the resume path instead.
		void ephemeral.restoreFromSnapshot;
		// @ts-expect-error Nor snapshot().
		void ephemeral.snapshot;
		// @ts-expect-error Nor pause(): that is the persistent kind.
		void ephemeral.pause;

		// Through the registry, so the static type really is the union. A `const`
		// initialised directly from `dockerProvider()` would be narrowed to
		// SnapshotProvider by control-flow analysis and would prove nothing.
		const anyProvider: SandboxProvider = providerFor("docker");
		// @ts-expect-error Not every member of the union can snapshot, so the union
		// itself cannot. Callers must narrow first — which is exactly the check that
		// a runtime boolean does not give you.
		void anyProvider.snapshot;

		// Narrowing restores it, and this line is the positive half of the proof: if
		// it stopped compiling, snapshot resume would be unreachable.
		if (isSnapshotProvider(anyProvider)) {
			expect(typeof anyProvider.snapshot).toBe("function");
			expect(typeof anyProvider.restoreFromSnapshot).toBe("function");
		}
		expect(isPersistentProvider(anyProvider)).toBe(false);

		// The four base methods exist on every member without narrowing.
		expect(typeof anyProvider.create).toBe("function");
		expect(typeof anyProvider.stop).toBe("function");
		expect(typeof anyProvider.inspect).toBe("function");
		expect(typeof anyProvider.findByAttemptId).toBe("function");
	});

	test("image-building is an orthogonal capability, gated the same way", () => {
		const ephemeral: EphemeralProvider = localProvider();
		// @ts-expect-error The local provider cannot build images and has no buildImage.
		// This line failing to error means image-building leaked onto the base interface,
		// which is the optional-method-plus-boolean shape the whole design rejects.
		void ephemeral.buildImage;

		const anyProvider: SandboxProvider = providerFor("docker");
		// @ts-expect-error Not every member of the union can build, so the union cannot;
		// a caller must narrow through isImageBuildingProvider first.
		void anyProvider.buildImage;

		// docker CAN build — and the guard is what makes buildImage reachable. If this
		// stopped compiling, the image pipeline would have no provider to call.
		if (isImageBuildingProvider(anyProvider)) {
			expect(typeof anyProvider.buildImage).toBe("function");
			expect(typeof anyProvider.pruneImages).toBe("function");
		}
		// The local provider is not image-building, at runtime and at the type level.
		expect(isImageBuildingProvider(localProvider())).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// docker, for real
// ---------------------------------------------------------------------------

function dockerBin(): string {
	return process.env.HARBOR_DOCKER_BIN || "docker";
}

function docker(args: string[]): { ok: boolean; stdout: string; stderr: string } {
	const result = spawnSync(dockerBin(), args, { encoding: "utf8", shell: false });
	return {
		ok: result.status === 0,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? (result.error?.message ?? ""),
	};
}

/**
 * Resolved synchronously at collection time, because `describe.skip` has to be
 * decided before the suite is registered.
 *
 * No image is pulled here. A test that reaches for the network is a test that
 * fails in CI without one and takes ninety seconds to say so; the suite skips
 * loudly instead and names the one command that fixes it.
 */
function resolveDockerFixture(): { image: string } | { reason: string } {
	if (!docker(["version", "--format", "{{.Server.Version}}"]).ok) {
		return { reason: "the docker daemon is not reachable" };
	}
	const candidates = [
		process.env.HARBOR_TEST_SANDBOX_IMAGE,
		"busybox:latest",
		"alpine:latest",
	].filter((image): image is string => Boolean(image));
	for (const image of candidates) {
		if (docker(["image", "inspect", image]).ok) return { image };
	}
	return {
		reason:
			`none of ${candidates.join(", ")} is present locally — run \`docker pull busybox:latest\``,
	};
}

const dockerFixture = resolveDockerFixture();

if ("reason" in dockerFixture) {
	console.warn(
		`[provider-contract] SKIPPING the docker provider suite: ${dockerFixture.reason}. `
			+ "The default provider is therefore untested in this run.",
	);
	describe.skip("docker provider contract (skipped)", () => {
		test.skip("docker was unavailable", () => {});
	});
} else {
	const image = dockerFixture.image;
	const provider = dockerProvider();

	function dockerConfig(overrides: Partial<CreateSandboxConfig> = {}): CreateSandboxConfig {
		return {
			sessionId: randomUUID(),
			sandboxId: randomUUID(),
			attemptId: randomUUID(),
			image,
			workspace: "/workspace",
			env: { HARBOR_TEST: "1" },
			// A create ceiling, resolved by the caller as the contract requires. Short
			// here because the image is already local; a real caller passes
			// setting("sandboxBootTimeoutMs").
			timeoutMs: 60_000,
			features: {},
			// Something that stays up and dies promptly on SIGTERM — `--init` gives it
			// a signal-forwarding PID 1, so the stop path does not wait out the grace.
			command: ["sleep", "600"],
			...overrides,
		};
	}

	async function dockerCleanup(config: CreateSandboxConfig): Promise<void> {
		const ids = docker([
			"ps",
			"--all",
			"--quiet",
			"--no-trunc",
			"--filter",
			`label=harbor.session=${config.sessionId}`,
		])
			.stdout.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		for (const id of ids) docker(["rm", "--force", "--volumes", id]);
		docker(["volume", "rm", "--force", volumeName(config.sessionId)]);
	}

	describeProviderContract({
		label: "docker",
		provider,
		config: () => dockerConfig(),
		// An invalid *reference*, not a missing repository: it fails on argument
		// parsing rather than on a registry round trip, so the assertion holds on a
		// machine with no network and takes milliseconds instead of a pull timeout.
		brokenImageConfig: () => dockerConfig({ image: "not_a_valid_image_reference::" }),
		cleanup: dockerCleanup,
	});

	describe("docker snapshot and restore", () => {
		const sessions: CreateSandboxConfig[] = [];
		const images: string[] = [];

		afterAll(async () => {
			for (const config of sessions) await dockerCleanup(config);
			for (const handle of images) docker(["rmi", "--force", handle]);
		});

		test("a snapshot restores into a NEW box, not the old one", async () => {
			const config = dockerConfig();
			sessions.push(config);
			const box = await provider.create(config);

			const snapshot = await provider.snapshot(box.externalId);
			images.push(snapshot.handle);
			expect(snapshot.provider).toBe("docker");
			expect(snapshot.sourceExternalId).toBe(box.externalId);

			const restoreConfig = dockerConfig({ sessionId: config.sessionId });
			sessions.push(restoreConfig);
			const restored = await provider.restoreFromSnapshot(snapshot, restoreConfig);

			// The defining property of the `snapshot` kind, and the reason it is not
			// modelled as pause/resume: the caller has a second box with a second id and
			// must register it as such. A caller that updated the old row in place would
			// leak the original container.
			expect(restored.externalId).not.toBe(box.externalId);
			expect(restored.attemptId).toBe(restoreConfig.attemptId);

			const inspected = await provider.inspect(restored.externalId);
			expect(inspected).not.toBeNull();
			expect(isLive(inspected!.state)).toBe(true);

			await provider.stop(box.externalId, { graceMs: 2_000 });
			await provider.stop(restored.externalId, { graceMs: 2_000 });
		}, PROVIDER_TEST_TIMEOUT_MS);

		test("a snapshot handle from another provider is refused", async () => {
			const error = await provider
				.restoreFromSnapshot(
					{
						provider: "kubernetes",
						handle: "some-remote-handle",
						sourceExternalId: "x",
						takenAt: new Date().toISOString(),
					},
					dockerConfig(),
				)
				.then(
					() => null,
					(caught: unknown) => caught,
				);
			expect(error).toBeInstanceOf(SandboxProviderError);
			expect((error as SandboxProviderError).errorType).toBe("invalid_config");
		});
	});

	describe("docker argument hygiene", () => {
		test("a value that would be read as a flag is refused before it reaches docker", async () => {
			const error = await provider.create(dockerConfig({ image: "--privileged" })).then(
				() => null,
				(caught: unknown) => caught,
			);
			expect(error).toBeInstanceOf(SandboxProviderError);
			expect((error as SandboxProviderError).errorType).toBe("invalid_config");
			expect((error as SandboxProviderError).message).toContain("flag");
		});

		test("an environment variable name that is not an identifier is refused", async () => {
			const error = await provider
				.create(dockerConfig({ env: { "NOT=AN=IDENTIFIER": "x" } }))
				.then(
					() => null,
					(caught: unknown) => caught,
				);
			expect(error).toBeInstanceOf(SandboxProviderError);
			expect((error as SandboxProviderError).errorType).toBe("invalid_config");
		});
	});

	// The real `buildImage` — running a container in `build` mode and committing it —
	// needs the harbor sandbox image with `build-entry.js` baked in and a clonable
	// repo, so it is covered by the manual end-to-end in the PR rather than here. What
	// runs against any Docker is the prune half of the capability.
	describe("docker image building capability", () => {
		test("pruneImages removes images under the prefix except those kept", async () => {
			if (!isImageBuildingProvider(provider)) throw new Error("docker must be image-building");
			const prefix = `harbor-repo-ctest-${randomUUID().slice(0, 8)}`;
			const keep = `${prefix}:keep`;
			const drop = `${prefix}:drop`;
			docker(["tag", image, keep]);
			docker(["tag", image, drop]);
			try {
				const removed = await provider.pruneImages(prefix, [keep]);
				expect(removed).toContain(drop);
				expect(removed).not.toContain(keep);
				expect(docker(["image", "inspect", keep]).ok).toBe(true);
				expect(docker(["image", "inspect", drop]).ok).toBe(false);
			} finally {
				docker(["rmi", "--force", keep]);
				docker(["rmi", "--force", drop]);
			}
		}, PROVIDER_TEST_TIMEOUT_MS);
	});
}

// ---------------------------------------------------------------------------
// local — the guards, which run everywhere because they must never regress
// ---------------------------------------------------------------------------

/**
 * These cases execute nothing.
 *
 * Every one of them asserts that the local provider refuses *before* it reaches
 * `spawn`, which is why they are safe to run on any machine and why they are not
 * gated behind `HARBOR_ENABLE_RUNNER` like the lifecycle suite below. They are
 * also the only coverage the security-critical half of that file gets on a
 * machine with no coding agent installed, and an untested guard is a guard that
 * gets refactored away.
 */
describe("local provider guards", () => {
	const provider = localProvider();

	function withEnv<T>(env: Record<string, string | undefined>, body: () => T): T {
		const previous = { ...process.env };
		Object.assign(process.env, env);
		for (const [key, value] of Object.entries(env)) {
			if (value === undefined) delete process.env[key];
		}
		try {
			return body();
		} finally {
			for (const key of Object.keys(process.env)) delete process.env[key];
			Object.assign(process.env, previous);
		}
	}

	function config(overrides: Partial<CreateSandboxConfig> = {}): CreateSandboxConfig {
		return {
			sessionId: randomUUID(),
			sandboxId: randomUUID(),
			attemptId: randomUUID(),
			image: "claude-code",
			workspace: ".",
			env: {},
			timeoutMs: 1_000,
			features: {},
			command: ["hello"],
			...overrides,
		};
	}

	async function refusal(promise: Promise<unknown>): Promise<SandboxProviderError> {
		const error = await promise.then(
			() => null,
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(SandboxProviderError);
		return error as SandboxProviderError;
	}

	test("nothing runs unless the operator explicitly enabled it", async () => {
		const error = await withEnv({ HARBOR_ENABLE_RUNNER: undefined }, () =>
			refusal(provider.create(config())),
		);
		expect(error.errorType).toBe("invalid_config");
		expect(error.message).toContain("HARBOR_ENABLE_RUNNER=1");
	});

	test("the workspace is the operator's to choose, not the caller's", async () => {
		const error = await withEnv(
			{ HARBOR_ENABLE_RUNNER: "1", HARBOR_WORKSPACE_DIR: undefined },
			() => refusal(provider.create(config())),
		);
		expect(error.errorType).toBe("invalid_config");
		expect(error.message).toContain("HARBOR_WORKSPACE_DIR");
	});

	test("a workspace that escapes the operator's directory is refused", async () => {
		const error = await withEnv(
			{ HARBOR_ENABLE_RUNNER: "1", HARBOR_WORKSPACE_DIR: tmpdir() },
			() => refusal(provider.create(config({ workspace: "../../etc" }))),
		);
		expect(error.errorType).toBe("invalid_config");
	});

	test("a sibling directory sharing a prefix is not inside the workspace", async () => {
		// `/tmp/harbor-work-evil` must not pass as a child of `/tmp/harbor-work`.
		// This is the prefix-comparison bug, and it is the reason containment is
		// checked with a separator appended rather than with startsWith on the raw
		// string.
		const root = path.join(tmpdir(), "harbor-work");
		const error = await withEnv(
			{ HARBOR_ENABLE_RUNNER: "1", HARBOR_WORKSPACE_DIR: root },
			() => refusal(provider.create(config({ workspace: "../harbor-work-evil" }))),
		);
		expect(error.errorType).toBe("invalid_config");
	});

	test("only the allow-listed runtimes may be started", async () => {
		const error = await withEnv(
			{ HARBOR_ENABLE_RUNNER: "1", HARBOR_WORKSPACE_DIR: tmpdir() },
			() => refusal(provider.create(config({ image: "bash" }))),
		);
		expect(error.errorType).toBe("invalid_config");
		expect(error.message).toContain("claude-code");
	});

	test("the caller supplies a prompt, never flags", async () => {
		const error = await withEnv(
			{ HARBOR_ENABLE_RUNNER: "1", HARBOR_WORKSPACE_DIR: tmpdir() },
			() =>
				refusal(
					provider.create(config({ command: ["prompt", "--dangerously-skip-permissions"] })),
				),
		);
		expect(error.errorType).toBe("invalid_config");
	});

	test("an attempt id that would escape the state directory is refused", async () => {
		const error = await withEnv(
			{ HARBOR_ENABLE_RUNNER: "1", HARBOR_WORKSPACE_DIR: tmpdir() },
			() => refusal(provider.findByAttemptId("../../etc/cron.d/harbor")),
		);
		expect(error.errorType).toBe("invalid_config");
	});

	test("an unknown attempt is definitively absent, not an error", async () => {
		const found = await withEnv(
			{ HARBOR_ENABLE_RUNNER: "1", HARBOR_WORKSPACE_DIR: tmpdir() },
			() => provider.findByAttemptId(randomUUID()),
		);
		expect(found).toBeNull();
	});

	test("a malformed external id is rejected rather than parsed optimistically", async () => {
		const error = await withEnv(
			{ HARBOR_ENABLE_RUNNER: "1", HARBOR_WORKSPACE_DIR: tmpdir() },
			() => refusal(provider.inspect("local:only-two-parts")),
		);
		expect(error.errorType).toBe("invalid_config");
	});
});

// ---------------------------------------------------------------------------
// local lifecycle, only where an operator has explicitly asked for it
// ---------------------------------------------------------------------------

/**
 * The local provider executes a coding agent on the machine running the tests.
 *
 * That is not something a test suite may decide to do on someone's behalf, so it
 * runs only when the same two variables that enable the provider in production
 * are set, plus a runtime binary on PATH. Anything else skips loudly.
 */
function resolveLocalFixture(): { runtime: string } | { reason: string } {
	if (process.env.HARBOR_ENABLE_RUNNER !== "1") {
		return { reason: "HARBOR_ENABLE_RUNNER is not 1 (this provider runs agents on this host)" };
	}
	if (!process.env.HARBOR_WORKSPACE_DIR) return { reason: "HARBOR_WORKSPACE_DIR is not set" };
	for (const runtime of ["claude-code", "codex"] as const) {
		const bin = runtime === "claude-code" ? "claude" : "codex";
		// PATH walked by hand rather than `command -v` through a shell. Node warns
		// about `shell: true` with arguments for good reason, and a file whose whole
		// subject is "never hand attacker-influenced strings to a shell" should not
		// open one to find out whether a binary exists.
		const found = (process.env.PATH ?? "")
			.split(path.delimiter)
			.filter(Boolean)
			.some((dir) => existsSync(path.join(dir, bin)));
		if (found) return { runtime };
	}
	return { reason: "neither `claude` nor `codex` is on PATH" };
}

const localFixture = resolveLocalFixture();

if ("reason" in localFixture) {
	console.warn(
		`[provider-contract] SKIPPING the local provider suite: ${localFixture.reason}. `
			+ "Set HARBOR_ENABLE_RUNNER=1 and HARBOR_WORKSPACE_DIR to exercise it.",
	);
	describe.skip("local provider contract (skipped)", () => {
		test.skip("the local provider was not enabled", () => {});
	});
} else {
	const provider = localProvider();
	const runtime = localFixture.runtime;

	function localConfig(overrides: Partial<CreateSandboxConfig> = {}): CreateSandboxConfig {
		return {
			sessionId: randomUUID(),
			sandboxId: randomUUID(),
			attemptId: randomUUID(),
			image: runtime,
			workspace: ".",
			env: {},
			timeoutMs: 60_000,
			features: {},
			command: ["Reply with the single word ok and make no edits."],
			...overrides,
		};
	}

	describeProviderContract({
		label: "local",
		provider,
		config: () => localConfig(),
		brokenImageConfig: () => localConfig({ image: "a-runtime-that-does-not-exist" }),
		cleanup: async (config) => {
			const found = await provider.findByAttemptId(config.attemptId).catch(() => null);
			if (found) await provider.stop(found.externalId, { graceMs: 1_000 }).catch(() => {});
		},
	});
}

// ---------------------------------------------------------------------------
// Fly — runs against real Fly when credentials are present, skips loud otherwise.
// The unit-level behaviour (state mapping, fail-closed reconciliation, status
// classification) is covered against an injected fetch in `fly.test.ts`; this
// block is the live-infra half, and it costs a Fly account plus a pushed image,
// so it is opt-in behind three variables rather than run by default.
// ---------------------------------------------------------------------------

const flyReady =
	Boolean(process.env.FLY_API_TOKEN) &&
	Boolean(process.env.FLY_APP_NAME) &&
	Boolean(process.env.FLY_TEST_IMAGE);

if (!flyReady) {
	console.warn(
		"[provider-contract] SKIPPING the fly provider suite: set FLY_API_TOKEN, FLY_APP_NAME "
			+ "and FLY_TEST_IMAGE (a pushed image that idles) to exercise it against real Fly. "
			+ "Its logic is still covered by fly.test.ts against an injected fetch.",
	);
	describe.skip("fly provider contract (skipped)", () => {
		test.skip("fly credentials were not provided", () => {});
	});
} else {
	const provider = flyProvider();

	function flyConfig(overrides: Partial<CreateSandboxConfig> = {}): CreateSandboxConfig {
		return {
			sessionId: randomUUID(),
			sandboxId: randomUUID(),
			attemptId: randomUUID(),
			image: process.env.FLY_TEST_IMAGE!,
			workspace: "/workspace",
			env: {},
			timeoutMs: 120_000,
			features: {},
			...overrides,
		};
	}

	describeProviderContract({
		label: "fly",
		provider,
		config: () => flyConfig(),
		brokenImageConfig: () => flyConfig({ image: "registry.fly.io/does-not-exist:nope" }),
		cleanup: async (config) => {
			const found = await provider.findByAttemptId(config.attemptId).catch(() => null);
			if (found) await provider.stop(found.externalId).catch(() => {});
		},
	});
}

// ---------------------------------------------------------------------------
// The remote providers added alongside Fly — E2B, Daytona, Modal, Runloop, Morph,
// Blaxel, CodeSandbox, Vercel, Cloudflare, Northflank.
//
// Every one of them is fully covered at the unit level against an injected
// transport in its own `<name>.test.ts` — that is where state mapping, HTTP/SDK
// error classification, fail-closed reconciliation and idempotent stop are
// proven, with no account required and no network touched. THIS block is the
// live-infra half: it costs a real vendor account plus a bootable image/template,
// so each provider is opt-in behind its own credentials and, crucially, SKIPS
// LOUD when they are absent. A green run that silently tested nothing is worse
// than a red one, so the skip names exactly which variables to set.
// ---------------------------------------------------------------------------

interface RemoteContractSpec {
	label: string;
	/** Env vars that must all be present for the live suite to run. */
	requiredEnv: string[];
	/** The env var holding a bootable image/template ref for this backend. */
	imageEnv: string;
	/** A ref that cannot possibly boot, to prove `not_found`/`invalid_config`. */
	brokenImage: string;
	build(): SandboxProvider;
}

function describeRemoteProvider(spec: RemoteContractSpec): void {
	const missing = spec.requiredEnv.filter((name) => !process.env[name]);
	if (missing.length > 0) {
		console.warn(
			`[provider-contract] SKIPPING the ${spec.label} provider suite: set `
				+ `${spec.requiredEnv.join(", ")} to exercise it against real ${spec.label}. `
				+ `Missing: ${missing.join(", ")}. Its logic is still covered by `
				+ `${spec.label}.test.ts against an injected transport.`,
		);
		describe.skip(`${spec.label} provider contract (skipped)`, () => {
			test.skip(`${spec.label} credentials were not provided`, () => {});
		});
		return;
	}

	const provider = spec.build();
	const config = (overrides: Partial<CreateSandboxConfig> = {}): CreateSandboxConfig => ({
		sessionId: randomUUID(),
		sandboxId: randomUUID(),
		attemptId: randomUUID(),
		image: process.env[spec.imageEnv]!,
		workspace: "/workspace",
		env: {},
		timeoutMs: 120_000,
		features: {},
		...overrides,
	});

	describeProviderContract({
		label: spec.label,
		provider,
		config: () => config(),
		brokenImageConfig: () => config({ image: spec.brokenImage }),
		// Reconciliation is the one primitive every provider must have, so cleanup
		// leans on it rather than on a backend-specific teardown: find the box this
		// attempt produced and stop it. Tolerates a box that never existed.
		cleanup: async (created) => {
			const found = await provider.findByAttemptId(created.attemptId).catch(() => null);
			if (found) await provider.stop(found.externalId).catch(() => {});
		},
	});
}

const REMOTE_CONTRACTS: RemoteContractSpec[] = [
	{
		label: "e2b",
		requiredEnv: ["E2B_API_KEY", "E2B_TEST_TEMPLATE"],
		imageEnv: "E2B_TEST_TEMPLATE",
		brokenImage: "harbor-template-does-not-exist",
		build: () => e2bProvider(),
	},
	{
		label: "daytona",
		requiredEnv: ["DAYTONA_API_KEY", "DAYTONA_TEST_SNAPSHOT"],
		imageEnv: "DAYTONA_TEST_SNAPSHOT",
		brokenImage: "harbor-snapshot-does-not-exist",
		build: () => daytonaProvider(),
	},
	{
		label: "modal",
		requiredEnv: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "MODAL_TEST_IMAGE"],
		imageEnv: "MODAL_TEST_IMAGE",
		brokenImage: "registry.invalid/harbor-does-not-exist:nope",
		build: () => modalProvider(),
	},
	{
		label: "runloop",
		requiredEnv: ["RUNLOOP_API_KEY", "RUNLOOP_TEST_BLUEPRINT"],
		imageEnv: "RUNLOOP_TEST_BLUEPRINT",
		brokenImage: "blueprint-does-not-exist",
		build: () => runloopProvider(),
	},
	{
		label: "morph",
		requiredEnv: ["MORPH_API_KEY", "MORPH_TEST_SNAPSHOT"],
		imageEnv: "MORPH_TEST_SNAPSHOT",
		brokenImage: "snapshot-does-not-exist",
		build: () => morphProvider(),
	},
	{
		label: "blaxel",
		requiredEnv: ["BL_API_KEY", "BL_WORKSPACE", "BLAXEL_TEST_IMAGE"],
		imageEnv: "BLAXEL_TEST_IMAGE",
		brokenImage: "registry.invalid/harbor-does-not-exist:nope",
		build: () => blaxelProvider(),
	},
	{
		label: "codesandbox",
		requiredEnv: ["CSB_API_KEY", "CSB_TEST_TEMPLATE"],
		imageEnv: "CSB_TEST_TEMPLATE",
		brokenImage: "template-does-not-exist",
		build: () => codesandboxProvider(),
	},
	{
		label: "vercel",
		requiredEnv: ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID", "VERCEL_TEST_IMAGE"],
		imageEnv: "VERCEL_TEST_IMAGE",
		brokenImage: "registry.invalid/harbor-does-not-exist:nope",
		build: () => vercelProvider(),
	},
	{
		label: "cloudflare",
		requiredEnv: [
			"CLOUDFLARE_SANDBOX_WORKER_URL",
			"CLOUDFLARE_SANDBOX_WORKER_TOKEN",
			"CLOUDFLARE_TEST_IMAGE",
		],
		imageEnv: "CLOUDFLARE_TEST_IMAGE",
		// The shim fixes the image at deploy time, so `image` is informational and a
		// broken value cannot fail create; this ref only satisfies the config shape.
		brokenImage: "harbor-sandbox:does-not-exist",
		build: () => cloudflareProvider(),
	},
	{
		label: "northflank",
		requiredEnv: ["NORTHFLANK_API_TOKEN", "NORTHFLANK_PROJECT_ID", "NORTHFLANK_TEST_IMAGE"],
		imageEnv: "NORTHFLANK_TEST_IMAGE",
		brokenImage: "registry.invalid/harbor-does-not-exist:nope",
		build: () => northflankProvider(),
	},
];

for (const contract of REMOTE_CONTRACTS) {
	describeRemoteProvider(contract);
}

// ---------------------------------------------------------------------------
// The meta-test: every registered provider must have a contract block
// ---------------------------------------------------------------------------
//
// `src/sandbox/registry.ts` says, in its opening comment, that adding a backend
// is three edits and that the third — running the contract suite against it —
// "is not optional". Nothing enforced that. A provider could be added to
// `SANDBOX_PROVIDER_NAMES`, ship, and be reachable by `HARBOR_SANDBOX_PROVIDER`
// with no contract coverage at all, and the suite would stay green.
//
// This closes it. The list below is the set of labels that have a block in this
// file; if it stops matching the registry, one of the two is wrong and the build
// says which. It costs one line per new provider, which is the point — the cost
// is what makes the omission visible.

describe("contract coverage", () => {
	const covered = new Set<string>([
		// The three with bespoke blocks earlier in this file, each needing local
		// infrastructure rather than a vendor credential.
		"docker",
		"local",
		"fly",
		...REMOTE_CONTRACTS.map((contract) => contract.label),
	]);

	test("every provider in the registry has a contract block here", () => {
		const missing = SANDBOX_PROVIDER_NAMES.filter((name) => !covered.has(name));
		expect(
			missing,
			`These providers are registered but have no contract block: ${missing.join(", ")}. `
				+ "registry.ts promises the contract suite runs against every backend. Add a "
				+ "RemoteContractSpec entry (or a bespoke describe, for a backend that needs "
				+ "local infrastructure rather than a vendor credential).",
		).toEqual([]);
	});

	test("no contract block names a provider the registry does not have", () => {
		const registered = new Set<string>(SANDBOX_PROVIDER_NAMES);
		const orphaned = [...covered].filter((label) => !registered.has(label));
		expect(
			orphaned,
			`These contract blocks name providers that are not in SANDBOX_PROVIDER_NAMES: `
				+ `${orphaned.join(", ")}. Either the provider was removed and its block was `
				+ "left behind, or the label is misspelled — a misspelling means the block is "
				+ "silently testing nothing anybody can select.",
		).toEqual([]);
	});
});
