// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Morph (MorphCloud) — a microVM sandbox reached over a plain REST control plane.
 *
 * Morph's unit is an "Instance": a microVM booted from a "Snapshot" (the snapshot
 * id is what Harbor passes as `config.image`). The lifecycle Harbor needs — start
 * an instance from a snapshot, get one by id, stop one, list them by metadata —
 * is a handful of REST calls under `https://cloud.morph.so/api` authenticated with
 * a bearer token, so this provider is the same self-contained `fetch`-and-nothing-
 * else shape as `fly.ts` and `e2b.ts`: no `morphcloud` SDK, no language shim. A box
 * runs its own entrypoint and calls the Harbor control plane back over HTTP, exactly
 * as the docker, Fly and E2B boxes do.
 *
 * `kind: "ephemeral"`. Morph's snapshot/branch story is genuinely strong — you can
 * `POST /instance/{id}/snapshot` and boot a new instance from the result, which
 * would make this a `snapshot` provider — but Harbor's rule is *advertise the
 * capability you can honour on a bad day* (see `docs/provider-checklist.md`). The
 * snapshot/restore path is not wired to the contract suite yet, and a restore with
 * nothing to restore has nowhere to fall back to, whereas start-and-stop always
 * works. Promote to `snapshot` only once that path is proven against the contract
 * suite; until then a stopped Morph instance is gone.
 *
 * Two disciplines carried from the docker/Fly/E2B providers, for the same reasons:
 *   1. **The attempt id is instance metadata**, attached at create. Reconciliation
 *      lists on it (`GET /instance?metadata[harbor_attempt]=...`) to turn a box from
 *      a lost create response into a discoverable one rather than an invisible
 *      orphan burning money.
 *   2. **`findByAttemptId` fails CLOSED.** A list call that cannot reach Morph throws
 *      `transient` rather than returning `null`, because a caller reading `null`
 *      starts a second instance on the same branch.
 *
 * Verified here with an injected `fetch` (see `morph.test.ts`); the shared provider
 * contract suite runs it against real Morph when `MORPH_API_KEY` is set and skips
 * loud when it is not.
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

const PROVIDER_NAME = "morph";

/**
 * Instance metadata keys, mirroring the docker labels and Fly/E2B metadata
 * one-for-one. `harbor_attempt` is the idempotency key reconciliation lists on;
 * the rest are what a human greps and what a post-mortem joins on.
 */
const META = {
	attempt: "harbor_attempt",
	session: "harbor_session",
	sandbox: "harbor_sandbox",
	managed: "harbor_managed",
} as const;

export interface MorphProviderOptions {
	/** Injected for tests; defaults to the global. */
	fetch?: typeof fetch;
	/** Defaults to `MORPH_API_KEY`. */
	apiKey?: string;
	/** Defaults to `MORPH_API_HOST` then Morph's public control plane. */
	apiHost?: string;
	/**
	 * A backstop auto-stop TTL, in seconds, Morph applies on its own. Harbor drives
	 * its own inactivity sweep, so this is only a ceiling that reclaims an instance
	 * Harbor lost track of entirely; defaults to `MORPH_INSTANCE_TTL_SEC` and is
	 * left unset when that is absent. Read inline (not a module constant) so a
	 * self-hoster can raise it without forking.
	 */
	ttlSec?: number;
}

interface MorphInstance {
	id?: string;
	status?: string;
	metadata?: Record<string, string>;
	/** Morph reports a creation timestamp; its exact spelling is not load-bearing here. */
	created?: string;
	created_at?: string;
}

/**
 * Morph's instance status → Harbor's six.
 *
 * Morph's own vocabulary is `pending` / `ready` / `paused` / `saving` / `error`.
 * `ready`, `pending` and `paused` are already in the shared deny-list, so this only
 * has to be explicit about the two Morph-specific spellings and otherwise defer.
 * `saving` (the instance is mid-snapshot) and `error` are deliberately left to the
 * deny-list, which maps them to `unknown` — i.e. LIVE — so an instance mid-snapshot
 * or in a state we do not model is never reaped out from under its agent.
 */
function morphState(raw: string): ProviderSandboxState {
	const value = raw.trim().toLowerCase();
	if (value === "ready") return "running";
	if (value === "pending") return "starting";
	return normalizeProviderState(value);
}

/** HTTP status → the circuit breaker's vocabulary. Mirrors `classifyFlyStatus`. */
function classifyMorphStatus(status: number): ProviderErrorType {
	if (status === 401 || status === 403) return "unauthorized";
	if (status === 404) return "not_found";
	if (status === 402) return "quota_exceeded";
	if (status === 422 || status === 400) return "invalid_config";
	if (status === 429) return "rate_limited";
	if (status >= 500) return "transient";
	return "unknown";
}

export class MorphSandboxProvider implements EphemeralProvider {
	readonly name = PROVIDER_NAME;
	readonly kind = "ephemeral" as const;
	readonly capabilities: SandboxCapabilities = {
		// Morph can auto-stop on its own TTL, but Harbor drives the inactivity sweep
		// so behaviour matches every other provider; two systems each believing the
		// other reaps the box is how a live agent gets killed mid-turn.
		supportsSandboxTimeout: false,
		// Morph's snapshot/restore exists but is not wired to the contract suite; not
		// advertised until it is, per the header.
		supportsSnapshots: false,
		supportsRestore: false,
		supportsPersistentResume: false,
		supportsExplicitStop: true,
		// Morph instances can expose HTTP services on a public URL, but wiring that
		// into Harbor's tunnel model is not done, and claiming it before it works is
		// how an operator ships a dev server to the public internet by accident.
		supportsTunnels: false,
	};
	// No optional features yet: `assertFeaturesSupported` refuses an unknown one
	// loudly rather than letting an operator believe a box is more constrained than
	// it is.
	readonly supportedFeatures: readonly string[] = [];

	private readonly fetchImpl: typeof fetch;
	private readonly options: MorphProviderOptions;

	constructor(options: MorphProviderOptions = {}) {
		this.options = options;
		this.fetchImpl = options.fetch ?? globalThis.fetch;
	}

	private apiKey(operation: SandboxOperation): string {
		const key = this.options.apiKey ?? process.env.MORPH_API_KEY;
		if (!key) {
			throw new SandboxProviderError({
				message:
					"MORPH_API_KEY is not set. The Morph provider brokers every instance call with a "
					+ "Morph API key; without one it cannot start, inspect or stop a box. Create one in "
					+ "the Morph dashboard at https://cloud.morph.so and set MORPH_API_KEY.",
				errorType: "invalid_config",
				provider: PROVIDER_NAME,
				operation,
			});
		}
		return key;
	}

	private base(): string {
		return (
			this.options.apiHost ?? process.env.MORPH_API_HOST ?? "https://cloud.morph.so/api"
		).replace(/\/+$/, "");
	}

	/**
	 * One request, one place the auth header and error classification live.
	 *
	 * A transport failure (Morph unreachable, DNS, timeout) is `transient` and throws,
	 * never a `null` — the authority rule that keeps a network blip from becoming a
	 * second instance.
	 */
	private async request(
		method: string,
		path: string,
		operation: SandboxOperation,
		body?: unknown,
	): Promise<{ status: number; json: unknown }> {
		// Resolved before the try: a missing key is an `invalid_config` the operator
		// must fix, and it must not be caught below and re-reported as a `transient`
		// Morph outage that the circuit breaker would retry forever.
		const key = this.apiKey(operation);
		const url = `${this.base()}${path}`;
		let response: Response;
		try {
			response = await this.fetchImpl(url, {
				method,
				headers: {
					Authorization: `Bearer ${key}`,
					"Content-Type": "application/json",
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		} catch (cause) {
			throw new SandboxProviderError({
				message: `Morph API unreachable during ${operation}: ${(cause as Error).message}`,
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
				? String(
						(json as Record<string, unknown>).message ?? (json as Record<string, unknown>).error,
					).slice(0, 500)
				: JSON.stringify(json).slice(0, 500);
		return new SandboxProviderError({
			message: `Morph refused ${operation} (${status}): ${detail}`,
			errorType: classifyMorphStatus(status),
			provider: PROVIDER_NAME,
			operation,
			detail,
		});
	}

	async create(config: CreateSandboxConfig): Promise<CreatedSandbox> {
		assertFeaturesSupported(this, config, "create");

		// The snapshot id is a query parameter on Morph's start endpoint; the metadata
		// (and any TTL backstop) go in the JSON body.
		const params = new URLSearchParams({ snapshot_id: config.image });

		const body: Record<string, unknown> = {
			metadata: {
				[META.managed]: "true",
				[META.attempt]: config.attemptId,
				[META.session]: config.sessionId,
				[META.sandbox]: config.sandboxId,
			},
		};
		// Only a backstop for an instance Harbor lost track of entirely. Read inline
		// (not a module constant) so a self-hoster can raise it without forking; unset
		// by default because Harbor's own sweep is the primary reaper. `stop` (not
		// `pause`) so an expired backstop reclaims the box the same way an explicit
		// stop does — an ephemeral provider has nothing to resume a paused box into.
		const ttl = this.options.ttlSec ?? Number(process.env.MORPH_INSTANCE_TTL_SEC ?? "0");
		if (ttl > 0) {
			body.ttl_seconds = ttl;
			body.ttl_action = "stop";
		}

		const { status, json } = await this.request(
			"POST",
			`/instance?${params.toString()}`,
			"create",
			body,
		);
		if (status !== 200 && status !== 201) throw this.fail(status, "create", json);

		const instance = json as MorphInstance;
		if (!instance?.id) {
			throw new SandboxProviderError({
				message: "Morph started an instance but returned no id, so it cannot be tracked or reaped.",
				errorType: "unknown",
				provider: PROVIDER_NAME,
				operation: "create",
			});
		}

		return {
			externalId: instance.id,
			provider: PROVIDER_NAME,
			attemptId: config.attemptId,
			state: morphState(instance.status ?? "pending"),
			createdAt: new Date().toISOString(),
		};
	}

	async inspect(externalId: string): Promise<SandboxInspection | null> {
		const { status, json } = await this.request(
			"GET",
			`/instance/${encodeURIComponent(externalId)}`,
			"inspect",
		);
		// 404 is the one status that is an answer rather than an error: Morph replied
		// and there is no such instance. Anything else non-200 is rethrown, because a
		// caller reading `null` concludes the box is gone.
		if (status === 404) return null;
		if (status !== 200) throw this.fail(status, "inspect", json);
		return this.toInspection(json as MorphInstance);
	}

	/**
	 * Reconciliation. `null` means Morph answered and has no instance carrying this
	 * attempt metadata; a call that cannot reach Morph throws, per the authority note
	 * on the base interface — returning `null` on a lost connection starts a second
	 * instance on the same branch.
	 */
	async findByAttemptId(attemptId: string): Promise<SandboxInspection | null> {
		const { status, json } = await this.request(
			"GET",
			`/instance?metadata%5B${META.attempt}%5D=${encodeURIComponent(attemptId)}`,
			"find_by_attempt",
		);
		if (status !== 200) throw this.fail(status, "find_by_attempt", json);

		// Morph honours the metadata filter server-side, but a defensive client-side
		// filter costs nothing and closes the gap if a future API ignores it.
		const instances = this.asInstanceList(json).filter(
			(box) => box.metadata?.[META.attempt] === attemptId,
		);
		if (instances.length === 0) return null;
		if (instances.length > 1) {
			console.warn(
				`[morph] ${instances.length} instances share attempt ${attemptId}: `
					+ `${instances.map((b) => b.id).join(", ")}. Adopting a live one; the rest are orphans `
					+ "and must be stopped.",
			);
		}
		const inspections = instances.map((box) => this.toInspection(box));
		return (
			inspections.find((i) => i.state === "running" || i.state === "starting") ?? inspections[0]!
		);
	}

	async stop(externalId: string, _options?: StopOptions): Promise<StopOutcome> {
		// Ephemeral: stopping reclaims the box entirely.
		const { status, json } = await this.request(
			"DELETE",
			`/instance/${encodeURIComponent(externalId)}`,
			"stop",
		);
		if (status === 404) return "absent";
		if (status === 200 || status === 202 || status === 204) return "stopped";
		// An instance already stopped can report 409/412 or an "already"/"not found"
		// body; treat it as the idempotent already-gone case rather than an error,
		// because stop is called from retrying paths.
		const detail = JSON.stringify(json).toLowerCase();
		if (/already|not found|not running|stopped|terminated/.test(detail)) return "already_stopped";
		throw this.fail(status, "stop", json);
	}

	/**
	 * Every live Harbor-managed instance. Filtered on `harbor_managed` rather than
	 * listing the whole account, because a self-hoster's Morph account may run things
	 * Harbor did not create and every entry here is a stop candidate.
	 *
	 * Fails CLOSED, per the authority note on the interface: a non-200 throws rather
	 * than returning `[]`. An empty list from an unreachable API reads as "no orphans
	 * anywhere", which is exactly the conclusion that lets a stranded instance bill
	 * until someone notices the invoice.
	 *
	 * Live boxes only. A stopped instance is already reclaimed — this provider is
	 * ephemeral, so `stop` destroys — and re-reporting one would have the sweep issue
	 * a stop for a box that no longer exists.
	 */
	async listManaged(): Promise<SandboxInspection[]> {
		const { status, json } = await this.request(
			"GET",
			`/instance?metadata%5B${META.managed}%5D=true`,
			"list_managed",
		);
		if (status !== 200) throw this.fail(status, "list_managed", json);

		return this.asInstanceList(json)
			.filter((box) => box.metadata?.[META.managed] === "true")
			.map((box) => this.toInspection(box))
			.filter((i) => i.state === "running" || i.state === "starting");
	}

	/** Morph may return a bare array or a `{ data: [...] }` / `{ instances: [...] }` envelope. */
	private asInstanceList(json: unknown): MorphInstance[] {
		if (Array.isArray(json)) return json as MorphInstance[];
		if (json && typeof json === "object") {
			const envelope = json as { data?: unknown; instances?: unknown };
			if (Array.isArray(envelope.data)) return envelope.data as MorphInstance[];
			if (Array.isArray(envelope.instances)) return envelope.instances as MorphInstance[];
		}
		return [];
	}

	private toInspection(box: MorphInstance): SandboxInspection {
		const metadata = box.metadata ?? {};
		const raw = box.status ?? "unknown";
		return {
			externalId: box.id ?? "",
			provider: PROVIDER_NAME,
			state: morphState(raw),
			rawState: raw,
			attemptId: metadata[META.attempt] ?? null,
			sessionId: metadata[META.session] ?? null,
			sandboxId: metadata[META.sandbox] ?? null,
			startedAt: box.created ?? box.created_at ?? null,
			exitCode: null,
		};
	}
}

export function morphProvider(options?: MorphProviderOptions): EphemeralProvider {
	return new MorphSandboxProvider(options);
}
