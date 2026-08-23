// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Vercel Sandbox — an ephemeral Linux microVM created through the first-party
 * `@vercel/sandbox` SDK (v3.0.0), not a raw REST client.
 *
 * Unlike `fly.ts` and `e2b.ts`, this backend has a real vendor SDK, so the
 * transport is the SDK's static `Sandbox` class rather than an injected `fetch`.
 * The SDK is reached through an injectable `options.sandboxApi` seam (defaulting
 * to the real `Sandbox`, loaded lazily) so the unit test never touches the
 * network, and `options.fetch` is threaded into every SDK call as the SDK's own
 * HTTP transport for the same reason.
 *
 * `kind: "ephemeral"`. Vercel sandboxes CAN snapshot/fork and expose ports on a
 * public domain, which would make this `snapshot` or add tunnels — but Harbor's
 * rule is *advertise the capability you can honour on a bad day*
 * (`docs/provider-checklist.md`). None of that is wired, so all capability
 * booleans except `supportsExplicitStop` are `false`.
 *
 * ── The reconciliation wrinkle, and the finding behind it ───────────────────
 *
 * The task brief assumed the SDK exposes NO list method and NO searchable
 * metadata, and asked for a raw `fetch` against `GET /v1/sandboxes`. Reading the
 * installed `node_modules/@vercel/sandbox/dist/sandbox.d.ts` shows that premise
 * is stale for v3.0.0:
 *
 *   - `Sandbox.create` accepts `tags: Record<string,string>` (max 5) — real,
 *     searchable metadata — so the attempt id is stamped as a TAG, exactly like
 *     the Fly/E2B `harbor_*` labels, and round-trips through `inspect`/`list`.
 *   - `Sandbox.list({ namePrefix, tags, ...creds })` is a first-class,
 *     auto-paginating, typed list that filters server-side by name prefix AND
 *     tags and returns `name`/`status`/`tags`/`createdAt`. Reconciliation uses
 *     it directly; there is no need to guess a REST path, which the checklist
 *     forbids ("do not guess endpoint paths").
 *
 * So the attempt id lives in TWO places, tags being authoritative:
 *   1. `tags.harbor_attempt` (+ session/sandbox/managed) — what `findByAttemptId`
 *      and `listManaged` match on.
 *   2. the sandbox NAME, `harbor-<slug(attemptId)>` — because the SDK's identity
 *      for a sandbox is its NAME (there is no `sandboxId`; `Sandbox.get` takes
 *      `{ name }`), so the external id Harbor stores IS the name, and the
 *      `harbor-` prefix makes managed boxes greppable and scans the list cheaply.
 *
 * ── What this provider deliberately does NOT do ────────────────────────────
 *
 *   - It does NOT run `config.command` at boot. Vercel's `create` has no
 *     boot-command parameter; commands run post-create via `runCommand`, which
 *     Harbor's control-plane-callback model (the box runs its own entrypoint and
 *     calls Harbor back) does not use. A supplied `config.command` is ignored,
 *     which is stated here rather than silently.
 *   - Name-based reconciliation is a WEAK fallback only. A slugged/truncated name
 *     is not reliably reversible to the original attempt id, so `inspect` prefers
 *     the `harbor_attempt` TAG and falls back to the name suffix only when tags
 *     are missing. Matching in `findByAttemptId`/`listManaged` is tag-driven.
 *   - A Vercel sandbox has a MAX LIFETIME of ~45 minutes; it auto-terminates when
 *     its `timeout` elapses regardless of Harbor's own inactivity sweep. The
 *     default lifetime is read inline from `VERCEL_SANDBOX_TIMEOUT_MS` (45m).
 *
 * Verified with an injected `sandboxApi` (see `vercel.test.ts`); the shared
 * provider-contract suite runs it against real Vercel when the `VERCEL_*`
 * credentials are set and skips loud otherwise.
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

const PROVIDER_NAME = "vercel";

/**
 * The name prefix that marks a sandbox as Harbor-managed and makes the list scan
 * cheap. A string constant (not numeric), so it is allowed at module level.
 */
const HARBOR_PREFIX = "harbor-";

/**
 * Tag keys, mirroring the Fly/E2B `harbor_*` labels one-for-one. `harbor_attempt`
 * is the idempotency key reconciliation matches on; the rest are what a human
 * greps and what a post-mortem joins on. Vercel allows at most 5 tags; this uses 4.
 */
const META = {
	attempt: "harbor_attempt",
	session: "harbor_session",
	sandbox: "harbor_sandbox",
	managed: "harbor_managed",
} as const;

/**
 * The minimal structural shape this provider needs from the `@vercel/sandbox`
 * SDK. Defined here rather than importing the SDK's types so the unit test can
 * inject a plain fake, and so a signature drift in the SDK surfaces as one
 * compile error at the adapter below rather than scattered across the file.
 */
export interface VercelSandboxHandle {
	readonly name: string;
	readonly status: string;
	readonly tags?: Record<string, string>;
	readonly createdAt?: Date | number;
	stop(opts?: { signal?: AbortSignal }): Promise<unknown>;
}

interface VercelListedSandbox {
	name: string;
	status: string;
	tags?: Record<string, string>;
	createdAt?: Date | number;
}

interface VercelPaginatorLike {
	toArray(): Promise<VercelListedSandbox[]>;
}

export interface VercelSandboxApi {
	create(params: Record<string, unknown>): Promise<VercelSandboxHandle>;
	get(params: Record<string, unknown>): Promise<VercelSandboxHandle>;
	list(params: Record<string, unknown>): Promise<VercelPaginatorLike>;
}

export interface VercelProviderOptions {
	/**
	 * Injected for tests; defaults to the real `@vercel/sandbox` `Sandbox` static
	 * class, loaded lazily so unit tests that inject this seam never import the SDK.
	 */
	sandboxApi?: VercelSandboxApi;
	/** Injected as the SDK's HTTP transport for tests; defaults to the SDK's global. */
	fetch?: typeof fetch;
	/** Defaults to `VERCEL_TOKEN`. An OIDC token or a personal access token. */
	token?: string;
	/** Defaults to `VERCEL_TEAM_ID`. */
	teamId?: string;
	/** Defaults to `VERCEL_PROJECT_ID`. */
	projectId?: string;
}

/**
 * The real SDK, behind a lazy dynamic import so the unit test (which injects
 * `sandboxApi`) never loads `@vercel/sandbox` or its transitive deps. Only the
 * params are cast — the returned `Sandbox`/`Paginator` are structurally the
 * handles above.
 */
const defaultSandboxApi: VercelSandboxApi = {
	async create(params) {
		const { Sandbox } = await import("@vercel/sandbox");
		return Sandbox.create(params as never);
	},
	async get(params) {
		const { Sandbox } = await import("@vercel/sandbox");
		return Sandbox.get(params as never);
	},
	async list(params) {
		const { Sandbox } = await import("@vercel/sandbox");
		return Sandbox.list(params as never);
	},
};

/**
 * Vercel's session statuses → Harbor's six, as a deny-list.
 *
 * `failed`/`aborted` are the two terminal spellings the shared normaliser does
 * not know — they mean the box is dead and reclaimable, so map to `exited`.
 * `running`/`stopped`/`pending` are already handled by `normalizeProviderState`.
 * `stopping`/`snapshotting` are transient and deliberately fall through to
 * `unknown` (treated as LIVE) rather than being guessed dead — reaping a box that
 * is only mid-snapshot would lose the very work it is capturing.
 */
function vercelState(raw: string): ProviderSandboxState {
	const value = raw.trim().toLowerCase();
	if (value === "failed" || value === "aborted") return "exited";
	return normalizeProviderState(value);
}

/** HTTP status → the circuit breaker's vocabulary. Mirrors `classifyFlyStatus`. */
function classifyVercelStatus(status: number): ProviderErrorType {
	if (status === 401 || status === 403) return "unauthorized";
	if (status === 404) return "not_found";
	if (status === 402) return "quota_exceeded";
	if (status === 422 || status === 400) return "invalid_config";
	if (status === 429) return "rate_limited";
	if (status >= 500) return "transient";
	return "unknown";
}

/**
 * The HTTP status carried by a thrown SDK error, if any.
 *
 * The SDK's `APIError` carries `.response.status`; this reads it by duck-typing
 * rather than `instanceof` so the same path classifies both a real `APIError` and
 * the plain fakes the unit test throws. `undefined` means the throw carried no
 * status at all — a transport failure (DNS, ECONNREFUSED, an aborted request),
 * which is `transient`.
 */
function statusOf(err: unknown): number | undefined {
	if (err && typeof err === "object") {
		const response = (err as { response?: { status?: unknown } }).response;
		if (response && typeof response.status === "number") return response.status;
		const status = (err as { status?: unknown }).status;
		if (typeof status === "number") return status;
	}
	return undefined;
}

function slugForName(attemptId: string): string {
	return attemptId
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 50);
}

function harborName(attemptId: string): string {
	return `${HARBOR_PREFIX}${slugForName(attemptId)}`;
}

/** Best-effort only: a slugged name may not equal the original id. Tags are authoritative. */
function attemptFromName(name: string): string | null {
	return name.startsWith(HARBOR_PREFIX) ? name.slice(HARBOR_PREFIX.length) : null;
}

function toIso(value: Date | number | undefined): string | null {
	if (value === undefined || value === null) return null;
	if (value instanceof Date) return value.toISOString();
	return new Date(value).toISOString();
}

export class VercelSandboxProvider implements EphemeralProvider {
	readonly name = PROVIDER_NAME;
	readonly kind = "ephemeral" as const;
	readonly capabilities: SandboxCapabilities = {
		// Vercel auto-terminates on its own `timeout`, but Harbor drives the
		// inactivity sweep so behaviour matches every other provider; two systems
		// each believing the other reaps the box is how a live agent gets killed.
		supportsSandboxTimeout: false,
		// Vercel can snapshot/fork; not wired, so not advertised — see the header.
		supportsSnapshots: false,
		supportsRestore: false,
		supportsPersistentResume: false,
		supportsExplicitStop: true,
		// Vercel can publish ports on a public `.vercel.run` domain, but wiring that
		// into Harbor's tunnel model is not done, and claiming it before it works is
		// how a dev server reaches the public internet by accident.
		supportsTunnels: false,
	};
	readonly supportedFeatures: readonly string[] = [];

	private readonly api: VercelSandboxApi;
	private readonly options: VercelProviderOptions;

	constructor(options: VercelProviderOptions = {}) {
		this.options = options;
		this.api = options.sandboxApi ?? defaultSandboxApi;
	}

	/**
	 * The three Vercel credentials, resolved lazily per-op. A missing one is an
	 * `invalid_config` the operator must fix — NEVER a `transient` that the circuit
	 * breaker would retry forever.
	 */
	private credentials(operation: SandboxOperation): {
		token: string;
		teamId: string;
		projectId: string;
	} {
		const token = this.options.token ?? process.env.VERCEL_TOKEN;
		const teamId = this.options.teamId ?? process.env.VERCEL_TEAM_ID;
		const projectId = this.options.projectId ?? process.env.VERCEL_PROJECT_ID;
		const missing: string[] = [];
		if (!token) missing.push("VERCEL_TOKEN");
		if (!teamId) missing.push("VERCEL_TEAM_ID");
		if (!projectId) missing.push("VERCEL_PROJECT_ID");
		if (missing.length > 0) {
			throw new SandboxProviderError({
				message:
					`${missing.join(", ")} not set. The Vercel provider brokers every sandbox call `
					+ "with a Vercel token scoped to a team and project; without all three it cannot "
					+ "create, inspect or stop a box. Create a token at "
					+ "https://vercel.com/account/tokens and set VERCEL_TOKEN, VERCEL_TEAM_ID and "
					+ "VERCEL_PROJECT_ID.",
				errorType: "invalid_config",
				provider: PROVIDER_NAME,
				operation,
			});
		}
		return { token: token!, teamId: teamId!, projectId: projectId! };
	}

	/**
	 * Turn a thrown SDK value into a classified `SandboxProviderError`.
	 *
	 * A throw carrying an HTTP status is classified from it (default `unknown`, NOT
	 * `transient` — a bad image must not trip the breaker). A throw with no status
	 * is a transport failure and is `transient`, which is what makes the authority
	 * methods fail CLOSED.
	 */
	private fromThrown(err: unknown, operation: SandboxOperation): SandboxProviderError {
		if (err instanceof SandboxProviderError) return err;
		const message = err instanceof Error ? err.message : String(err);
		const status = statusOf(err);
		if (status === undefined) {
			return new SandboxProviderError({
				message: `Vercel Sandbox API unreachable during ${operation}: ${message}`,
				errorType: "transient",
				provider: PROVIDER_NAME,
				operation,
				cause: err,
			});
		}
		return new SandboxProviderError({
			message: `Vercel refused ${operation} (${status}): ${message.slice(0, 500)}`,
			errorType: classifyVercelStatus(status),
			provider: PROVIDER_NAME,
			operation,
			detail: message.slice(0, 500),
			cause: err,
		});
	}

	async create(config: CreateSandboxConfig): Promise<CreatedSandbox> {
		assertFeaturesSupported(this, config, "create");
		const creds = this.credentials("create");

		const params: Record<string, unknown> = {
			name: harborName(config.attemptId),
			// Harbor injects the full clone→agent environment; the sandbox runs its
			// image's own entrypoint. `config.command` is intentionally NOT applied —
			// Vercel's create has no boot-command hook (see the header).
			env: config.env,
			// The ~45-minute max lifetime, read inline (not a module constant) so a
			// self-hoster can lower it without forking. This is Vercel's own auto-kill
			// backstop, distinct from `config.timeoutMs` (the create-call budget below).
			timeout: Number(process.env.VERCEL_SANDBOX_TIMEOUT_MS ?? "2700000"),
			resources: { vcpus: Number(process.env.VERCEL_SANDBOX_VCPUS ?? "2") },
			tags: {
				[META.managed]: "true",
				[META.attempt]: config.attemptId,
				[META.session]: config.sessionId,
				[META.sandbox]: config.sandboxId,
			},
			// Honour the caller's boot ceiling (`setting("sandboxBootTimeoutMs")`) by
			// aborting the create call itself, rather than substituting our own number.
			signal: AbortSignal.timeout(config.timeoutMs),
			...creds,
			fetch: this.options.fetch,
		};
		// `config.image` is the VCR image reference, per the provider contract. Omit
		// it when absent so the sandbox uses Vercel's default universal image.
		if (config.image) params.image = config.image;

		let box: VercelSandboxHandle;
		try {
			box = await this.api.create(params);
		} catch (err) {
			throw this.fromThrown(err, "create");
		}

		if (!box?.name) {
			throw new SandboxProviderError({
				message: "Vercel created a sandbox but returned no name, so it cannot be tracked or reaped.",
				errorType: "unknown",
				provider: PROVIDER_NAME,
				operation: "create",
			});
		}

		return {
			externalId: box.name,
			provider: PROVIDER_NAME,
			attemptId: config.attemptId,
			state: vercelState(box.status ?? "running"),
			createdAt: new Date().toISOString(),
		};
	}

	async inspect(externalId: string): Promise<SandboxInspection | null> {
		const creds = this.credentials("inspect");
		let box: VercelSandboxHandle;
		try {
			// `resume: false` so inspecting a stopped box does not restart it.
			box = await this.api.get({
				name: externalId,
				resume: false,
				...creds,
				fetch: this.options.fetch,
			});
		} catch (err) {
			// 404 is the one status that is an answer rather than an error: Vercel
			// replied and has no such sandbox. Anything else non-success is rethrown,
			// because a caller reading `null` concludes the box is gone.
			if (statusOf(err) === 404) return null;
			throw this.fromThrown(err, "inspect");
		}
		return this.toInspection(box);
	}

	/**
	 * Reconciliation. `null` means Vercel answered and has no sandbox carrying this
	 * attempt tag; a call that cannot reach Vercel THROWS, per the authority note on
	 * the base interface — returning `null` on a lost connection starts a second box
	 * on the same branch.
	 */
	async findByAttemptId(attemptId: string): Promise<SandboxInspection | null> {
		const creds = this.credentials("find_by_attempt");
		let items: VercelListedSandbox[];
		try {
			const pager = await this.api.list({
				namePrefix: HARBOR_PREFIX,
				tags: { [META.attempt]: attemptId },
				...creds,
				fetch: this.options.fetch,
			});
			items = await pager.toArray();
		} catch (err) {
			// Fails CLOSED: any failure (transport or 5xx) throws rather than an empty
			// answer. This never returns `null` on a blip.
			throw this.fromThrown(err, "find_by_attempt");
		}

		// The tag filter is honoured server-side, but a defensive client-side filter
		// costs nothing and closes the gap if a future API ignores it.
		const matching = items.filter(
			(box) => (box.tags?.[META.attempt] ?? attemptFromName(box.name)) === attemptId,
		);
		if (matching.length === 0) return null;
		if (matching.length > 1) {
			console.warn(
				`[vercel] ${matching.length} sandboxes share attempt ${attemptId}: `
					+ `${matching.map((b) => b.name).join(", ")}. Adopting a live one; the rest are `
					+ "orphans and must be stopped.",
			);
		}
		const inspections = matching.map((box) => this.toInspection(box));
		return (
			inspections.find((i) => i.state === "running" || i.state === "starting") ?? inspections[0]!
		);
	}

	async stop(externalId: string, _options?: StopOptions): Promise<StopOutcome> {
		const creds = this.credentials("stop");
		let box: VercelSandboxHandle;
		try {
			box = await this.api.get({
				name: externalId,
				resume: false,
				...creds,
				fetch: this.options.fetch,
			});
		} catch (err) {
			if (statusOf(err) === 404) return "absent";
			throw this.fromThrown(err, "stop");
		}

		// Already terminal — nothing to do. Short-circuiting here avoids a `stop()`
		// on a box the SDK would reject as not running.
		const state = vercelState(box.status ?? "unknown");
		if (state === "exited" || state === "gone") return "already_stopped";

		try {
			await box.stop();
			return "stopped";
		} catch (err) {
			if (statusOf(err) === 404) return "absent";
			// A box that raced to terminal between the get and the stop reports an
			// "already"/"not running" error; treat it as the idempotent already-gone
			// case rather than an error, because stop is called from retrying paths.
			const detail = (err instanceof Error ? err.message : String(err)).toLowerCase();
			if (/already|not running|stopped|terminated|aborted/.test(detail)) {
				return "already_stopped";
			}
			throw this.fromThrown(err, "stop");
		}
	}

	/**
	 * Every LIVE Harbor-managed sandbox. Filtered on the `harbor_managed` tag rather
	 * than listing the whole team, because a self-hoster's Vercel project may run
	 * things Harbor did not create and every entry here is a stop candidate.
	 *
	 * Fails CLOSED, per the authority note on the interface: any failure throws
	 * rather than returning `[]`. An empty list from an unreachable API reads as "no
	 * orphans anywhere", the exact conclusion that lets a stranded box bill forever.
	 *
	 * Live boxes only. A stopped/failed sandbox is already reclaimed (this provider
	 * is ephemeral, so `stop` terminates), and re-reporting one would have the sweep
	 * issue a stop for a box that is already gone.
	 */
	async listManaged(): Promise<SandboxInspection[]> {
		const creds = this.credentials("list_managed");
		let items: VercelListedSandbox[];
		try {
			const pager = await this.api.list({
				namePrefix: HARBOR_PREFIX,
				tags: { [META.managed]: "true" },
				...creds,
				fetch: this.options.fetch,
			});
			items = await pager.toArray();
		} catch (err) {
			throw this.fromThrown(err, "list_managed");
		}

		return items
			.filter((box) => box.tags?.[META.managed] === "true")
			.map((box) => this.toInspection(box))
			.filter((i) => i.state === "running" || i.state === "starting");
	}

	private toInspection(box: {
		name: string;
		status?: string;
		tags?: Record<string, string>;
		createdAt?: Date | number;
	}): SandboxInspection {
		const tags = box.tags ?? {};
		const raw = box.status ?? "unknown";
		return {
			externalId: box.name,
			provider: PROVIDER_NAME,
			state: vercelState(raw),
			rawState: raw,
			attemptId: tags[META.attempt] ?? attemptFromName(box.name),
			sessionId: tags[META.session] ?? null,
			sandboxId: tags[META.sandbox] ?? null,
			startedAt: toIso(box.createdAt),
			exitCode: null,
		};
	}
}

export function vercelProvider(options?: VercelProviderOptions): EphemeralProvider {
	return new VercelSandboxProvider(options);
}
