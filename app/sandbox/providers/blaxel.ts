// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Blaxel — persistent micro-VM sandboxes reached over a workspace-scoped REST
 * control plane.
 *
 * Blaxel splits its API the same way E2B does: a REST control plane
 * (`https://api.blaxel.ai/v0`) owns the lifecycle — create, get, delete, list —
 * and each running sandbox exposes its own data plane (process/filesystem REST +
 * MCP) on a per-box `run.blaxel.ai` URL. Harbor never touches the data plane: a
 * box runs its own entrypoint and calls the Harbor control plane back over HTTP,
 * exactly as the docker, Fly and E2B boxes do. So this provider needs only the
 * REST half, which makes it the same self-contained `fetch`-and-nothing-else
 * shape as `e2b.ts` — no `@blaxel/*` SDK, no language shim.
 *
 * Resources are Kubernetes-shaped: `{ metadata: { name, labels }, spec: { runtime:
 * { image } }, status, state }`. The `name` under `metadata` is the sandbox's
 * identity and the path parameter for get/delete, so it is Harbor's `externalId`.
 *
 * `kind: "ephemeral"`. Blaxel markets sandboxes that "persist forever with 25ms
 * resumes" (a STANDBY box keeps its disk and resumes on demand), which would make
 * it `persistent`. Harbor's rule is *advertise the capability you can honour on a
 * bad day* (see `docs/provider-checklist.md`): a resume with nothing to resume has
 * nowhere to fall back to, whereas create-and-delete always works. Promote to
 * `persistent` only once the resume path is proven against the contract suite.
 *
 * Two disciplines carried from `e2b.ts`, for the same reasons:
 *   1. **The attempt id is a sandbox label**, attached at create under
 *      `metadata.labels`. Reconciliation lists on it to turn a box from a lost
 *      create response into a discoverable one rather than an invisible orphan
 *      burning money. Blaxel has no exact server-side `labels.key=value` filter
 *      (only a fuzzy `q` substring search), so the match is done CLIENT-SIDE after
 *      listing — and the attempt id is also encoded in the resource NAME as a
 *      second, human-greppable locator.
 *   2. **`findByAttemptId` fails CLOSED.** A list call that cannot reach Blaxel
 *      throws `transient` rather than returning `null`, because a caller reading
 *      `null` starts a second box on the same branch.
 *
 * Verified here with an injected `fetch` (see `blaxel.test.ts`); the shared
 * provider contract suite runs it against real Blaxel when `BL_API_KEY` is set and
 * skips loud when it is not.
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

const PROVIDER_NAME = "blaxel";

/**
 * Label keys, mirroring the docker labels and Fly/E2B metadata one-for-one.
 * `harbor_attempt` is the idempotency key reconciliation lists on; the rest are
 * what a human greps and what a post-mortem joins on. Blaxel labels are a plain
 * string→string map under `metadata.labels`.
 */
const LABEL = {
	attempt: "harbor_attempt",
	session: "harbor_session",
	sandbox: "harbor_sandbox",
	managed: "harbor_managed",
} as const;

export interface BlaxelProviderOptions {
	/** Injected for tests; defaults to the global. */
	fetch?: typeof fetch;
	/** Defaults to `BL_API_KEY`. */
	apiKey?: string;
	/** The Blaxel workspace resources live in. Defaults to `BL_WORKSPACE`. */
	workspace?: string;
	/** Defaults to `BL_API_HOST` then Blaxel's public control plane. */
	apiHost?: string;
	/** Where to place the sandbox. Defaults to `BL_REGION`, then Blaxel's default. */
	region?: string;
	/**
	 * The auto-reclaim TTL (a Blaxel duration string like `24h`) Blaxel applies as
	 * a backstop. Harbor drives its own inactivity sweep, so this is only a ceiling
	 * that reclaims a box Harbor lost track of entirely; defaults to
	 * `BL_SANDBOX_TTL`. Read inline (not a module constant) so a self-hoster can
	 * raise it without forking.
	 */
	ttl?: string;
}

/** The Kubernetes-shaped sandbox resource, trimmed to the fields Harbor reads. */
interface BlaxelSandbox {
	metadata?: {
		name?: string;
		labels?: Record<string, string>;
		createdAt?: string;
	};
	/** Deployment lifecycle: DEPLOYED / DEPLOYING / DELETING / FAILED / TERMINATED / … */
	status?: string;
	/** Runtime state, a sibling of `status`: RUNNING / STANDBY. */
	state?: string;
}

/**
 * Blaxel's status/state vocabulary → Harbor's six, as a deny-list that only names
 * the spellings we KNOW and otherwise defers to `normalizeProviderState`. Blaxel
 * has two read-only fields — `status` (the deployment lifecycle, the richer one)
 * and `state` (RUNNING/STANDBY) — and both flow through here.
 */
function blaxelState(raw: string): ProviderSandboxState {
	const value = raw.trim().toLowerCase();
	if (value === "deployed") return "running";
	if (value === "deploying" || value === "building" || value === "built" || value === "uploading") {
		return "starting";
	}
	if (value === "deleting") return "gone";
	if (value === "failed" || value === "terminated") return "exited";
	// `running`/`standby` and anything Blaxel adds later fall through to the shared
	// deny-list; an unrecognised state becomes `unknown`, which is treated as live.
	return normalizeProviderState(value);
}

/** HTTP status → the circuit breaker's vocabulary. Mirrors `classifyE2BStatus`. */
function classifyBlaxelStatus(status: number): ProviderErrorType {
	if (status === 401 || status === 403) return "unauthorized";
	if (status === 404) return "not_found";
	if (status === 402) return "quota_exceeded";
	if (status === 422 || status === 400) return "invalid_config";
	if (status === 429) return "rate_limited";
	if (status >= 500) return "transient";
	return "unknown";
}

export class BlaxelSandboxProvider implements EphemeralProvider {
	readonly name = PROVIDER_NAME;
	readonly kind = "ephemeral" as const;
	readonly capabilities: SandboxCapabilities = {
		// Blaxel can auto-reclaim on its own TTL, but Harbor drives the inactivity
		// sweep so behaviour matches every other provider; two systems each believing
		// the other reaps the box is how a live agent gets killed mid-turn.
		supportsSandboxTimeout: false,
		supportsSnapshots: false,
		supportsRestore: false,
		// Blaxel STANDBY/resume exists; not wired, so not advertised — see the header.
		supportsPersistentResume: false,
		supportsExplicitStop: true,
		// A Blaxel sandbox publishes ports on a public `run.blaxel.ai` URL, but wiring
		// that into Harbor's tunnel model is not done, and claiming it before it works
		// is how an operator ships a dev server to the public internet by accident.
		supportsTunnels: false,
	};
	readonly supportedFeatures: readonly string[] = [];

	private readonly fetchImpl: typeof fetch;
	private readonly options: BlaxelProviderOptions;

	constructor(options: BlaxelProviderOptions = {}) {
		this.options = options;
		this.fetchImpl = options.fetch ?? globalThis.fetch;
	}

	private apiKey(operation: SandboxOperation): string {
		const key = this.options.apiKey ?? process.env.BL_API_KEY;
		if (!key) {
			throw new SandboxProviderError({
				message:
					"BL_API_KEY is not set. The Blaxel provider brokers every sandbox call with a "
					+ "Blaxel API key; without one it cannot create, inspect or delete a box. Create one "
					+ "in your Blaxel workspace settings (Access tokens) and set BL_API_KEY.",
				errorType: "invalid_config",
				provider: PROVIDER_NAME,
				operation,
			});
		}
		return key;
	}

	private workspace(operation: SandboxOperation): string {
		const workspace = this.options.workspace ?? process.env.BL_WORKSPACE;
		if (!workspace) {
			throw new SandboxProviderError({
				message:
					"BL_WORKSPACE is not set. Blaxel is workspace-scoped and every control-plane call "
					+ "is resolved against one workspace; Harbor needs to know which. Find it in the "
					+ "Blaxel console URL or run `bl workspaces`, and set BL_WORKSPACE.",
				errorType: "invalid_config",
				provider: PROVIDER_NAME,
				operation,
			});
		}
		return workspace;
	}

	private base(): string {
		return (
			this.options.apiHost ?? process.env.BL_API_HOST ?? "https://api.blaxel.ai/v0"
		).replace(/\/+$/, "");
	}

	/**
	 * One request, one place the auth headers and error classification live.
	 *
	 * A transport failure (Blaxel unreachable, DNS, timeout) is `transient` and
	 * throws, never a `null` — the authority rule that keeps a network blip from
	 * becoming a second box. The workspace is sent as a header because Blaxel scopes
	 * every resource to a workspace and a key with access to several must say which.
	 */
	private async request(
		method: string,
		path: string,
		operation: SandboxOperation,
		body?: unknown,
	): Promise<{ status: number; json: unknown }> {
		// Resolved before the try: a missing key or workspace is an `invalid_config`
		// the operator must fix, and it must not be caught below and re-reported as a
		// `transient` Blaxel outage the circuit breaker would retry forever.
		const key = this.apiKey(operation);
		const workspace = this.workspace(operation);
		const url = `${this.base()}${path}`;
		let response: Response;
		try {
			response = await this.fetchImpl(url, {
				method,
				headers: {
					Authorization: `Bearer ${key}`,
					"X-Blaxel-Workspace": workspace,
					"Content-Type": "application/json",
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		} catch (cause) {
			throw new SandboxProviderError({
				message: `Blaxel API unreachable during ${operation}: ${(cause as Error).message}`,
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
			message: `Blaxel refused ${operation} (${status}): ${detail}`,
			errorType: classifyBlaxelStatus(status),
			provider: PROVIDER_NAME,
			operation,
			detail,
		});
	}

	/**
	 * A Blaxel-legal sandbox name that also encodes the attempt id.
	 *
	 * Blaxel names are lowercase alphanumeric + hyphens, must start/end
	 * alphanumeric, and are capped (49 chars). The attempt id is the primary locator
	 * via `metadata.labels`, but encoding it in the name too gives reconciliation a
	 * human-greppable `harbor-<attempt>` handle — the same fallback the checklist
	 * prescribes for backends with weak metadata search, which Blaxel is (no exact
	 * label filter).
	 */
	private sandboxName(config: CreateSandboxConfig): string {
		const slug = config.attemptId
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "");
		return `harbor-${slug}`.slice(0, 49).replace(/-+$/g, "");
	}

	async create(config: CreateSandboxConfig): Promise<CreatedSandbox> {
		assertFeaturesSupported(this, config, "create");

		// Provider-specific knobs read inline from the environment (never a module
		// constant), exactly like Fly's guest sizing, so a self-hoster can retune them
		// without forking. `ttl` is a Blaxel duration string; it is a backstop ceiling
		// only, per the capabilities note above.
		const memory = Number(process.env.BL_SANDBOX_MEMORY_MB ?? "4096");
		const ttl = this.options.ttl ?? process.env.BL_SANDBOX_TTL ?? "24h";
		const region = this.options.region ?? process.env.BL_REGION;

		const runtime: Record<string, unknown> = {
			// `config.image` is the Blaxel sandbox image, per the provider contract. It
			// lives under `spec.runtime.image` — NOT the top-level `spec.image` the
			// simplified Templates doc shows.
			image: config.image,
			memory,
			ttl,
			// Harbor injects the full clone→agent environment; Blaxel takes it as a list
			// of name/value pairs.
			envs: Object.entries(config.env).map(([name, value]) => ({ name, value })),
		};

		const { status, json } = await this.request("POST", "/sandboxes", "create", {
			metadata: {
				name: this.sandboxName(config),
				// The attempt id is a searchable label attached AS PART OF create — the
				// single line that makes a box from a lost create response discoverable.
				labels: {
					[LABEL.managed]: "true",
					[LABEL.attempt]: config.attemptId,
					[LABEL.session]: config.sessionId,
					[LABEL.sandbox]: config.sandboxId,
				},
			},
			spec: {
				...(region ? { region } : {}),
				runtime,
			},
		});
		if (status !== 200 && status !== 201 && status !== 202) throw this.fail(status, "create", json);

		const box = json as BlaxelSandbox;
		const id = box.metadata?.name;
		if (!id) {
			throw new SandboxProviderError({
				message:
					"Blaxel created a sandbox but returned no metadata.name, so it cannot be tracked or reaped.",
				errorType: "unknown",
				provider: PROVIDER_NAME,
				operation: "create",
			});
		}

		return {
			externalId: id,
			provider: PROVIDER_NAME,
			attemptId: config.attemptId,
			state: blaxelState(box.status ?? box.state ?? "DEPLOYING"),
			createdAt: new Date().toISOString(),
		};
	}

	async inspect(externalId: string): Promise<SandboxInspection | null> {
		const { status, json } = await this.request(
			"GET",
			`/sandboxes/${encodeURIComponent(externalId)}`,
			"inspect",
		);
		// 404 is the one status that is an answer rather than an error: Blaxel replied
		// and has no such sandbox. Anything else non-200 is rethrown, because a caller
		// reading `null` concludes the box is gone.
		if (status === 404) return null;
		if (status !== 200) throw this.fail(status, "inspect", json);
		return this.toInspection(json as BlaxelSandbox);
	}

	/**
	 * Reconciliation. `null` means Blaxel answered and has no sandbox carrying this
	 * attempt label; a call that cannot reach Blaxel throws, per the authority note
	 * on the base interface — returning `null` on a lost connection starts a second
	 * box on the same branch.
	 *
	 * Blaxel has no exact server-side label filter, so this lists and matches
	 * client-side. The filter must be exact (a label equality), never Blaxel's fuzzy
	 * `q` substring search: a `q` false-negative would drop a real match and, for
	 * authority, dropping a match is the dangerous direction.
	 */
	async findByAttemptId(attemptId: string): Promise<SandboxInspection | null> {
		const { status, json } = await this.request("GET", "/sandboxes?limit=200", "find_by_attempt");
		if (status !== 200) throw this.fail(status, "find_by_attempt", json);

		const boxes = this.asSandboxList(json).filter(
			(box) => box.metadata?.labels?.[LABEL.attempt] === attemptId,
		);
		if (boxes.length === 0) return null;
		if (boxes.length > 1) {
			console.warn(
				`[blaxel] ${boxes.length} sandboxes share attempt ${attemptId}: `
					+ `${boxes.map((b) => b.metadata?.name).join(", ")}. Adopting a live one; the rest are `
					+ "orphans and must be deleted.",
			);
		}
		const inspections = boxes.map((box) => this.toInspection(box));
		return (
			inspections.find((i) => i.state === "running" || i.state === "starting") ?? inspections[0]!
		);
	}

	async stop(externalId: string, _options?: StopOptions): Promise<StopOutcome> {
		// Ephemeral: deleting reclaims the box entirely.
		const { status, json } = await this.request(
			"DELETE",
			`/sandboxes/${encodeURIComponent(externalId)}`,
			"stop",
		);
		if (status === 404) return "absent";
		if (status === 200 || status === 202 || status === 204) return "stopped";
		// A box already deleting/terminated can report 409/412 or an "already"/"not
		// found" body; treat it as the idempotent already-gone case rather than an
		// error, because stop is called from retrying paths.
		const detail = JSON.stringify(json).toLowerCase();
		if (/already|not found|deleting|terminated|deactivat/.test(detail)) return "already_stopped";
		throw this.fail(status, "stop", json);
	}

	/**
	 * Every live Harbor-managed sandbox in the workspace. Filtered on
	 * `harbor_managed` rather than listing the whole workspace, because a
	 * self-hoster's Blaxel workspace may run things Harbor did not create and every
	 * entry here is a stop candidate.
	 *
	 * Fails CLOSED: a non-200 throws rather than returning `[]`. An empty list from
	 * an unreachable API reads as "no orphans anywhere", which is exactly the
	 * conclusion that lets a stranded box bill until someone notices the invoice.
	 *
	 * Live boxes only. A deleted/terminated sandbox is already reclaimed — this
	 * provider is ephemeral, so `stop` deletes — and re-reporting one would have the
	 * sweep issue a delete for a box that no longer exists.
	 */
	async listManaged(): Promise<SandboxInspection[]> {
		const { status, json } = await this.request("GET", "/sandboxes?limit=200", "list_managed");
		if (status !== 200) throw this.fail(status, "list_managed", json);

		return this.asSandboxList(json)
			.filter((box) => box.metadata?.labels?.[LABEL.managed] === "true")
			.map((box) => this.toInspection(box))
			.filter((i) => i.state === "running" || i.state === "starting");
	}

	/**
	 * Blaxel's list endpoint may return a bare array or a paginated envelope. Handle
	 * the shapes it is known to use so a schema tweak does not silently empty the
	 * orphan sweep.
	 */
	private asSandboxList(json: unknown): BlaxelSandbox[] {
		if (Array.isArray(json)) return json as BlaxelSandbox[];
		if (json && typeof json === "object") {
			for (const key of ["sandboxes", "data", "items"] as const) {
				const value = (json as Record<string, unknown>)[key];
				if (Array.isArray(value)) return value as BlaxelSandbox[];
			}
		}
		return [];
	}

	private toInspection(box: BlaxelSandbox): SandboxInspection {
		const labels = box.metadata?.labels ?? {};
		// `status` is the richer deployment lifecycle; fall back to the RUNNING/STANDBY
		// `state`, then to `unknown` (which reads as live).
		const raw = box.status ?? box.state ?? "unknown";
		return {
			externalId: box.metadata?.name ?? "",
			provider: PROVIDER_NAME,
			state: blaxelState(raw),
			rawState: raw,
			attemptId: labels[LABEL.attempt] ?? null,
			sessionId: labels[LABEL.session] ?? null,
			sandboxId: labels[LABEL.sandbox] ?? null,
			startedAt: box.metadata?.createdAt ?? null,
			exitCode: null,
		};
	}
}

export function blaxelProvider(options?: BlaxelProviderOptions): EphemeralProvider {
	return new BlaxelSandboxProvider(options);
}
