// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Modal — isolated container sandboxes reached over Modal's own gRPC SDK.
 *
 * Unlike `fly.ts` and `e2b.ts` there is no REST control plane to `fetch`: Modal
 * ships a first-party client (`modal` on npm, gRPC underneath) and everything —
 * create, inspect, list, terminate — goes through it. So the injected transport
 * here is not a `fetch` but the `ModalClient` itself, and error classification
 * keys off Modal's *typed* SDK errors (`NotFoundError`, `InvalidError`, …) rather
 * than HTTP status codes, because gRPC never gives us a 404 to read.
 *
 * Isolation: a Modal Sandbox is a real, gVisor-isolated container in Modal's
 * cloud — strong isolation, unlike the `local` provider's bare host processes.
 * It runs the registry image Harbor hands it and calls the control plane back
 * over HTTP, exactly as the docker/Fly/E2B boxes do; Harbor never touches
 * Modal's exec or filesystem data plane.
 *
 * `kind: "ephemeral"`. Modal can snapshot a sandbox's filesystem
 * (`sandbox.snapshotFilesystem()`), which would make it a `snapshot` provider,
 * but per `docs/provider-checklist.md` we advertise the weaker capability we can
 * honour on a bad day: create-and-terminate always works, and a restore path is
 * only promoted once it is proven against the contract suite.
 *
 * Two disciplines carried from the REST templates, for the same reasons:
 *   1. **The attempt id is a searchable tag**, stamped at create. Reconciliation
 *      lists on it (`client.sandboxes.list({ tags })`) to turn a box from a lost
 *      create response into a discoverable one rather than an orphan burning money.
 *   2. **`findByAttemptId` / `listManaged` fail CLOSED.** A list call that cannot
 *      reach Modal throws (`transient`) rather than returning `null` / `[]`,
 *      because a caller reading empty starts a second box on the same branch.
 */

import type { ModalClient } from "modal";
import type { ProviderErrorType, SandboxCapabilities } from "../../contracts/index.js";
import {
	SandboxProviderError,
	assertFeaturesSupported,
	normalizeProviderState,
} from "../provider.js";
import type {
	CreateSandboxConfig,
	CreatedSandbox,
	EphemeralProvider,
	ProviderSandboxState,
	SandboxInspection,
	SandboxOperation,
	StopOptions,
	StopOutcome,
} from "../provider.js";

const PROVIDER_NAME = "modal";

/**
 * Tag keys, mirroring the docker labels / Fly metadata / E2B metadata one-for-one.
 * `harbor_attempt` is the idempotency key reconciliation lists on; the rest are
 * what a human greps and what a post-mortem joins on. Modal tags are plain
 * `Record<string, string>` filterable via `client.sandboxes.list({ tags })`.
 */
const TAG = {
	attempt: "harbor_attempt",
	session: "harbor_session",
	sandbox: "harbor_sandbox",
	managed: "harbor_managed",
} as const;

export interface ModalProviderOptions {
	/** Injected for tests; a real one is built from the token pair otherwise. */
	client?: ModalClient;
	/** Defaults to `MODAL_TOKEN_ID`. */
	tokenId?: string;
	/** Defaults to `MODAL_TOKEN_SECRET`. */
	tokenSecret?: string;
	/** The Modal App the sandboxes live under. Defaults to `MODAL_APP_NAME` ?? "harbor". */
	appName?: string;
	/**
	 * The sandbox's own maximum lifetime, in milliseconds, that Modal enforces as a
	 * backstop. Modal defaults this to five minutes, far too short for an agent
	 * turn, so Harbor raises it; Harbor drives its own inactivity sweep, so this is
	 * only a ceiling that reclaims a box Harbor lost track of entirely. Read inline
	 * (not a module constant) from `MODAL_SANDBOX_TIMEOUT_MS` so a self-hoster can
	 * change it without forking. Distinct from `config.timeoutMs`, which is the
	 * caller's *boot* ceiling for the create RPC.
	 */
	timeoutMs?: number;
}

/** Modal's states → Harbor's six. `poll()` gives us only running/exited; both are
 * already in the deny-list, so we defer to the shared normaliser. */
function modalState(raw: string): ProviderSandboxState {
	return normalizeProviderState(raw);
}

/**
 * The Modal SDK, loaded on first use rather than at import.
 *
 * `modal` pulls in `nice-grpc`, `@grpc/grpc-js` and `protobufjs`, all three of
 * which resolve modules by computed expression. A static import here reaches the
 * Next.js server bundle — `registry.ts` imports every provider eagerly so that a
 * missing case is a compile error — and webpack cannot follow a computed require,
 * so the build either warns or emits something that throws at runtime. Deferring
 * the import means a self-hoster on the `docker` default never loads a gRPC stack
 * they are not using, and the bundler never sees it at all.
 *
 * `import type` above is erased, so the type-level use of `ModalClient` is free.
 */
let modalSdk: typeof import("modal") | undefined;

async function loadModalSdk(): Promise<typeof import("modal")> {
	modalSdk ??= await import("modal");
	return modalSdk;
}

/**
 * `err instanceof <the SDK's class>`, safe before the SDK has loaded.
 *
 * Every call site sits downstream of `client()`, which loads the SDK first, so in
 * practice the module is always present by the time anything is classified. The
 * `undefined` branch is not dead code though: it keeps classification a total
 * function, and a `false` here simply falls through to the message sniff below —
 * a slightly less precise answer, never a crash while handling someone else's error.
 */
function isModalError(err: unknown, name: keyof typeof import("modal")): boolean {
	const ctor = modalSdk?.[name];
	return typeof ctor === "function" && err instanceof (ctor as new (...args: never[]) => Error);
}

/**
 * Modal SDK error → the circuit breaker's vocabulary. The gRPC transport has no
 * HTTP status, so this is an `instanceof` ladder over Modal's exported error
 * classes plus a message sniff for the auth/connection cases the SDK folds into a
 * generic error.
 *
 * The default is `unknown`, NOT `transient`: a bad image reference or malformed
 * request must not trip the breaker across the whole deployment and hide the next
 * real outage behind a config typo.
 */
function classifyModalError(err: unknown): ProviderErrorType {
	if (isModalError(err, "NotFoundError")) return "not_found";
	if (isModalError(err, "InvalidError")) return "invalid_config";
	// A retryable internal error, or the client being torn down under us: both are
	// "try again", which is exactly what `transient` means to the breaker.
	if (isModalError(err, "InternalFailure")) return "transient";
	if (isModalError(err, "ClientClosedError")) return "transient";

	const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
	// gRPC UNAUTHENTICATED / PERMISSION_DENIED surface as a plain error with these
	// words; a bad or missing token pair lands here rather than as a typed class.
	if (/unauthenticat|unauthoriz|permission denied|forbidden|invalid token|token id|token secret/.test(message)) {
		return "unauthorized";
	}
	// gRPC UNAVAILABLE / DEADLINE_EXCEEDED and raw socket failures — Modal
	// unreachable. Treated as `transient` so the breaker counts a genuine outage.
	if (/unavailable|deadline exceeded|econnrefused|etimedout|socket hang up|network|connection|timeout/.test(message)) {
		return "transient";
	}
	return "unknown";
}

export class ModalSandboxProvider implements EphemeralProvider {
	readonly name = PROVIDER_NAME;
	readonly kind = "ephemeral" as const;
	readonly capabilities: SandboxCapabilities = {
		// Modal enforces its own lifetime timeout, but Harbor drives the inactivity
		// sweep so behaviour matches every other provider; two systems each believing
		// the other reaps the box is how a live agent gets killed mid-turn.
		supportsSandboxTimeout: false,
		// Filesystem snapshot exists on the SDK; not wired, so not advertised — see header.
		supportsSnapshots: false,
		supportsRestore: false,
		supportsPersistentResume: false,
		supportsExplicitStop: true,
		supportsTunnels: false,
	};
	readonly supportedFeatures: readonly string[] = [];

	private readonly options: ModalProviderOptions;
	private cachedClient?: ModalClient;

	constructor(options: ModalProviderOptions = {}) {
		this.options = options;
	}

	/**
	 * The Modal client, resolved lazily per-op. A missing token pair is
	 * `invalid_config` and throws with an actionable message — NEVER a `transient`
	 * error, which would open the circuit on a deployment that simply forgot to set
	 * its credentials.
	 *
	 * The SDK is loaded even when a client is injected, which looks redundant and is
	 * not: `classifyModalError` and the `NotFoundError` checks in `inspect` and
	 * `stop` need the SDK's error *classes*, and a test that injects a fake client
	 * still throws real `NotFoundError`s at us. Loading here — the one call every
	 * operation makes first — is what keeps those `instanceof` checks meaningful
	 * without a static import.
	 */
	private async client(operation: SandboxOperation): Promise<ModalClient> {
		const sdk = await loadModalSdk();
		if (this.options.client) return this.options.client;
		if (this.cachedClient) return this.cachedClient;

		const tokenId = this.options.tokenId ?? process.env.MODAL_TOKEN_ID;
		const tokenSecret = this.options.tokenSecret ?? process.env.MODAL_TOKEN_SECRET;
		if (!tokenId || !tokenSecret) {
			throw new SandboxProviderError({
				message:
					"MODAL_TOKEN_ID / MODAL_TOKEN_SECRET are not both set. The Modal provider brokers every "
					+ "sandbox call with a Modal token pair; without one it cannot create, inspect or "
					+ "terminate a box. Create a token at https://modal.com/settings/tokens and set both "
					+ "MODAL_TOKEN_ID and MODAL_TOKEN_SECRET.",
				errorType: "invalid_config",
				provider: PROVIDER_NAME,
				operation,
			});
		}
		this.cachedClient = new sdk.ModalClient({ tokenId, tokenSecret });
		return this.cachedClient;
	}

	private appName(): string {
		return this.options.appName ?? process.env.MODAL_APP_NAME ?? "harbor";
	}

	/**
	 * Turn any thrown value into a classified `SandboxProviderError`. A
	 * `SandboxProviderError` already thrown (e.g. the missing-credential one) passes
	 * through untouched so its `errorType` is preserved rather than reclassified.
	 */
	private wrap(err: unknown, operation: SandboxOperation): SandboxProviderError {
		if (err instanceof SandboxProviderError) return err;
		const detail = (err instanceof Error ? err.message : String(err)).slice(0, 500);
		return new SandboxProviderError({
			message: `Modal refused ${operation}: ${detail}`,
			errorType: classifyModalError(err),
			provider: PROVIDER_NAME,
			operation,
			detail,
			cause: err,
		});
	}

	async create(config: CreateSandboxConfig): Promise<CreatedSandbox> {
		assertFeaturesSupported(this, config, "create");

		const client = await this.client("create");
		// Modal's per-sandbox lifetime backstop (its own default of 5 min is too
		// short for an agent turn). Distinct from `config.timeoutMs`, the caller's
		// boot ceiling, which the gRPC client's own request timeout governs.
		const timeoutMs =
			this.options.timeoutMs ?? Number(process.env.MODAL_SANDBOX_TIMEOUT_MS ?? "3600000");

		const tags = {
			[TAG.managed]: "true",
			[TAG.attempt]: config.attemptId,
			[TAG.session]: config.sessionId,
			[TAG.sandbox]: config.sandboxId,
		};

		try {
			const app = await client.apps.fromName(this.appName(), { createIfMissing: true });
			// `config.image` is the registry tag Harbor hands the backend, per the contract.
			const image = client.images.fromRegistry(config.image);
			const sandbox = await client.sandboxes.create(app, image, {
				// Absent command → the image's own entrypoint (what the Harbor image is built for).
				...(config.command && config.command.length > 0 ? { command: config.command } : {}),
				env: config.env,
				timeoutMs,
				// The single most important line: stamp the attempt id (+ managed, session,
				// sandbox) as searchable tags AS PART OF the create call, so a box created by
				// a call whose response we lost is discoverable rather than an invisible orphan.
				tags,
			});
			// Belt-and-suspenders: reassert the tags. `create` already carries them, but a
			// second write costs nothing and keeps the attempt id present even if a future
			// SDK version drops `tags` from `SandboxCreateParams`.
			await sandbox.setTags(tags);

			return {
				externalId: sandbox.sandboxId,
				provider: PROVIDER_NAME,
				attemptId: config.attemptId,
				state: modalState("running"),
				createdAt: new Date().toISOString(),
			};
		} catch (err) {
			throw this.wrap(err, "create");
		}
	}

	async inspect(externalId: string): Promise<SandboxInspection | null> {
		const client = await this.client("inspect");
		let sandbox;
		try {
			sandbox = await client.sandboxes.fromId(externalId);
		} catch (err) {
			// A NotFoundError is the one outcome that is an *answer*: Modal replied and
			// has no such sandbox. Everything else is rethrown (and classified).
			if (isModalError(err, "NotFoundError")) return null;
			throw this.wrap(err, "inspect");
		}

		try {
			// `poll()` is null while running, else the exit code.
			const exitCode = await sandbox.poll();
			const tags = await this.tagsOf(sandbox);
			return this.toInspection(sandbox.sandboxId, exitCode, tags);
		} catch (err) {
			throw this.wrap(err, "inspect");
		}
	}

	/**
	 * Reconciliation. `null` means Modal answered and no sandbox carries this
	 * attempt tag; a call that cannot reach Modal THROWS, per the authority rule —
	 * returning `null` on a lost connection starts a second box on the same branch.
	 *
	 * Fail closed: only an empty iteration returns `null`. Any error surfacing from
	 * the async generator (or the per-box poll/getTags) is rethrown, never swallowed.
	 */
	async findByAttemptId(attemptId: string): Promise<SandboxInspection | null> {
		const client = await this.client("find_by_attempt");
		const found: SandboxInspection[] = [];
		try {
			for await (const sandbox of client.sandboxes.list({ tags: { [TAG.attempt]: attemptId } })) {
				const exitCode = await sandbox.poll();
				const tags = await this.tagsOf(sandbox);
				found.push(this.toInspection(sandbox.sandboxId, exitCode, tags));
			}
		} catch (err) {
			throw this.wrap(err, "find_by_attempt");
		}

		if (found.length === 0) return null;
		if (found.length > 1) {
			console.warn(
				`[modal] ${found.length} sandboxes share attempt ${attemptId}: `
					+ `${found.map((i) => i.externalId).join(", ")}. Adopting a live one; the rest are `
					+ "orphans and must be terminated.",
			);
		}
		return found.find((i) => i.state === "running" || i.state === "starting") ?? found[0]!;
	}

	/**
	 * Every LIVE Harbor-managed sandbox. Filtered on `harbor_managed` rather than
	 * listing the whole account, because a self-hoster's Modal workspace may run
	 * things Harbor did not create and every entry here is a stop candidate.
	 *
	 * Fails CLOSED, same as `findByAttemptId`: an unreachable Modal throws rather
	 * than returning `[]`. An empty list from a dead control plane reads as "no
	 * orphans anywhere", the exact conclusion that lets a stranded box bill forever.
	 */
	async listManaged(): Promise<SandboxInspection[]> {
		const client = await this.client("list_managed");
		const out: SandboxInspection[] = [];
		try {
			for await (const sandbox of client.sandboxes.list({ tags: { [TAG.managed]: "true" } })) {
				const exitCode = await sandbox.poll();
				const tags = await this.tagsOf(sandbox);
				out.push(this.toInspection(sandbox.sandboxId, exitCode, tags));
			}
		} catch (err) {
			throw this.wrap(err, "list_managed");
		}
		return out.filter((i) => i.state === "running" || i.state === "starting");
	}

	async stop(externalId: string, _options?: StopOptions): Promise<StopOutcome> {
		const client = await this.client("stop");
		let sandbox;
		try {
			sandbox = await client.sandboxes.fromId(externalId);
		} catch (err) {
			// The box is gone entirely: nothing to do, and not an error on a retry path.
			if (isModalError(err, "NotFoundError")) return "absent";
			throw this.wrap(err, "stop");
		}

		try {
			await sandbox.terminate();
			return "stopped";
		} catch (err) {
			// Idempotency: stop is called from retrying paths (a sweep, a double-press, a
			// reconciler). A box that vanished between fromId and terminate is `absent`; one
			// Modal reports as already finished is `already_stopped`. Neither throws.
			if (isModalError(err, "NotFoundError")) return "absent";
			const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
			if (isModalError(err, "AlreadyExistsError") || /already|terminated|not running|finished|stopped/.test(message)) {
				return "already_stopped";
			}
			throw this.wrap(err, "stop");
		}
	}

	/** Tags are best-effort provenance; a getTags the SDK version lacks must not
	 * break inspect/list, so an absent method or an empty read degrades to `{}`. */
	private async tagsOf(sandbox: { getTags?: () => Promise<Record<string, string>> }): Promise<Record<string, string>> {
		if (typeof sandbox.getTags !== "function") return {};
		return (await sandbox.getTags()) ?? {};
	}

	private toInspection(
		externalId: string,
		exitCode: number | null,
		tags: Record<string, string>,
	): SandboxInspection {
		// `poll()` collapses Modal's lifecycle into two observable facts: running
		// (null) or exited (a code). rawState keeps the code for the post-mortem.
		const raw = exitCode === null ? "running" : "exited";
		return {
			externalId,
			provider: PROVIDER_NAME,
			state: modalState(raw),
			rawState: exitCode === null ? "running" : `exited (${exitCode})`,
			attemptId: tags[TAG.attempt] ?? null,
			sessionId: tags[TAG.session] ?? null,
			sandboxId: tags[TAG.sandbox] ?? null,
			// Modal's Sandbox object exposes no create timestamp; Harbor's own row carries it.
			startedAt: null,
			exitCode,
		};
	}
}

export function modalProvider(options?: ModalProviderOptions): EphemeralProvider {
	return new ModalSandboxProvider(options);
}
