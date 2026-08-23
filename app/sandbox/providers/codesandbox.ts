// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * CodeSandbox — a hosted micro-VM sandbox driven through the official
 * `@codesandbox/sdk` (v2.4.x) rather than a raw REST surface.
 *
 * Unlike Fly and E2B this provider talks to its backend through a vendor SDK, so
 * the injectable transport is a *client object* (`CodeSandboxProviderOptions.client`)
 * instead of a `fetch`. The SDK's `CodeSandbox` class is constructed lazily, only
 * once a credential is actually needed, so a missing `CSB_API_KEY` surfaces as
 * `invalid_config` at the call site and never as a transient network error.
 *
 * Method names verified against `node_modules/@codesandbox/sdk/dist/esm/Sandboxes.d.ts`
 * and the bundled implementation:
 *   - `sdk.sandboxes.create({ id?, tags?, hibernationTimeoutSeconds?, title? })` → `Sandbox`
 *     (`id` is the *template* sandbox id — `config.image` maps to it; a fork of that template).
 *   - `sdk.sandboxes.resume(id)` / `sdk.sandboxes.hibernate(id)` / `sdk.sandboxes.shutdown(id)`.
 *   - `sdk.sandboxes.list({ tags?, status?: "running" })` → `{ sandboxes: SandboxInfo[] }`.
 *   - `sdk.sandboxes.get(id)` → `SandboxInfo`; `sdk.sandboxes.listRunning()` → `{ vms: [{ id }] }`.
 *
 * `kind: "ephemeral"`. CodeSandbox genuinely supports hibernate→resume (it would be
 * `persistent`), but Harbor advertises the weaker capability it can always honour:
 * `stop` hibernates/shuts the VM down and reconciliation only ever adopts a *running*
 * box, so a session that lost its VM cold-boots a fresh one rather than trusting a
 * resume path that is not yet proven against the contract suite (see
 * `docs/provider-checklist.md`). Promote to `persistent` only once resume is vetted.
 *
 * Two adaptations forced by the SDK's shape, both flagged for the orchestrator:
 *
 *   1. **attemptId lives in `tags`.** CodeSandbox tags are a flat `string[]` (max 10,
 *      the SDK also appends `"sdk"`), not a key/value map, so the four Harbor keys are
 *      encoded as single `"<key>:<value>"` strings and matched by prefix. `list({ tags })`
 *      filters server-side, so reconciliation is a real query; we still re-match the tag
 *      client-side because the server-side tag filter's AND/OR semantics are unspecified.
 *
 *   2. **Env is delivered through a session, not the create call.** Unlike a container
 *      backend, CodeSandbox does not accept environment variables on the fork/create
 *      call — env only reaches the VM through a data-plane session. So `create` forks the
 *      template, then `connect`s a session carrying `config.env` and launches the box's
 *      boot command in the background (`asGlobalSession`, so the variables are visible to
 *      every process, not just that shell). See `boot` below. This is the one place the
 *      provider touches the data plane; every other operation is pure control plane.
 *
 * `SandboxInfo` from the SDK carries no per-box VM run-state, so liveness for `inspect`
 * is derived best-effort from `listRunning()`; `find`/`list` lean on the server-side
 * `status: "running"` filter instead. Verified with an injected fake client (see the
 * test); the shared contract suite exercises it against real CodeSandbox when
 * `CSB_API_KEY` is set.
 */

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

const PROVIDER_NAME = "codesandbox";

/**
 * The Harbor metadata keys, one-for-one with the docker labels and the Fly/E2B
 * metadata. Encoded as flat `"<key>:<value>"` tag strings because CodeSandbox tags
 * are a `string[]`, not a map. `harbor_attempt` is the idempotency key reconciliation
 * lists on; the rest are what a human greps and what a post-mortem joins on.
 */
const META = {
	attempt: "harbor_attempt",
	session: "harbor_session",
	sandbox: "harbor_sandbox",
	managed: "harbor_managed",
} as const;

/**
 * A created/resumed sandbox handle — enough of the SDK's `Sandbox` to boot it.
 * `connect` opens a data-plane session whose `env` reaches the running VM.
 */
export interface CodeSandboxHandle {
	id: string;
	bootupType?: string;
	connect(session?: { env?: Record<string, string> }): Promise<CodeSandboxConnection>;
}

/** The data-plane surface Harbor uses to start the agent inside the VM. */
export interface CodeSandboxConnection {
	readonly commands: {
		/** Non-blocking: starts a long-lived process and returns a handle immediately. */
		runBackground(
			command: string | string[],
			opts?: { env?: Record<string, string>; asGlobalSession?: boolean },
		): Promise<unknown>;
	};
}

/** The slice of the `@codesandbox/sdk` surface Harbor uses, so a fake can be injected. */
export interface CodeSandboxClient {
	readonly sandboxes: {
		create(opts?: {
			id?: string;
			tags?: string[];
			hibernationTimeoutSeconds?: number;
			title?: string;
		}): Promise<CodeSandboxHandle>;
		resume(id: string): Promise<CodeSandboxHandle>;
		hibernate(id: string): Promise<void>;
		shutdown(id: string): Promise<void>;
		get(id: string): Promise<CodeSandboxInfo>;
		list(opts?: {
			tags?: string[];
			status?: "running";
			limit?: number;
		}): Promise<{ sandboxes: CodeSandboxInfo[] }>;
		listRunning(): Promise<{ vms: Array<{ id?: string }> }>;
	};
}

/** The subset of the SDK's `SandboxInfo` this provider reads. */
interface CodeSandboxInfo {
	id: string;
	tags: string[];
	createdAt?: Date;
}

export interface CodeSandboxProviderOptions {
	/** Injected for tests; defaults to a lazily-constructed `new CodeSandbox(apiKey)`. */
	client?: CodeSandboxClient;
	/** Defaults to `CSB_API_KEY`. */
	apiKey?: string;
}

/**
 * CodeSandbox's boot/VM vocabulary → Harbor's six.
 *
 * The SDK reports how a VM *booted* (`bootupType`: RUNNING/RESUME/CLEAN/FORK) rather
 * than a running/stopped status, plus the `status: "running"` list filter. Only the
 * spellings we KNOW are mapped; anything else defers to the deny-list, so a value the
 * SDK grows next year becomes `unknown` (treated as live) instead of a wrong guess.
 */
function codesandboxState(raw: string): ProviderSandboxState {
	const value = raw.trim().toLowerCase();
	if (value === "running" || value === "resume") return "running";
	// CLEAN/FORK boots re-run the sandbox setup before it is usable → still coming up.
	if (value === "clean" || value === "fork" || value === "booting") return "starting";
	if (value === "hibernated" || value === "frozen") return "paused";
	if (value === "shutdown") return "exited";
	return normalizeProviderState(raw);
}

/** HTTP status → the circuit breaker's vocabulary. Mirrors `classifyE2BStatus`. */
function classifyCodeSandboxStatus(status: number): ProviderErrorType {
	if (status === 401 || status === 403) return "unauthorized";
	if (status === 404) return "not_found";
	if (status === 402) return "quota_exceeded";
	if (status === 422 || status === 400) return "invalid_config";
	if (status === 429) return "rate_limited";
	if (status >= 500) return "transient";
	return "unknown";
}

function numericStatus(err: Record<string, unknown>): number | null {
	for (const key of ["status", "statusCode"] as const) {
		const value = err[key];
		if (typeof value === "number") return value;
	}
	const response = err.response;
	if (response && typeof response === "object" && typeof (response as { status?: unknown }).status === "number") {
		return (response as { status: number }).status;
	}
	return null;
}

/**
 * The SDK's error shape → the circuit breaker's vocabulary.
 *
 * `@codesandbox/sdk` throws plain `Error`s whose message carries the classification
 * ("Sandbox not found", "Unauthorized", "Bad gateway", the overloaded 503 text), and a
 * `RateLimitError` that sets `type = "rate-limit"` (its `name` stays "Error"). Network
 * failures propagate the raw `fetch` error unwrapped. Nothing carries an HTTP status,
 * so classification is message-driven — but a status is honoured first when present.
 *
 * The default is `unknown`, never `transient`: a bad template or a malformed request
 * must not count towards opening the circuit on what is really a configuration typo.
 */
function classifyCodeSandboxError(err: unknown): ProviderErrorType {
	if (err && typeof err === "object") {
		const record = err as Record<string, unknown>;
		if (record.type === "rate-limit") return "rate_limited";
		const status = numericStatus(record);
		if (status !== null) return classifyCodeSandboxStatus(status);
	}
	const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
	// Transport failure: the box may well exist — never conclude absence from a blip.
	if (/fetch failed|econnrefused|enotfound|eai_again|etimedout|socket hang up|network|timed out/.test(message)) {
		return "transient";
	}
	if (/not found|no such|does not exist/.test(message)) return "not_found";
	if (/unauthorized|forbidden|invalid api|invalid token|401|403/.test(message)) return "unauthorized";
	// 5xx family the SDK spells out. Checked before "invalid" so a 502 body wins.
	if (/bad gateway|overloaded|unavailable|internal server error|temporarily|502|503|500|504/.test(message)) {
		return "transient";
	}
	if (/rate limit|too many requests|429/.test(message)) return "rate_limited";
	if (/quota|payment|billing|limit reached|402/.test(message)) return "quota_exceeded";
	if (/invalid|template|not a valid|bad request|unprocessable|malformed|400|422/.test(message)) {
		return "invalid_config";
	}
	return "unknown";
}

function metaTag(key: string, value: string): string {
	return `${key}:${value}`;
}

/**
 * The command that starts the Harbor agent inside a forked CodeSandbox template.
 *
 * The template must ship the Harbor agent; the default matches the entrypoint the
 * other providers boot. Read inline from `process.env` so a self-hoster whose
 * template starts the agent differently can override it without forking — never a
 * module-level constant (the lint-config rule).
 */
function bootCommand(): string {
	return process.env.CSB_BOOT_COMMAND?.trim() || "/harbor/boot";
}

/** Reads a Harbor value back out of the flat tag list, or `null` if absent. */
function tagValue(tags: string[] | undefined, key: string): string | null {
	const prefix = `${key}:`;
	const hit = (tags ?? []).find((tag) => tag.startsWith(prefix));
	return hit ? hit.slice(prefix.length) : null;
}

export class CodeSandboxSandboxProvider implements EphemeralProvider {
	readonly name = PROVIDER_NAME;
	readonly kind = "ephemeral" as const;
	readonly capabilities: SandboxCapabilities = {
		supportsSandboxTimeout: false,
		supportsSnapshots: false,
		supportsRestore: false,
		// Hibernate/resume exists on the backend; not wired to the contract, so not advertised.
		supportsPersistentResume: false,
		supportsExplicitStop: true,
		supportsTunnels: false,
	};
	readonly supportedFeatures: readonly string[] = [];

	private readonly options: CodeSandboxProviderOptions;
	private built?: CodeSandboxClient;

	constructor(options: CodeSandboxProviderOptions = {}) {
		this.options = options;
	}

	/**
	 * The SDK client, constructed lazily so a missing credential fails as
	 * `invalid_config` at the call site rather than at import. An injected client
	 * (tests, and the contract suite's live wiring) bypasses credential resolution.
	 */
	private async resolveClient(operation: SandboxOperation): Promise<CodeSandboxClient> {
		if (this.options.client) return this.options.client;
		if (this.built) return this.built;
		const key = this.options.apiKey ?? process.env.CSB_API_KEY;
		if (!key) {
			throw new SandboxProviderError({
				message:
					"CSB_API_KEY is not set. The CodeSandbox provider brokers every sandbox call with a "
					+ "CodeSandbox API key; without one it cannot create, inspect or stop a box. Create one at "
					+ "https://codesandbox.io/t/api and set CSB_API_KEY.",
				errorType: "invalid_config",
				provider: PROVIDER_NAME,
				operation,
			});
		}
		// Imported here rather than at module scope. `@codesandbox/sdk` drags in
		// `blessed`, which loads its widgets by computed `require(path)` — unfollowable
		// by webpack, and `registry.ts` imports every provider eagerly, so a static
		// import would put it in the Next.js server bundle. Deferring it also means a
		// deployment on any other provider never pays to load a terminal UI library.
		const { CodeSandbox } = await import("@codesandbox/sdk");
		this.built = new CodeSandbox(key) as unknown as CodeSandboxClient;
		return this.built;
	}

	private wrap(operation: SandboxOperation, cause: unknown, errorType?: ProviderErrorType): SandboxProviderError {
		if (cause instanceof SandboxProviderError) return cause;
		const detail = (cause instanceof Error ? cause.message : String(cause)).slice(0, 500);
		return new SandboxProviderError({
			message: `CodeSandbox refused ${operation}: ${detail}`,
			errorType: errorType ?? classifyCodeSandboxError(cause),
			provider: PROVIDER_NAME,
			operation,
			detail,
			cause,
		});
	}

	/** One place SDK exceptions become typed `SandboxProviderError`s. */
	private async run<T>(operation: SandboxOperation, fn: () => Promise<T>): Promise<T> {
		try {
			return await fn();
		} catch (cause) {
			throw this.wrap(operation, cause);
		}
	}

	async create(config: CreateSandboxConfig): Promise<CreatedSandbox> {
		assertFeaturesSupported(this, config, "create");

		const client = await this.resolveClient("create");
		// A self-hoster can raise the auto-hibernate backstop without forking; read inline,
		// never a module constant (see the provider checklist / lint-config rule).
		const hibernationTimeoutSeconds = Number(process.env.CSB_HIBERNATION_TIMEOUT_SEC ?? "1800");

		// `config.image` is the CodeSandbox *template* id we fork from. The attempt id and
		// the rest of the Harbor identity are stamped as tags AS PART OF this create call so a
		// box from a create whose response we lost is discoverable rather than an orphan.
		const box = await this.run("create", () =>
			client.sandboxes.create({
				id: config.image || undefined,
				title: `harbor-${config.sandboxId}`,
				hibernationTimeoutSeconds,
				tags: [
					metaTag(META.managed, "true"),
					metaTag(META.attempt, config.attemptId),
					metaTag(META.session, config.sessionId),
					metaTag(META.sandbox, config.sandboxId),
				],
			}),
		);

		if (!box.id) {
			throw new SandboxProviderError({
				message: "CodeSandbox created a sandbox but returned no id, so it cannot be tracked or reaped.",
				errorType: "unknown",
				provider: PROVIDER_NAME,
				operation: "create",
			});
		}

		// Deliver env + start the agent. This is the data-plane step forced by the SDK:
		// env does not travel on the create call, only on a session (see the header).
		await this.boot(box, config);

		return {
			externalId: box.id,
			provider: PROVIDER_NAME,
			attemptId: config.attemptId,
			state: codesandboxState(box.bootupType ?? "running"),
			createdAt: new Date().toISOString(),
		};
	}

	/**
	 * Connect a session carrying `config.env` and launch the box's boot command in
	 * the background, so the forked VM actually receives `HARBOR_CONTROL_URL` and the
	 * rest of the injected environment and starts its agent.
	 *
	 * `asGlobalSession` makes the variables visible to every process in the VM, not
	 * just this shell. `runBackground` returns immediately — the agent is long-lived,
	 * so create must not block on it.
	 *
	 * Skipped only when there is nothing to inject and no explicit command (the
	 * contract suite's throwaway boxes), where the template's own entrypoint suffices.
	 * A boot failure throws: the box carries the attempt tag and the orphan sweep will
	 * reap it, and the spawn saga must not treat a box whose agent never started as a
	 * healthy sandbox.
	 */
	private async boot(box: CodeSandboxHandle, config: CreateSandboxConfig): Promise<void> {
		const hasEnv = Object.keys(config.env).length > 0;
		const hasCommand = Boolean(config.command && config.command.length > 0);
		if (!hasEnv && !hasCommand) return;

		const command: string | string[] = hasCommand ? config.command! : bootCommand();
		try {
			const connection = await box.connect({ env: config.env });
			await connection.commands.runBackground(command, {
				env: config.env,
				asGlobalSession: true,
			});
		} catch (cause) {
			throw this.wrap("create", cause);
		}
	}

	async inspect(externalId: string): Promise<SandboxInspection | null> {
		const client = await this.resolveClient("inspect");
		let info: CodeSandboxInfo;
		try {
			info = await client.sandboxes.get(externalId);
		} catch (cause) {
			const errorType = cause instanceof SandboxProviderError ? cause.errorType : classifyCodeSandboxError(cause);
			// 404 is the one non-success that is an *answer*: CodeSandbox replied and has no
			// such box. Anything else (5xx, unreachable, auth) is not an answer and throws.
			if (errorType === "not_found") return null;
			throw this.wrap("inspect", cause, errorType);
		}

		// `SandboxInfo` has no run-state, so liveness is refined best-effort from the
		// running-VM list. A failure there leaves the state `unknown` (treated as live) —
		// the box provably exists, so `inspect` must still answer rather than fail on a
		// liveness blip; the fail-closed authority rules live on find/list instead.
		let raw = "unknown";
		try {
			const running = await client.sandboxes.listRunning();
			if (running.vms.some((vm) => vm.id === externalId)) raw = "running";
		} catch {
			// keep `unknown`
		}

		return this.toInspection(info, raw);
	}

	/**
	 * Reconciliation. `null` means CodeSandbox answered and has no box carrying this
	 * attempt tag; an unreachable backend throws (via `run`), per the authority rule —
	 * returning `null` on a lost connection starts a second box on the same branch.
	 *
	 * Deliberately NOT filtered on `status: "running"`, which it was. `create` here
	 * is two-phase — fork the template, then `connect` a session to deliver env and
	 * launch the boot command — so a create whose response was lost can leave a box
	 * that is forked but not yet running. Narrowing to running made exactly that box
	 * invisible, and the retry forked a second one. Liveness is derived below the
	 * same way `inspect` does it, which is the honest answer for a `SandboxInfo`
	 * that carries no run-state.
	 */
	async findByAttemptId(attemptId: string): Promise<SandboxInspection | null> {
		const client = await this.resolveClient("find_by_attempt");
		const limit = Number(process.env.CSB_LIST_LIMIT ?? "200");
		const { sandboxes } = await this.run("find_by_attempt", () =>
			client.sandboxes.list({
				tags: [metaTag(META.managed, "true"), metaTag(META.attempt, attemptId)],
				limit,
			}),
		);

		// Re-match client-side: the server-side tag filter's AND/OR semantics are unspecified.
		const boxes = sandboxes.filter((box) => tagValue(box.tags, META.attempt) === attemptId);
		if (boxes.length === 0) return null;
		if (boxes.length > 1) {
			console.warn(
				`[codesandbox] ${boxes.length} sandboxes share attempt ${attemptId}: `
					+ `${boxes.map((b) => b.id).join(", ")}. Adopting one; the rest are orphans and must be stopped.`,
			);
		}
		// Liveness from the running-VM list, exactly as `inspect` derives it. A box
		// found by tag but absent from that list maps to `unknown`, which the shared
		// liveness rule treats as live — the fail-OPEN direction, and the correct one
		// here: the box provably exists, so reporting it dead would have the caller
		// start another.
		const box = boxes[0]!;
		let raw = "unknown";
		try {
			const running = await client.sandboxes.listRunning();
			if (running.vms.some((vm) => vm.id === box.id)) raw = "running";
		} catch {
			// keep `unknown` — a liveness blip must not turn an existing box into an
			// absent one, and authority (does it exist?) was already answered above.
		}
		return this.toInspection(box, raw);
	}

	async stop(externalId: string, _options?: StopOptions): Promise<StopOutcome> {
		const client = await this.resolveClient("stop");
		try {
			// Hibernate/shutdown reclaims the VM's compute; reconciliation only adopts running
			// boxes, so a stopped box reads as gone — the ephemeral contract.
			await client.sandboxes.shutdown(externalId);
			return "stopped";
		} catch (cause) {
			const errorType = cause instanceof SandboxProviderError ? cause.errorType : classifyCodeSandboxError(cause);
			if (errorType === "not_found") return "absent";
			// A box already down can report an "already"/"not running"/"hibernated" body; treat
			// it as the idempotent already-gone case, because stop is called from retrying paths.
			const message = (cause instanceof Error ? cause.message : String(cause)).toLowerCase();
			if (/already|not running|hibernat|shut ?down|stopped|not active/.test(message)) return "already_stopped";
			throw this.wrap("stop", cause, errorType);
		}
	}

	/**
	 * Every LIVE Harbor-managed box. Filtered on `harbor_managed` rather than the whole
	 * account, because a self-hoster's CodeSandbox workspace may hold sandboxes Harbor did
	 * not create and every entry here is a stop candidate.
	 *
	 * Fails CLOSED: an unreachable backend throws (via `run`) rather than returning `[]`.
	 * An empty list from a dead API reads as "no orphans anywhere" — exactly the conclusion
	 * that lets a stranded VM bill until someone notices the invoice.
	 */
	async listManaged(): Promise<SandboxInspection[]> {
		const client = await this.resolveClient("list_managed");
		const limit = Number(process.env.CSB_LIST_LIMIT ?? "200");
		const { sandboxes } = await this.run("list_managed", () =>
			client.sandboxes.list({
				status: "running",
				tags: [metaTag(META.managed, "true")],
				limit,
			}),
		);
		return sandboxes
			.filter((box) => tagValue(box.tags, META.managed) === "true")
			.map((box) => this.toInspection(box, "running"));
	}

	private toInspection(info: CodeSandboxInfo, raw: string): SandboxInspection {
		return {
			externalId: info.id,
			provider: PROVIDER_NAME,
			state: codesandboxState(raw),
			rawState: raw,
			attemptId: tagValue(info.tags, META.attempt),
			sessionId: tagValue(info.tags, META.session),
			sandboxId: tagValue(info.tags, META.sandbox),
			startedAt: info.createdAt ? new Date(info.createdAt).toISOString() : null,
			exitCode: null,
		};
	}
}

export function codesandboxProvider(options?: CodeSandboxProviderOptions): EphemeralProvider {
	return new CodeSandboxSandboxProvider(options);
}
