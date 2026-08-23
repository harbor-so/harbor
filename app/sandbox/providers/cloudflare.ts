// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Cloudflare Sandbox, reached through Harbor's Worker shim.
 *
 * Cloudflare Sandbox is not a remote REST backend like Fly or E2B: its
 * `@cloudflare/sandbox` runtime is a Durable Object fronting a Container, and it
 * can only be driven from *inside* a Worker via `getSandbox(env.Sandbox, id)`.
 * Harbor's control plane is an external Node process, so it cannot call that
 * binding directly, and Durable Objects are not enumerable — there is no
 * "list all sandboxes" for reconciliation to use.
 *
 * So Harbor ships a small deployable Worker (see
 * `integrations/cloudflare-sandbox-worker/`) that exposes the four lifecycle
 * operations over HTTP and keeps a KV-backed registry so the boxes it created can
 * be enumerated. THIS file is the other half: an ordinary injected-`fetch` client
 * pointed at that Worker, identical in shape to `fly.ts`. All the Durable-Object
 * and Container machinery lives behind the Worker's HTTP API; from Harbor's side
 * Cloudflare looks like any other remote provider.
 *
 * `kind: "ephemeral"`. A stopped box is gone; the shim destroys the Durable
 * Object on stop and there is no resume.
 *
 * Two disciplines carried from `fly.ts`:
 *   1. **The attempt id is sandbox metadata.** The shim stamps it as a Durable
 *      Object label AND records it in KV at create, so a box from a lost create
 *      response is discoverable by `findByAttemptId`. (The KV index is the shim's
 *      answer to DOs not being listable — see its README for the caveat.)
 *   2. **`findByAttemptId`/`listManaged` fail CLOSED.** The shim returns 5xx on a
 *      KV/DO failure, and this client turns any non-2xx list response into a
 *      thrown `transient` rather than an empty answer.
 *
 * Verified here with an injected `fetch` (see `cloudflare.test.ts`).
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

const PROVIDER_NAME = "cloudflare";

export interface CloudflareProviderOptions {
	/** Injected for tests; defaults to the global. */
	fetch?: typeof fetch;
	/** The deployed shim Worker's base URL. Defaults to `CLOUDFLARE_SANDBOX_WORKER_URL`. */
	workerUrl?: string;
	/** Shared bearer token the shim checks. Defaults to `CLOUDFLARE_SANDBOX_WORKER_TOKEN`. */
	workerToken?: string;
}

/** The shim's inspection shape (see the Worker's `inspectionFrom`). */
interface ShimInspection {
	externalId: string;
	state: string;
	attemptId: string | null;
	sessionId: string | null;
	sandboxId: string | null;
	createdAt: string | null;
}

/** The shim already normalises to Harbor's own state words; defer for anything new. */
function cloudflareState(raw: string): ProviderSandboxState {
	return normalizeProviderState(raw);
}

/** HTTP status → the circuit breaker's vocabulary. Mirrors `classifyFlyStatus`. */
function classifyCloudflareStatus(status: number): ProviderErrorType {
	if (status === 401 || status === 403) return "unauthorized";
	if (status === 404) return "not_found";
	if (status === 402) return "quota_exceeded";
	if (status === 422 || status === 400) return "invalid_config";
	if (status === 429) return "rate_limited";
	if (status >= 500) return "transient";
	return "unknown";
}

export class CloudflareSandboxProvider implements EphemeralProvider {
	readonly name = PROVIDER_NAME;
	readonly kind = "ephemeral" as const;
	readonly capabilities: SandboxCapabilities = {
		supportsSandboxTimeout: false,
		supportsSnapshots: false,
		supportsRestore: false,
		supportsPersistentResume: false,
		supportsExplicitStop: true,
		supportsTunnels: false,
	};
	readonly supportedFeatures: readonly string[] = [];

	private readonly fetchImpl: typeof fetch;
	private readonly options: CloudflareProviderOptions;

	constructor(options: CloudflareProviderOptions = {}) {
		this.options = options;
		this.fetchImpl = options.fetch ?? globalThis.fetch;
	}

	private workerUrl(operation: SandboxOperation): string {
		const url = this.options.workerUrl ?? process.env.CLOUDFLARE_SANDBOX_WORKER_URL;
		if (!url) {
			throw new SandboxProviderError({
				message:
					"CLOUDFLARE_SANDBOX_WORKER_URL is not set. The Cloudflare provider talks to a Worker "
					+ "shim (integrations/cloudflare-sandbox-worker) that drives the Sandbox Durable "
					+ "Object; deploy it with `wrangler deploy` and set CLOUDFLARE_SANDBOX_WORKER_URL to "
					+ "its URL.",
				errorType: "invalid_config",
				provider: PROVIDER_NAME,
				operation,
			});
		}
		return url.replace(/\/+$/, "");
	}

	private workerToken(operation: SandboxOperation): string {
		const token = this.options.workerToken ?? process.env.CLOUDFLARE_SANDBOX_WORKER_TOKEN;
		if (!token) {
			throw new SandboxProviderError({
				message:
					"CLOUDFLARE_SANDBOX_WORKER_TOKEN is not set. It must match the AUTH_TOKEN secret set "
					+ "on the Worker shim with `wrangler secret put AUTH_TOKEN`.",
				errorType: "invalid_config",
				provider: PROVIDER_NAME,
				operation,
			});
		}
		return token;
	}

	private async request(
		method: string,
		path: string,
		operation: SandboxOperation,
		body?: unknown,
	): Promise<{ status: number; json: unknown }> {
		const token = this.workerToken(operation);
		const url = `${this.workerUrl(operation)}${path}`;
		let response: Response;
		try {
			response = await this.fetchImpl(url, {
				method,
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		} catch (cause) {
			throw new SandboxProviderError({
				message: `Cloudflare sandbox shim unreachable during ${operation}: ${(cause as Error).message}`,
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
			json && typeof json === "object" && "error" in json
				? String((json as { error: unknown }).error).slice(0, 500)
				: JSON.stringify(json).slice(0, 500);
		return new SandboxProviderError({
			message: `Cloudflare sandbox shim refused ${operation} (${status}): ${detail}`,
			errorType: classifyCloudflareStatus(status),
			provider: PROVIDER_NAME,
			operation,
			detail,
		});
	}

	async create(config: CreateSandboxConfig): Promise<CreatedSandbox> {
		assertFeaturesSupported(this, config, "create");

		const { status, json } = await this.request("POST", "/sandboxes", "create", {
			sandboxId: config.sandboxId,
			attemptId: config.attemptId,
			sessionId: config.sessionId,
			// Informational: the shim's container image is fixed at deploy time.
			image: config.image,
			env: config.env,
			...(config.command && config.command.length > 0 ? { command: config.command } : {}),
		});
		if (status !== 200 && status !== 201) throw this.fail(status, "create", json);

		const box = json as ShimInspection;
		if (!box?.externalId) {
			throw new SandboxProviderError({
				message: "Cloudflare shim created a sandbox but returned no externalId, so it cannot be tracked.",
				errorType: "unknown",
				provider: PROVIDER_NAME,
				operation: "create",
			});
		}
		return {
			externalId: box.externalId,
			provider: PROVIDER_NAME,
			attemptId: config.attemptId,
			state: cloudflareState(box.state ?? "starting"),
			createdAt: new Date().toISOString(),
		};
	}

	async inspect(externalId: string): Promise<SandboxInspection | null> {
		const { status, json } = await this.request(
			"GET",
			`/sandboxes/${encodeURIComponent(externalId)}`,
			"inspect",
		);
		if (status === 404) return null;
		if (status !== 200) throw this.fail(status, "inspect", json);
		return this.toInspection(json as ShimInspection);
	}

	async findByAttemptId(attemptId: string): Promise<SandboxInspection | null> {
		const { status, json } = await this.request(
			"GET",
			`/sandboxes?attempt=${encodeURIComponent(attemptId)}`,
			"find_by_attempt",
		);
		if (status !== 200) throw this.fail(status, "find_by_attempt", json);
		const sandbox = (json as { sandbox: ShimInspection | null }).sandbox;
		return sandbox ? this.toInspection(sandbox) : null;
	}

	async stop(externalId: string, _options?: StopOptions): Promise<StopOutcome> {
		const { status, json } = await this.request(
			"DELETE",
			`/sandboxes/${encodeURIComponent(externalId)}`,
			"stop",
		);
		if (status === 404) return "absent";
		if (status !== 200 && status !== 202) throw this.fail(status, "stop", json);
		const outcome = (json as { outcome?: string }).outcome;
		if (outcome === "absent") return "absent";
		if (outcome === "already_stopped") return "already_stopped";
		return "stopped";
	}

	async listManaged(): Promise<SandboxInspection[]> {
		const { status, json } = await this.request(
			"GET",
			"/sandboxes?managed=true",
			"list_managed",
		);
		if (status !== 200) throw this.fail(status, "list_managed", json);
		const sandboxes = (json as { sandboxes?: ShimInspection[] }).sandboxes ?? [];
		return sandboxes
			.map((box) => this.toInspection(box))
			.filter((i) => i.state === "running" || i.state === "starting");
	}

	private toInspection(box: ShimInspection): SandboxInspection {
		const raw = box.state ?? "unknown";
		return {
			externalId: box.externalId,
			provider: PROVIDER_NAME,
			state: cloudflareState(raw),
			rawState: raw,
			attemptId: box.attemptId ?? null,
			sessionId: box.sessionId ?? null,
			sandboxId: box.sandboxId ?? null,
			startedAt: box.createdAt ?? null,
			exitCode: null,
		};
	}
}

export function cloudflareProvider(options?: CloudflareProviderOptions): EphemeralProvider {
	return new CloudflareSandboxProvider(options);
}
