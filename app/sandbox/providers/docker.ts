// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The default provider, and the strategic centre of the project.
 *
 * Everything Harbor does — spawn admission, fencing, reconciliation, snapshot
 * resume, cost accounting — works on a laptop with this file and nothing else.
 * No vendor account, no API key, no waiting on a sales call to find out whether
 * the product is any good. `docker compose up` and a Postgres is the whole
 * dependency list, which is the difference between a platform a team can evaluate
 * on a Tuesday afternoon and one they have to procure. Remote providers are an
 * upgrade for scale and isolation; they are never a prerequisite, and this file is
 * why that sentence is true rather than aspirational.
 *
 * Shape: one container per session, one named volume per session for the
 * workspace, three labels carrying the correlation ids. The labels are not
 * bookkeeping — `harbor.attempt` is what makes `findByAttemptId` a single
 * `docker ps -a --filter`, and therefore what makes an orphan from a lost
 * response discoverable instead of an invisible container burning CPU until
 * someone notices their fan.
 *
 * Two rules hold everywhere below:
 *
 *  1. **`execFile`, never `exec`, never `shell: true`.** Image names, workspace
 *     paths and environment values reach this file from repository configuration
 *     and from inbound webhooks. As argv elements they cannot be reinterpreted;
 *     through a shell, `image: "x; rm -rf /"` is a shell script we ran as the
 *     user that owns the docker socket, which on most hosts is root-equivalent.
 *  2. **Every value that becomes an argument is validated for a leading dash.**
 *     Removing the shell removes command injection but not *argument* injection:
 *     `docker run … --privileged` is a perfectly good docker invocation, and if
 *     `--privileged` arrived as an "image name" the container it starts owns the
 *     host. The validation is cheap and the failure it prevents is total.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setting } from "@core/kernel/config.js";
import type { ProviderErrorType } from "../../contracts/index.js";
import {
	SandboxProviderError,
	assertFeaturesSupported,
	normalizeProviderState,
} from "../provider.js";
import type {
	BuiltImage,
	CreateSandboxConfig,
	CreatedSandbox,
	ImageBuildConfig,
	ImageBuildingProvider,
	SandboxInspection,
	SandboxOperation,
	SnapshotProvider,
	SnapshotRef,
	StopOptions,
	StopOutcome,
} from "../provider.js";

const execFileAsync = promisify(execFile);

const PROVIDER_NAME = "docker";

/**
 * Labels, and why all three exist.
 *
 * `harbor.attempt` is the idempotency key reconciliation searches on.
 * `harbor.session` is what a human greps for when a session misbehaves, and what
 * the cleanup path uses to find the volume. `harbor.sandbox` ties the container
 * back to the database row, which is the join a post-mortem needs when the row
 * says `failed` and the container says `running`. `harbor.managed` exists so a
 * reaper can tell our containers from the seventeen others on a developer's
 * laptop; without it, "clean up stale sandboxes" is a command nobody dares run.
 */
const LABEL = {
	attempt: "harbor.attempt",
	session: "harbor.session",
	sandbox: "harbor.sandbox",
	managed: "harbor.managed",
	restoredFrom: "harbor.restored_from",
} as const;

/**
 * Optional behaviour this provider actually implements.
 *
 * Anything else in `config.features` is refused by `assertFeaturesSupported`
 * rather than ignored — see the note on `CreateSandboxConfig.features`.
 */
const SUPPORTED_FEATURES = [
	/** `--network none`. The agent can edit code but cannot reach anything. */
	"network_disabled",
	/** `--read-only` root filesystem; the workspace volume stays writable. */
	"readonly_rootfs",
	/**
	 * Mount the host docker socket. Documented, refusable, and never on by default:
	 * a container with the socket can start a privileged sibling, so this is host
	 * root with extra steps. It exists because some repositories genuinely test
	 * against containers and the alternative is that they cannot use Harbor at all.
	 */
	"docker_socket",
] as const;

// ---------------------------------------------------------------------------
// Argument hygiene
// ---------------------------------------------------------------------------

/**
 * Ids, image references and paths that are about to become argv elements.
 *
 * The leading character must be alphanumeric or `/`, which is the whole point:
 * it is what makes `--privileged` an error instead of a flag. The rest of the
 * character class is the union of what docker accepts for image references,
 * container names and label values — deliberately narrow, because a value that
 * needs a character outside it is a value that got here from somewhere it
 * should not have.
 */
const ARG_SAFE = /^[A-Za-z0-9/][A-Za-z0-9._:@/+-]*$/;
const ENV_KEY_SAFE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertArgSafe(
	value: string,
	what: string,
	operation: SandboxOperation,
): void {
	if (ARG_SAFE.test(value)) return;
	throw new SandboxProviderError({
		message:
			`Refusing to pass ${what} ${JSON.stringify(value)} to docker. A value starting with `
			+ "'-' would be read as a flag — argument injection survives the removal of the "
			+ "shell, and `--privileged` arriving as an image name is a container that owns "
			+ "the host.",
		errorType: "invalid_config",
		provider: PROVIDER_NAME,
		operation,
	});
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/**
 * docker's stderr → a `ProviderErrorType` the circuit breaker can act on.
 *
 * The ordering is load-bearing. A missing image on Docker Hub reports
 * "pull access denied for x, repository does not exist or may require 'docker
 * login': denied", which matches both a not-found pattern and an unauthorized
 * one. Classifying it as `unauthorized` would be defensible and wrong in
 * consequence: the common cause is a typo in `HARBOR_SANDBOX_IMAGE`, every
 * session in the deployment hits it, and `unauthorized` is not in
 * `CIRCUIT_TRIPPING_ERROR_TYPES` either — but `not_found` is the classification
 * that makes the operator's error message name the image instead of their
 * credentials. Repository-existence patterns are therefore checked first.
 *
 * The categories that matter most are the ones that must NOT trip the breaker:
 * a bad image name is a configuration error, and counting a hundred sessions
 * hitting the same typo as a hundred provider failures opens the circuit and
 * hides whatever real outage happens next behind it.
 */
export function classifyDockerFailure(stderr: string, code: unknown): ProviderErrorType {
	const text = stderr.toLowerCase();

	// Spawn-level failures: the CLI itself is missing or the process was killed.
	if (code === "ENOENT") return "invalid_config";
	if (code === "ETIMEDOUT" || code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "transient";

	if (/no such (container|object|image|volume)/.test(text)) return "not_found";
	if (/repository does not exist|manifest unknown|manifest for .* not found/.test(text)) {
		return "not_found";
	}
	if (/pull access denied|not found: manifest unknown/.test(text)) return "not_found";
	if (/invalid reference format|unknown (flag|shorthand)|invalid argument|conflict/.test(text)) {
		return "invalid_config";
	}
	if (/permission denied while trying to connect|got permission denied/.test(text)) {
		return "unauthorized";
	}
	if (/unauthorized|authentication required|login required/.test(text)) return "unauthorized";
	if (/no space left on device|insufficient|quota/.test(text)) return "quota_exceeded";
	if (/too many requests|toomanyrequests|rate limit/.test(text)) return "rate_limited";
	if (
		/cannot connect to the docker daemon|is the docker daemon running|connection refused|i\/o timeout|tls handshake|eof|temporary failure in name resolution/
			.test(text)
	) {
		return "transient";
	}
	return "unknown";
}

interface DockerFailure {
	stdout: string;
	stderr: string;
	code: unknown;
}

function isDockerFailure(error: unknown): error is DockerFailure & Error {
	return error instanceof Error && "stderr" in error;
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

export class DockerSandboxProvider implements SnapshotProvider, ImageBuildingProvider {
	readonly name = PROVIDER_NAME;
	/**
	 * Present and `true` so `isImageBuildingProvider` narrows to this. Docker builds
	 * images; `local` does not implement `ImageBuildingProvider` at all, so calling
	 * `buildImage` on it is a compile error rather than a runtime refusal.
	 */
	readonly buildsImages = true as const;
	/**
	 * `snapshot`, even though docker can also do persistent pause/resume.
	 *
	 * `docker start` on a stopped container genuinely restores the same box, so
	 * modelling this as a `PersistentProvider` would compile. It is the wrong
	 * promise to make. That container exists on exactly one docker host, and the
	 * ways a self-hoster loses it are ordinary rather than exotic: `docker compose
	 * down -v`, a laptop reboot with a pruned daemon, moving the control plane to a
	 * second machine. When it is gone, a persistent resume has nothing to fall back
	 * to and the session is dead. A committed image can be pushed to a registry,
	 * survives the container, and degrades to a fresh boot from a base image if it
	 * has been pruned. The capability we advertise has to be the one we can keep.
	 */
	readonly kind = "snapshot" as const;
	readonly supportedFeatures = SUPPORTED_FEATURES;
	readonly capabilities = {
		// Docker will not stop an idle container for us; the inactivity sweep in the
		// control plane does it. Saying otherwise here means nobody reaps anything.
		supportsSandboxTimeout: false,
		supportsSnapshots: true,
		supportsRestore: true,
		supportsPersistentResume: false,
		supportsExplicitStop: true,
		// Publishing a port binds it on the host, which is a laptop, not a public URL.
		supportsTunnels: false,
	};

	/**
	 * The docker CLI path. Injectable so a deployment using `podman` (argv
	 * compatible for everything this file does) or a wrapper script does not have
	 * to fork the provider.
	 */
	constructor(private readonly bin: string = process.env.HARBOR_DOCKER_BIN || "docker") {}

	// -- plumbing -----------------------------------------------------------

	private async run(
		args: string[],
		operation: SandboxOperation,
		timeoutMs: number,
	): Promise<{ stdout: string; stderr: string }> {
		try {
			// `shell: false` is the default for execFile and is restated because this
			// is the single line the whole file's safety argument rests on.
			return await execFileAsync(this.bin, args, { timeout: timeoutMs, shell: false });
		} catch (error) {
			const failure = isDockerFailure(error) ? error : null;
			const stderr = failure?.stderr?.toString() ?? (error as Error)?.message ?? "";
			const code = failure?.code ?? (error as NodeJS.ErrnoException)?.code;
			throw new SandboxProviderError({
				message: `docker ${args[0] ?? ""} failed: ${firstLine(stderr) || String(error)}`,
				errorType: classifyDockerFailure(stderr, code),
				provider: PROVIDER_NAME,
				operation,
				// Truncated: stderr from a failed pull can be kilobytes of progress bars,
				// and this string ends up in an event payload the timeline has to carry.
				detail: stderr.slice(0, setting("maxEventPayloadChars")),
				cause: error,
			});
		}
	}

	/**
	 * The ceiling on a probe (`inspect`, `ps`), one heartbeat interval.
	 *
	 * Derived rather than chosen: a probe that has not answered within the time it
	 * takes a healthy box to say it is alive is not going to inform a decision that
	 * is still current — the sweep that asked will run again on the next tick, and
	 * a caller blocked on a wedged daemon is a caller not reaping the other ninety
	 * boxes. Not a module constant, so a deployment on a slow socket can raise it
	 * with `HARBOR_SANDBOX_HEARTBEAT_INTERVAL_MS` without editing code.
	 */
	private probeTimeoutMs(): number {
		return setting("sandboxHeartbeatIntervalMs");
	}

	// -- lifecycle ----------------------------------------------------------

	async create(config: CreateSandboxConfig): Promise<CreatedSandbox> {
		return this.runContainer(config, "create", null);
	}

	private async runContainer(
		config: CreateSandboxConfig,
		operation: SandboxOperation,
		restoredFrom: SnapshotRef | null,
	): Promise<CreatedSandbox> {
		assertFeaturesSupported(this, config, operation);

		assertArgSafe(config.image, "image", operation);
		assertArgSafe(config.workspace, "workspace path", operation);
		assertArgSafe(config.sessionId, "session id", operation);
		assertArgSafe(config.sandboxId, "sandbox id", operation);
		assertArgSafe(config.attemptId, "attempt id", operation);

		const args = [
			"run",
			"--detach",
			// The container name is a second, independent guard against the duplicate
			// this whole subsystem exists to prevent: a retry that reaches docker with
			// the same sandbox id is refused by the daemon with a name conflict rather
			// than quietly starting a second box. Reconciliation by attempt id is the
			// primary mechanism; this is what catches the case where reconciliation
			// itself raced.
			"--name",
			`harbor-${config.sandboxId}`,
			// PID 1 is a reaper. Without it the agent's abandoned child processes
			// accumulate as zombies inside a long-lived box, and a `docker stop` has
			// nothing to forward SIGTERM to, so every shutdown waits out the full grace
			// period and then kills.
			"--init",
			"--label",
			`${LABEL.managed}=1`,
			"--label",
			`${LABEL.session}=${config.sessionId}`,
			"--label",
			`${LABEL.sandbox}=${config.sandboxId}`,
			"--label",
			`${LABEL.attempt}=${config.attemptId}`,
			"--volume",
			`${volumeName(config.sessionId)}:${config.workspace}`,
			"--workdir",
			config.workspace,
		];

		if (restoredFrom) {
			assertArgSafe(restoredFrom.handle, "snapshot handle", operation);
			args.push("--label", `${LABEL.restoredFrom}=${restoredFrom.handle}`);
		}

		// Deliberately no `--restart` policy. A container that resurrects itself
		// after the control plane concluded it was dead is a second agent on the same
		// branch with a stale fencing token, and the first symptom is a force-push
		// nobody asked for. Restarting a box is a decision the lifecycle manager
		// makes with a lease in hand, not one the docker daemon makes on its own.

		for (const [key, value] of Object.entries(config.env)) {
			if (!ENV_KEY_SAFE.test(key)) {
				throw new SandboxProviderError({
					message:
						`Environment variable name ${JSON.stringify(key)} is not a valid identifier. `
						+ "A name containing '=' would silently set a different variable than the "
						+ "caller intended, which for a credential means the agent runs without it "
						+ "and the error surfaces three layers away as an auth failure.",
					errorType: "invalid_config",
					provider: PROVIDER_NAME,
					operation,
				});
			}
			if (value.includes("\0")) {
				throw new SandboxProviderError({
					message: `Environment value for ${key} contains a NUL byte and cannot be passed as argv.`,
					errorType: "invalid_config",
					provider: PROVIDER_NAME,
					operation,
				});
			}
			// One argv element, so the value is never re-parsed. Values may contain
			// spaces, quotes and newlines; none of that matters without a shell.
			args.push("--env", `${key}=${value}`);
		}

		if (config.features.network_disabled === true) args.push("--network", "none");
		if (config.features.readonly_rootfs === true) args.push("--read-only");
		if (config.features.docker_socket === true) {
			args.push("--volume", "/var/run/docker.sock:/var/run/docker.sock");
		}

		args.push(config.image);
		if (config.command) {
			for (const element of config.command) {
				if (element.includes("\0")) {
					throw new SandboxProviderError({
						message: "A command element contains a NUL byte and cannot be passed as argv.",
						errorType: "invalid_config",
						provider: PROVIDER_NAME,
						operation,
					});
				}
				// Not `assertArgSafe`: everything after the image is the container's own
				// argv and docker does not interpret it, so a leading dash here is the
				// caller's business. The image name above is the last position where a
				// dash could become a docker flag.
				args.push(element);
			}
		}

		const { stdout } = await this.run(args, operation, config.timeoutMs);
		const externalId = lastLine(stdout);
		if (!externalId) {
			throw new SandboxProviderError({
				message:
					"docker run reported success but printed no container id. The box may exist; "
					+ "reconcile by attempt id before creating another.",
				errorType: "unknown",
				provider: PROVIDER_NAME,
				operation,
			});
		}

		return {
			externalId,
			provider: PROVIDER_NAME,
			attemptId: config.attemptId,
			state: "starting",
			createdAt: new Date().toISOString(),
		};
	}

	async inspect(externalId: string): Promise<SandboxInspection | null> {
		assertArgSafe(externalId, "container id", "inspect");
		let stdout: string;
		try {
			({ stdout } = await this.run(
				["inspect", "--type", "container", "--format", "{{json .}}", externalId],
				"inspect",
				this.probeTimeoutMs(),
			));
		} catch (error) {
			// `not_found` is the one failure that is an answer rather than an error:
			// the daemon replied and told us there is no such container. Everything
			// else — daemon unreachable, timeout, permission — is rethrown, because a
			// caller that reads `null` will conclude the box is gone.
			if (error instanceof SandboxProviderError && error.errorType === "not_found") return null;
			throw error;
		}
		return this.parseInspection(stdout, "inspect");
	}

	/**
	 * Reconciliation. See the authority note on the base interface: `null` here
	 * means the daemon answered and has no container carrying this label. Anything
	 * that stops us from getting that answer throws, because the caller's response
	 * to `null` is to start a second box.
	 */
	async findByAttemptId(attemptId: string): Promise<SandboxInspection | null> {
		assertArgSafe(attemptId, "attempt id", "find_by_attempt");
		const { stdout } = await this.run(
			[
				"ps",
				"--all",
				"--no-trunc",
				"--filter",
				`label=${LABEL.attempt}=${attemptId}`,
				"--format",
				"{{.ID}}",
			],
			"find_by_attempt",
			this.probeTimeoutMs(),
		);

		const ids = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
		if (ids.length === 0) return null;

		const found: SandboxInspection[] = [];
		for (const id of ids) {
			const inspection = await this.inspect(id);
			// A container that vanished between the `ps` and the `inspect` is a real
			// race with a concurrent reaper, and it is the one case where skipping is
			// correct: it is definitively gone.
			if (inspection) found.push(inspection);
		}
		if (found.length === 0) return null;

		if (found.length > 1) {
			// Two containers with one attempt id means the duplicate this subsystem
			// exists to prevent already happened — most likely a create that was
			// retried outside the saga. Adopting one silently would leave the other
			// running and invisible, so both ids are named loudly and the live one is
			// returned, because that is the one still doing damage and therefore the
			// one the caller must take control of.
			console.warn(
				`[docker] ${found.length} containers share attempt ${attemptId}: `
					+ `${found.map((f) => f.externalId).join(", ")}. Adopting the live one; the rest are `
					+ "orphans and must be reaped.",
			);
		}
		return found.find((f) => f.state === "running" || f.state === "starting") ?? found[0]!;
	}

	/**
	 * Every live container carrying `harbor.managed=1`.
	 *
	 * No `--all`, deliberately: stopped containers are kept for post-mortems and
	 * must never become stop candidates. A daemon that cannot answer throws
	 * (`this.run` already does), never returns `[]` — see the authority note on
	 * the base interface.
	 */
	async listManaged(): Promise<SandboxInspection[]> {
		const { stdout } = await this.run(
			[
				"ps",
				"--no-trunc",
				"--filter",
				`label=${LABEL.managed}=1`,
				"--format",
				"{{.ID}}",
			],
			"list_managed",
			this.probeTimeoutMs(),
		);

		const ids = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
		const found: SandboxInspection[] = [];
		for (const id of ids) {
			const inspection = await this.inspect(id);
			// Vanished between the `ps` and the `inspect`: a real race with a
			// concurrent stop, and definitively gone — the one case skipping is right.
			if (inspection) found.push(inspection);
		}
		return found;
	}

	async stop(externalId: string, options?: StopOptions): Promise<StopOutcome> {
		assertArgSafe(externalId, "container id", "stop");

		// Read before writing so the outcome can be typed. `docker stop` exits 0 for
		// a container that was already stopped, so without this probe every caller
		// would be told "stopped" and the timeline would grow a second
		// `sandbox_stopped` event on every retry of the stop path.
		const before = await this.inspect(externalId);
		if (!before) return "absent";
		if (before.state === "exited" || before.state === "gone") return "already_stopped";

		/**
		 * How long the box gets to flush and exit before SIGKILL.
		 *
		 * Falls back to one heartbeat interval: the in-box bridge buffers events
		 * between POSTs, and a grace shorter than the interval it buffers over means
		 * the last thing the agent did is never recorded — the session's timeline
		 * ends mid-sentence and looks like a crash. Callers with a lease deadline
		 * pass their own.
		 */
		const graceMs = options?.graceMs ?? setting("sandboxHeartbeatIntervalMs");
		const graceSeconds = Math.max(1, Math.ceil(graceMs / 1000));

		try {
			await this.run(
				["stop", "--timeout", String(graceSeconds), externalId],
				"stop",
				// The daemon needs time to answer *after* the grace elapses and the kill
				// lands; a CLI timeout equal to the grace would abort exactly as the
				// container was dying and report a failure for a stop that worked.
				graceMs + this.probeTimeoutMs(),
			);
		} catch (error) {
			if (error instanceof SandboxProviderError && error.errorType === "not_found") return "absent";
			throw error;
		}

		// The container is deliberately NOT removed. Its exit code and its logs are
		// the only post-mortem available when a boot fails, and `findByAttemptId`
		// must keep answering "yes, that attempt produced a box" after the box has
		// stopped — otherwise a reconciler concludes the attempt never happened and
		// starts another one. Reaping stopped containers and their volumes is a
		// separate, deliberate sweep against the `harbor.managed` label.
		return "stopped";
	}

	// -- snapshots ----------------------------------------------------------

	/**
	 * `docker commit`, and the sharp edge it comes with.
	 *
	 * Commit pauses the container while it writes the layer. For a large workspace
	 * that is seconds during which the agent is frozen — which is fine for the
	 * inactivity path that snapshots a box nobody is using, and is why the
	 * lifecycle manager must not snapshot mid-turn. This is the concrete instance
	 * of the general warning on `HARBOR_ENABLE_SNAPSHOTS`: restore is a latency
	 * optimisation with real edges, which is why it is off by default.
	 */
	async snapshot(externalId: string): Promise<SnapshotRef> {
		assertArgSafe(externalId, "container id", "snapshot");
		const before = await this.inspect(externalId);
		if (!before) {
			throw new SandboxProviderError({
				message: `Cannot snapshot ${externalId}: no such container.`,
				errorType: "not_found",
				provider: PROVIDER_NAME,
				operation: "snapshot",
			});
		}

		const takenAt = new Date();
		const handle = snapshotTag(before.sandboxId ?? before.externalId, takenAt);
		await this.run(
			["commit", externalId, handle],
			"snapshot",
			// Committing a workspace is filesystem work of the same order as building
			// the image was, so it borrows the boot budget rather than a probe budget:
			// a five-second ceiling here would fail every snapshot on a monorepo and
			// present as "snapshots do not work on this deployment".
			setting("sandboxBootTimeoutMs"),
		);

		return {
			provider: PROVIDER_NAME,
			handle,
			sourceExternalId: externalId,
			takenAt: takenAt.toISOString(),
		};
	}

	/**
	 * Boot a NEW container from a committed image.
	 *
	 * The returned box has a different external id than the one snapshotted, which
	 * is the defining property of the `snapshot` kind — see `ResumeStrategy`. The
	 * caller registers a new sandbox row; it does not update the old one.
	 */
	async restoreFromSnapshot(
		ref: SnapshotRef,
		config: CreateSandboxConfig,
	): Promise<CreatedSandbox> {
		if (ref.provider !== PROVIDER_NAME) {
			throw new SandboxProviderError({
				message:
					`Snapshot handle came from provider ${JSON.stringify(ref.provider)}, not docker. `
					+ "Handles are opaque and provider-specific; restoring one on the wrong backend "
					+ "would boot whatever local image happens to share that name.",
				errorType: "invalid_config",
				provider: PROVIDER_NAME,
				operation: "restore",
			});
		}
		return this.runContainer({ ...config, image: ref.handle }, "restore", ref);
	}

	// -- image building -----------------------------------------------------

	/**
	 * Build a per-repo image: boot the base in `build` mode so the in-box supervisor
	 * clones and runs `setup.sh`, wait for it, and `docker commit` the result.
	 *
	 * Deliberately NOT `runContainer`. Two differences are load-bearing:
	 *
	 *  - **No volume mount.** `create()` mounts a per-session volume at the workspace,
	 *    which puts the clone and setup output *outside* the image — a `docker commit`
	 *    would then bake an empty tree. The build writes into the container's own
	 *    writable layer so the commit captures it.
	 *  - **No `--network none` / `--read-only`.** A build clones a repo and installs a
	 *    dependency tree; both need the network and a writable root. This is an
	 *    internal operation over the operator's own repository, running the same
	 *    `setup.sh` a fresh boot runs unrestricted.
	 *
	 * The container is run detached and awaited with `docker wait` rather than a
	 * foreground `docker run`, so a non-zero `setup.sh` is read as an exit code to act
	 * on rather than thrown as a CLI error and misclassified.
	 */
	async buildImage(config: ImageBuildConfig): Promise<BuiltImage> {
		const operation: SandboxOperation = "build_image";
		assertArgSafe(config.base, "base image", operation);
		assertArgSafe(config.targetTag, "target image tag", operation);
		assertArgSafe(config.workspace, "workspace path", operation);

		const container = buildContainerName(config.targetTag);
		// Clear a container left by a crashed prior build with the same name; without
		// this the `--name` below conflicts and every build after a crash fails.
		await this.rmForce(container);

		const args = [
			"run",
			"--detach",
			"--name",
			container,
			"--init",
			"--label",
			`${LABEL.managed}=1`,
			"--workdir",
			config.workspace,
		];
		for (const [key, value] of Object.entries(config.env)) {
			if (!ENV_KEY_SAFE.test(key)) {
				throw new SandboxProviderError({
					message: `Environment variable name ${JSON.stringify(key)} is not a valid identifier.`,
					errorType: "invalid_config",
					provider: PROVIDER_NAME,
					operation,
				});
			}
			if (value.includes("\0")) {
				throw new SandboxProviderError({
					message: `Environment value for ${key} contains a NUL byte and cannot be passed as argv.`,
					errorType: "invalid_config",
					provider: PROVIDER_NAME,
					operation,
				});
			}
			args.push("--env", `${key}=${value}`);
		}
		args.push(config.base, ...BUILD_COMMAND);

		const { stdout } = await this.run(args, operation, config.timeoutMs);
		const cid = lastLine(stdout);
		if (!cid) {
			await this.rmForce(container);
			throw new SandboxProviderError({
				message: "docker run for the build reported success but printed no container id.",
				errorType: "unknown",
				provider: PROVIDER_NAME,
				operation,
			});
		}

		try {
			const exit = await this.waitForBuildExit(container, config.timeoutMs, operation);
			const log = await this.buildLog(container);
			if (exit !== 0) {
				throw new SandboxProviderError({
					message:
						`Image build failed: the boot (setup.sh) exited ${exit}. A non-zero setup at build `
						+ "time fails the build and publishes nothing — baking a broken image is permanent, "
						+ "inherited by every box started from it with no warning anywhere.",
					// The repository's setup is the repository's problem: a config error, not
					// `transient`, so one repo's broken setup never opens the provider's circuit
					// against every other repo building on the same schedule.
					errorType: "invalid_config",
					provider: PROVIDER_NAME,
					operation,
					detail: log.slice(-setting("maxEventPayloadChars")),
				});
			}
			await this.run(
				["commit", container, config.targetTag],
				operation,
				setting("sandboxBootTimeoutMs"),
			);
			return { imageRef: config.targetTag, provider: PROVIDER_NAME, log };
		} finally {
			await this.rmForce(container);
		}
	}

	/**
	 * Remove images under `tagPrefix` not in `keep`. Best-effort: an image still
	 * backing a running container refuses removal, which is the safe direction — a
	 * spawn mid-flight against the predecessor keeps its image — so a refusal is
	 * skipped rather than fatal.
	 */
	async pruneImages(tagPrefix: string, keep: readonly string[]): Promise<string[]> {
		const operation: SandboxOperation = "prune_images";
		assertArgSafe(tagPrefix, "image tag prefix", operation);
		const { stdout } = await this.run(
			["images", "--format", "{{.Repository}}:{{.Tag}}", "--filter", `reference=${tagPrefix}*`],
			operation,
			this.probeTimeoutMs(),
		);
		const keepSet = new Set(keep);
		const removed: string[] = [];
		for (const ref of stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
			if (keepSet.has(ref)) continue;
			try {
				await this.run(["rmi", ref], operation, this.probeTimeoutMs());
				removed.push(ref);
			} catch (error) {
				// In-use or already gone: skip. A daemon-down error would surface on the
				// listing call above, not here, so anything at this point is safe to ignore.
				if (error instanceof SandboxProviderError) continue;
				throw error;
			}
		}
		return removed;
	}

	/**
	 * Await the build container's exit code via `docker wait`, bounded.
	 *
	 * `docker wait` prints the container's exit code and itself exits zero, so a
	 * failed `setup.sh` comes back as a number rather than a thrown CLI error. Our own
	 * timeout killing `docker wait` means the build overran; the caller's `finally`
	 * removes the still-running container.
	 */
	private async waitForBuildExit(
		container: string,
		timeoutMs: number,
		operation: SandboxOperation,
	): Promise<number> {
		try {
			const { stdout } = await this.run(["wait", container], operation, timeoutMs);
			const code = Number.parseInt(lastLine(stdout), 10);
			return Number.isFinite(code) ? code : 1;
		} catch (error) {
			throw new SandboxProviderError({
				message: `Image build exceeded its ${timeoutMs}ms budget and was aborted.`,
				errorType: "transient",
				provider: PROVIDER_NAME,
				operation,
				cause: error,
			});
		}
	}

	private async buildLog(container: string): Promise<string> {
		try {
			const { stdout, stderr } = await this.run(
				["logs", "--tail", "200", container],
				"build_image",
				this.probeTimeoutMs(),
			);
			return `${stdout}\n${stderr}`.slice(-setting("maxRunOutputChars"));
		} catch {
			return "";
		}
	}

	private async rmForce(container: string): Promise<void> {
		try {
			await this.run(["rm", "--force", container], "build_image", this.probeTimeoutMs());
		} catch {
			// Best effort: the container may already be gone, which is the goal.
		}
	}

	// -- parsing ------------------------------------------------------------

	private parseInspection(stdout: string, operation: SandboxOperation): SandboxInspection {
		let raw: unknown;
		try {
			raw = JSON.parse(stdout);
		} catch (error) {
			throw new SandboxProviderError({
				message: "docker inspect returned output that is not JSON.",
				errorType: "unknown",
				provider: PROVIDER_NAME,
				operation,
				detail: stdout.slice(0, setting("maxEventPayloadChars")),
				cause: error,
			});
		}

		const container = raw as {
			Id?: string;
			State?: { Status?: string; StartedAt?: string; ExitCode?: number };
			Config?: { Labels?: Record<string, string> };
		};
		const labels = container.Config?.Labels ?? {};
		const rawState = container.State?.Status ?? "";

		return {
			externalId: container.Id ?? "",
			provider: PROVIDER_NAME,
			// Docker's vocabulary is known, but it is still normalised through the
			// shared deny-list rather than switched on here: a state docker adds in a
			// future release lands on `unknown`, which reads as live, and a live-but-
			// unrecognised box is the recoverable direction to be wrong in.
			state: normalizeProviderState(rawState),
			rawState,
			attemptId: labels[LABEL.attempt] ?? null,
			sessionId: labels[LABEL.session] ?? null,
			sandboxId: labels[LABEL.sandbox] ?? null,
			startedAt: container.State?.StartedAt ?? null,
			exitCode: typeof container.State?.ExitCode === "number" ? container.State.ExitCode : null,
		};
	}
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/**
 * One named volume per session, not per container.
 *
 * The workspace has to outlive any individual box — a container that OOMs mid-turn
 * takes an hour of the agent's uncommitted work with it otherwise, and "your
 * changes are gone because the process died" is the failure people never forgive.
 * Keyed on the session because that is the unit a human thinks in and the unit the
 * cleanup sweep can reason about.
 */
export function volumeName(sessionId: string): string {
	return `harbor-ws-${sessionId}`;
}

/** Lowercase repository, timestamped tag — docker rejects anything else. */
function snapshotTag(sandboxId: string, at: Date): string {
	const stamp = at.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
	return `harbor-snapshot:${sandboxId.toLowerCase()}-${stamp}`;
}

/**
 * The container command that runs a build.
 *
 * The build entrypoint runs `boot()` in `build` mode against a no-op bridge — it
 * clones, runs `setup.sh` fatally, and exits — with no control-plane connection and
 * no agent. Not a tunable; the emitted path is fixed by the Dockerfile's layout.
 */
const BUILD_COMMAND = ["node", "/opt/harbor/runtime/build-entry.js"] as const;

/**
 * A docker container name derived from the target image tag.
 *
 * Container names allow a narrower character set than image references — no `:` or
 * `/` — so the tag is sanitised to a name that is stable per repo. Stable rather than
 * random so a crashed build's leftover container is found and removed by the next
 * build of the same repo instead of accumulating.
 */
function buildContainerName(targetTag: string): string {
	return `harbor-build-${targetTag.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-")}`;
}

function firstLine(text: string): string {
	return text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

function lastLine(text: string): string {
	const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
	return lines[lines.length - 1] ?? "";
}

/** The one instance. Stateless, so sharing it costs nothing and avoids churn. */
export function dockerProvider(): SnapshotProvider {
	return new DockerSandboxProvider();
}
