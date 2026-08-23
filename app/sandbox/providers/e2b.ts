// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * E2B — a code-interpreter sandbox reached over a plain REST control plane.
 *
 * E2B splits its API in two: a REST control plane (`https://api.e2b.app`) for the
 * lifecycle — create, get, kill, list — and a gRPC data plane for exec and
 * filesystem streaming. Harbor never touches the data plane: a box runs its own
 * entrypoint and calls the control plane back over HTTP, exactly as the docker and
 * Fly boxes do. So this provider needs only the REST half, which means it is the
 * same self-contained `fetch`-and-nothing-else shape as `fly.ts` — no `e2b` SDK,
 * no gRPC runtime, no language shim.
 *
 * `kind: "ephemeral"`. E2B can pause and resume a sandbox (that is what
 * `autoPause` is), which would make it `persistent`. Harbor advertises the weaker
 * capability it can honour on a bad day (see `docs/provider-checklist.md`): a
 * paused E2B sandbox expires, and a resume with nothing to resume has nowhere to
 * fall back to, whereas create-and-kill always works. Promote to `persistent`
 * only once the resume path is proven against the contract suite.
 *
 * Two disciplines carried from `fly.ts`, for the same reasons:
 *   1. **The attempt id is sandbox metadata**, attached at create. Reconciliation
 *      lists on it to turn a box from a lost create response into a discoverable
 *      one rather than an invisible orphan burning money.
 *   2. **`findByAttemptId` fails CLOSED.** A list call that cannot reach E2B throws
 *      `transient` rather than returning `null`, because a caller reading `null`
 *      starts a second box on the same branch.
 *
 * Verified here with an injected `fetch` (see `e2b.test.ts`); the shared provider
 * contract suite runs it against real E2B when `E2B_API_KEY` is set and skips loud
 * when it is not.
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

const PROVIDER_NAME = "e2b";

/**
 * Metadata keys, mirroring the docker labels and Fly metadata one-for-one.
 * `harbor_attempt` is the idempotency key reconciliation lists on; the rest are
 * what a human greps and what a post-mortem joins on.
 */
const META = {
	attempt: "harbor_attempt",
	session: "harbor_session",
	sandbox: "harbor_sandbox",
	managed: "harbor_managed",
} as const;

export interface E2BProviderOptions {
	/** Injected for tests; defaults to the global. */
	fetch?: typeof fetch;
	/** Defaults to `E2B_API_KEY`. */
	apiKey?: string;
	/** Defaults to `E2B_API_HOST` then E2B's public control plane. */
	apiHost?: string;
	/**
	 * The auto-kill TTL, in seconds, E2B applies as a backstop. Harbor drives its
	 * own inactivity sweep, so this is only a ceiling that reclaims a box Harbor
	 * lost track of entirely; defaults to `E2B_SANDBOX_TIMEOUT_SEC`. Read inline
	 * (not a module constant) so a self-hoster can raise it without forking.
	 */
	timeoutSec?: number;
}

interface E2BSandbox {
	sandboxID?: string;
	sandboxId?: string;
	templateID?: string;
	state?: string;
	startedAt?: string;
	metadata?: Record<string, string>;
}

/** E2B's states → Harbor's six. `running`/`paused` are already in the deny-list. */
function e2bState(raw: string): ProviderSandboxState {
	return normalizeProviderState(raw);
}

/** HTTP status → the circuit breaker's vocabulary. Mirrors `classifyFlyStatus`. */
function classifyE2BStatus(status: number): ProviderErrorType {
	if (status === 401 || status === 403) return "unauthorized";
	if (status === 404) return "not_found";
	if (status === 402) return "quota_exceeded";
	if (status === 422 || status === 400) return "invalid_config";
	if (status === 429) return "rate_limited";
	if (status >= 500) return "transient";
	return "unknown";
}

function sandboxIdOf(box: E2BSandbox): string | undefined {
	return box.sandboxID ?? box.sandboxId;
}

export class E2BSandboxProvider implements EphemeralProvider {
	readonly name = PROVIDER_NAME;
	readonly kind = "ephemeral" as const;
	readonly capabilities: SandboxCapabilities = {
		// E2B can auto-kill on its own timeout, but Harbor drives the inactivity
		// sweep so behaviour matches every other provider; two systems each believing
		// the other reaps the box is how a live agent gets killed mid-turn.
		supportsSandboxTimeout: false,
		supportsSnapshots: false,
		supportsRestore: false,
		// E2B pause/resume exists; not wired, so not advertised — see the header.
		supportsPersistentResume: false,
		supportsExplicitStop: true,
		supportsTunnels: false,
	};
	readonly supportedFeatures: readonly string[] = [];

	private readonly fetchImpl: typeof fetch;
	private readonly options: E2BProviderOptions;

	constructor(options: E2BProviderOptions = {}) {
		this.options = options;
		this.fetchImpl = options.fetch ?? globalThis.fetch;
	}

	private apiKey(operation: SandboxOperation): string {
		const key = this.options.apiKey ?? process.env.E2B_API_KEY;
		if (!key) {
			throw new SandboxProviderError({
				message:
					"E2B_API_KEY is not set. The E2B provider brokers every sandbox call with an "
					+ "E2B API key; without one it cannot create, inspect or kill a box. Create one at "
					+ "https://e2b.dev/dashboard and set E2B_API_KEY.",
				errorType: "invalid_config",
				provider: PROVIDER_NAME,
				operation,
			});
		}
		return key;
	}

	private base(): string {
		return (this.options.apiHost ?? process.env.E2B_API_HOST ?? "https://api.e2b.app").replace(
			/\/+$/,
			"",
		);
	}

	/**
	 * One request, one place the auth header and error classification live.
	 *
	 * A transport failure (E2B unreachable, DNS, timeout) is `transient` and throws,
	 * never a `null` — the authority rule that keeps a network blip from becoming a
	 * second box.
	 */
	private async request(
		method: string,
		path: string,
		operation: SandboxOperation,
		body?: unknown,
	): Promise<{ status: number; json: unknown }> {
		const key = this.apiKey(operation);
		const url = `${this.base()}${path}`;
		let response: Response;
		try {
			response = await this.fetchImpl(url, {
				method,
				headers: {
					"X-API-Key": key,
					"Content-Type": "application/json",
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		} catch (cause) {
			throw new SandboxProviderError({
				message: `E2B API unreachable during ${operation}: ${(cause as Error).message}`,
				errorType: "transient",
				provider: PROVIDER_NAME,
				operation,
				cause,
			});
		}

		const text = await response.text();
		let json: unknown = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			json = { raw: text.slice(0, 500) };
		}
		return { status: response.status, json };
	}

	private fail(status: number, operation: SandboxOperation, json: unknown): SandboxProviderError {
		const detail =
			json && typeof json === "object" && ("message" in json || "error" in json)
				? String((json as Record<string, unknown>).message ?? (json as Record<string, unknown>).error).slice(0, 500)
				: JSON.stringify(json).slice(0, 500);
		return new SandboxProviderError({
			message: `E2B refused ${operation} (${status}): ${detail}`,
			errorType: classifyE2BStatus(status),
			provider: PROVIDER_NAME,
			operation,
			detail,
		});
	}

	async create(config: CreateSandboxConfig): Promise<CreatedSandbox> {
		assertFeaturesSupported(this, config, "create");

		const timeout =
			this.options.timeoutSec ?? Number(process.env.E2B_SANDBOX_TIMEOUT_SEC ?? "3600");

		const { status, json } = await this.request("POST", "/sandboxes", "create", {
			// `config.image` is the E2B template id, per the provider contract.
			templateID: config.image,
			timeout,
			// Harbor injects the full clone→agent environment; E2B runs the template's
			// own start command, or `config.command` when the caller supplies one.
			envVars: config.env,
			metadata: {
				[META.managed]: "true",
				[META.attempt]: config.attemptId,
				[META.session]: config.sessionId,
				[META.sandbox]: config.sandboxId,
			},
			...(config.command && config.command.length > 0 ? { cmd: config.command } : {}),
		});
		if (status !== 200 && status !== 201) throw this.fail(status, "create", json);

		const box = json as E2BSandbox;
		const id = sandboxIdOf(box);
		if (!id) {
			throw new SandboxProviderError({
				message: "E2B created a sandbox but returned no id, so it cannot be tracked or reaped.",
				errorType: "unknown",
				provider: PROVIDER_NAME,
				operation: "create",
			});
		}

		return {
			externalId: id,
			provider: PROVIDER_NAME,
			attemptId: config.attemptId,
			state: e2bState(box.state ?? "running"),
			createdAt: new Date().toISOString(),
		};
	}

	async inspect(externalId: string): Promise<SandboxInspection | null> {
		const { status, json } = await this.request(
			"GET",
			`/sandboxes/${encodeURIComponent(externalId)}`,
			"inspect",
		);
		// 404 is the one status that is an answer rather than an error: E2B replied
		// and has no such sandbox. Anything else non-200 is rethrown.
		if (status === 404) return null;
		if (status !== 200) throw this.fail(status, "inspect", json);
		return this.toInspection(json as E2BSandbox);
	}

	/**
	 * Reconciliation. `null` means E2B answered and has no sandbox carrying this
	 * attempt metadata; a call that cannot reach E2B throws, per the authority note
	 * on the base interface — returning `null` on a lost connection starts a second
	 * box on the same branch.
	 */
	async findByAttemptId(attemptId: string): Promise<SandboxInspection | null> {
		// Deliberately NOT narrowed with `state=running`. It was, and that made a
		// still-booting box read as absent — so a retry after a lost create response
		// started a SECOND box on the same branch, which is the exact duplicate this
		// method exists to prevent. `runloop.ts` argues the same point in its own
		// header. The client-side selection below already prefers a live box, so
		// asking for everything and choosing here is both safer and no more work.
		const { status, json } = await this.request(
			"GET",
			`/sandboxes?metadata=${encodeURIComponent(`${META.attempt}:${attemptId}`)}`,
			"find_by_attempt",
		);
		if (status !== 200) throw this.fail(status, "find_by_attempt", json);

		const boxes = this.asSandboxList(json).filter(
			(box) => box.metadata?.[META.attempt] === attemptId,
		);
		if (boxes.length === 0) return null;
		if (boxes.length > 1) {
			console.warn(
				`[e2b] ${boxes.length} sandboxes share attempt ${attemptId}: `
					+ `${boxes.map((b) => sandboxIdOf(b)).join(", ")}. Adopting a live one; the rest are `
					+ "orphans and must be killed.",
			);
		}
		const inspections = boxes.map((box) => this.toInspection(box));
		return (
			inspections.find((i) => i.state === "running" || i.state === "starting") ?? inspections[0]!
		);
	}

	async stop(externalId: string, _options?: StopOptions): Promise<StopOutcome> {
		// Ephemeral: killing reclaims the box entirely.
		const { status, json } = await this.request(
			"DELETE",
			`/sandboxes/${encodeURIComponent(externalId)}`,
			"stop",
		);
		if (status === 404) return "absent";
		if (status === 200 || status === 202 || status === 204) return "stopped";
		// A box already killed can report 409/412 or an "already"/"not found" body;
		// treat it as the idempotent already-gone case rather than an error, because
		// stop is called from retrying paths.
		const detail = JSON.stringify(json).toLowerCase();
		if (/already|not found|not running|killed|stopped/.test(detail)) return "already_stopped";
		throw this.fail(status, "stop", json);
	}

	/**
	 * Every live Harbor-managed sandbox. Filtered on `harbor_managed` rather than
	 * listing the whole account, because a self-hoster's E2B account may run things
	 * Harbor did not create and every entry here is a stop candidate.
	 *
	 * Fails CLOSED: a non-200 throws rather than returning `[]`. An empty list from
	 * an unreachable API reads as "no orphans anywhere", which is exactly the
	 * conclusion that lets a stranded box bill until someone notices the invoice.
	 */
	async listManaged(): Promise<SandboxInspection[]> {
		// Same reasoning as `findByAttemptId`: no `state=running` in the query. The
		// client-side filter below already restricts to live boxes, and narrowing
		// server-side additionally hid a box wedged in `starting` from the orphan
		// sweep — which is precisely the box most worth reaping, because nothing
		// else will ever clean it up.
		const { status, json } = await this.request(
			"GET",
			`/sandboxes?metadata=${encodeURIComponent(`${META.managed}:true`)}`,
			"list_managed",
		);
		if (status !== 200) throw this.fail(status, "list_managed", json);

		return this.asSandboxList(json)
			.filter((box) => box.metadata?.[META.managed] === "true")
			.map((box) => this.toInspection(box))
			.filter((i) => i.state === "running" || i.state === "starting");
	}

	/** E2B has returned both a bare array and a `{ sandboxes: [...] }` envelope. */
	private asSandboxList(json: unknown): E2BSandbox[] {
		if (Array.isArray(json)) return json as E2BSandbox[];
		if (json && typeof json === "object" && Array.isArray((json as { sandboxes?: unknown }).sandboxes)) {
			return (json as { sandboxes: E2BSandbox[] }).sandboxes;
		}
		return [];
	}

	private toInspection(box: E2BSandbox): SandboxInspection {
		const metadata = box.metadata ?? {};
		const raw = box.state ?? "unknown";
		return {
			externalId: sandboxIdOf(box) ?? "",
			provider: PROVIDER_NAME,
			state: e2bState(raw),
			rawState: raw,
			attemptId: metadata[META.attempt] ?? null,
			sessionId: metadata[META.session] ?? null,
			sandboxId: metadata[META.sandbox] ?? null,
			startedAt: box.startedAt ?? null,
			exitCode: null,
		};
	}
}

export function e2bProvider(options?: E2BProviderOptions): EphemeralProvider {
	return new E2BSandboxProvider(options);
}
