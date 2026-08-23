// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Fly Machines — the first remote sandbox backend.
 *
 * A Fly Machine is a hardware-virtualised VM booted from an image, created and
 * destroyed through one small REST API (`https://api.machines.dev`). That makes
 * it the natural first remote provider: a plain REST API needs no vendor SDK and
 * no language shim, so the whole backend is this one file, injected `fetch` and
 * all, and it plugs into the same spawn-saga, fencing, reconciliation and
 * circuit-breaker machinery `docker` does. A backend reachable only through a
 * gRPC SDK in another language would have cost a subprocess or a sidecar first.
 *
 * `kind: "ephemeral"`. A Machine can technically be stopped and started again,
 * which would make it `persistent` — but Harbor's rule is *advertise the capability
 * you can honour on a bad day* (see `docs/provider-checklist.md`). A self-hoster's
 * app can be destroyed, a Machine can be replaced out from under us on a host
 * migration, and a persistent resume with no Machine to resume has nowhere to fall
 * back to. Create-and-destroy always works, so that is what this provider promises.
 *
 * Two disciplines carried from the docker provider, for the same reasons:
 *   1. **The attempt id is Machine metadata**, attached at create. Reconciliation
 *      finds an orphan from a lost create response by listing on that metadata,
 *      exactly as docker greps a label — the property that turns an invisible
 *      money-burning VM into a discoverable one.
 *   2. **`findByAttemptId` fails CLOSED.** A list call that cannot reach Fly throws
 *      `transient` rather than returning `null`, because a caller reading `null`
 *      starts a second VM on the same branch.
 *
 * Verified here with an injected `fetch` (see `fly.test.ts`); the shared provider
 * contract suite runs it against real Fly when `FLY_API_TOKEN` is set and skips
 * loud when it is not, the same bargain the docker suite makes with the daemon.
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

const PROVIDER_NAME = "fly";

/**
 * Machine metadata keys, mirroring the docker labels one-for-one.
 *
 * `harbor_attempt` is the idempotency key reconciliation lists on; the other two
 * are what a human greps for and the join a post-mortem needs. Fly metadata keys
 * may not contain dots, so these use underscores rather than the docker `harbor.`
 * dotted form.
 */
const META = {
	attempt: "harbor_attempt",
	session: "harbor_session",
	sandbox: "harbor_sandbox",
	managed: "harbor_managed",
} as const;

export interface FlyProviderOptions {
	/** Injected for tests; defaults to the global. */
	fetch?: typeof fetch;
	/** Defaults to `FLY_API_TOKEN`. */
	token?: string;
	/** The Fly app the Machines live in. Defaults to `FLY_APP_NAME`. */
	appName?: string;
	/** Defaults to `FLY_API_HOST` then Fly's public endpoint. */
	apiHost?: string;
	/** Where to place Machines. Defaults to `FLY_REGION`, then Fly's default. */
	region?: string;
	/** VM size. Defaults are a small shared VM; overridable via env. */
	guest?: { cpu_kind: string; cpus: number; memory_mb: number };
}

interface FlyMachine {
	id: string;
	state?: string;
	config?: { metadata?: Record<string, string> };
	created_at?: string;
}

/**
 * Fly's Machine states → Harbor's six. Fly says `started`, not `running`, and
 * `stopped`, which the shared normaliser already reads as dead — so this only has
 * to add the two Fly-specific spellings and otherwise defer to the deny-list.
 */
function flyState(raw: string): ProviderSandboxState {
	const value = raw.trim().toLowerCase();
	if (value === "started") return "running";
	if (value === "replacing") return "starting";
	if (value === "destroying" || value === "destroyed") return "gone";
	return normalizeProviderState(value);
}

/** HTTP status / transport failure → the circuit breaker's vocabulary. */
function classifyFlyStatus(status: number): ProviderErrorType {
	if (status === 401 || status === 403) return "unauthorized";
	if (status === 404) return "not_found";
	if (status === 402) return "quota_exceeded";
	if (status === 422 || status === 400) return "invalid_config";
	if (status === 429) return "rate_limited";
	if (status >= 500) return "transient";
	return "unknown";
}

export class FlySandboxProvider implements EphemeralProvider {
	readonly name = PROVIDER_NAME;
	readonly kind = "ephemeral" as const;
	readonly capabilities: SandboxCapabilities = {
		// Fly can auto-destroy a Machine, but Harbor drives the inactivity sweep
		// itself so behaviour matches every other provider; saying `true` here would
		// make two systems each believe the other reaps the box.
		supportsSandboxTimeout: false,
		supportsSnapshots: false,
		supportsRestore: false,
		supportsPersistentResume: false,
		supportsExplicitStop: true,
		// A Fly Machine can publish ports on a public URL, but wiring that into
		// Harbor's tunnel model is not done, and claiming it before it works is how
		// an operator ships a dev server to the public internet by accident.
		supportsTunnels: false,
	};
	// No optional features yet: `network_disabled` and friends map onto Fly config
	// that is not wired, and `assertFeaturesSupported` refuses an unknown one loudly
	// rather than letting an operator believe a box is more constrained than it is.
	readonly supportedFeatures: readonly string[] = [];

	private readonly fetchImpl: typeof fetch;
	private readonly options: FlyProviderOptions;

	constructor(options: FlyProviderOptions = {}) {
		this.options = options;
		this.fetchImpl = options.fetch ?? globalThis.fetch;
	}

	private token(operation: SandboxOperation): string {
		const token = this.options.token ?? process.env.FLY_API_TOKEN;
		if (!token) {
			throw new SandboxProviderError({
				message:
					"FLY_API_TOKEN is not set. The Fly provider brokers every Machine call with a "
					+ "Fly API token; without one it cannot create, inspect or stop a box. Generate "
					+ "one with `fly tokens create deploy` and set FLY_API_TOKEN.",
				errorType: "invalid_config",
				provider: PROVIDER_NAME,
				operation,
			});
		}
		return token;
	}

	private appName(operation: SandboxOperation): string {
		const app = this.options.appName ?? process.env.FLY_APP_NAME;
		if (!app) {
			throw new SandboxProviderError({
				message:
					"FLY_APP_NAME is not set. Fly Machines live inside an app; Harbor needs to know "
					+ "which one to create them in. Create one with `fly apps create` and set FLY_APP_NAME.",
				errorType: "invalid_config",
				provider: PROVIDER_NAME,
				operation,
			});
		}
		return app;
	}

	private base(): string {
		return (this.options.apiHost ?? process.env.FLY_API_HOST ?? "https://api.machines.dev").replace(
			/\/+$/,
			"",
		);
	}

	/**
	 * One request, one place the auth header and the error classification live.
	 *
	 * A transport failure (Fly unreachable, DNS, timeout) is `transient` and throws,
	 * never a `null` — the authority rule that keeps a network blip from becoming a
	 * second VM. `expectAbsent` lets a caller treat 404 as an answer rather than an
	 * error, which is exactly the `inspect`/`stop` "no such box" case.
	 */
	private async request(
		method: string,
		path: string,
		operation: SandboxOperation,
		body?: unknown,
	): Promise<{ status: number; json: unknown }> {
		// Resolved before the try: a missing token or app is an `invalid_config` the
		// operator must fix, and it must not be caught below and re-reported as a
		// `transient` Fly outage that the circuit breaker would retry forever.
		const authToken = this.token(operation);
		const url = `${this.base()}/v1/apps/${encodeURIComponent(this.appName(operation))}${path}`;
		let response: Response;
		try {
			response = await this.fetchImpl(url, {
				method,
				headers: {
					Authorization: `Bearer ${authToken}`,
					"Content-Type": "application/json",
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		} catch (cause) {
			throw new SandboxProviderError({
				message: `Fly API unreachable during ${operation}: ${(cause as Error).message}`,
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

	private fail(
		status: number,
		operation: SandboxOperation,
		json: unknown,
	): SandboxProviderError {
		const detail =
			json && typeof json === "object" && "error" in json
				? String((json as { error: unknown }).error).slice(0, 500)
				: JSON.stringify(json).slice(0, 500);
		return new SandboxProviderError({
			message: `Fly refused ${operation} (${status}): ${detail}`,
			errorType: classifyFlyStatus(status),
			provider: PROVIDER_NAME,
			operation,
			detail,
		});
	}

	async create(config: CreateSandboxConfig): Promise<CreatedSandbox> {
		assertFeaturesSupported(this, config, "create");

		const guest =
			this.options.guest ?? {
				cpu_kind: process.env.FLY_VM_CPU_KIND ?? "shared",
				cpus: Number(process.env.FLY_VM_CPUS ?? "1"),
				memory_mb: Number(process.env.FLY_VM_MEMORY_MB ?? "1024"),
			};

		const machineConfig: Record<string, unknown> = {
			image: config.image,
			env: config.env,
			guest,
			auto_destroy: false,
			// The box must not silently come back after it exits: a restarted Machine
			// would re-run the agent's turn with a stale prompt and a lapsed fence.
			restart: { policy: "no" },
			metadata: {
				[META.managed]: "true",
				[META.attempt]: config.attemptId,
				[META.session]: config.sessionId,
				[META.sandbox]: config.sandboxId,
			},
		};
		// Only override the image's own entrypoint when the caller supplied argv —
		// the Harbor sandbox image is built to run with none.
		if (config.command && config.command.length > 0) {
			machineConfig.init = { cmd: config.command };
		}

		const region = this.options.region ?? process.env.FLY_REGION;
		const { status, json } = await this.request("POST", "/machines", "create", {
			region,
			config: machineConfig,
		});
		if (status !== 200 && status !== 201) throw this.fail(status, "create", json);

		const machine = json as FlyMachine;
		if (!machine?.id) {
			throw new SandboxProviderError({
				message: "Fly created a Machine but returned no id, so it cannot be tracked or reaped.",
				errorType: "unknown",
				provider: PROVIDER_NAME,
				operation: "create",
			});
		}

		return {
			externalId: machine.id,
			provider: PROVIDER_NAME,
			attemptId: config.attemptId,
			state: flyState(machine.state ?? "created"),
			createdAt: new Date().toISOString(),
		};
	}

	async inspect(externalId: string): Promise<SandboxInspection | null> {
		const { status, json } = await this.request(
			"GET",
			`/machines/${encodeURIComponent(externalId)}`,
			"inspect",
		);
		// 404 is the one status that is an answer rather than an error: Fly replied
		// and there is no such Machine. Anything else that is not a 200 is rethrown,
		// because a caller reading `null` concludes the box is gone.
		if (status === 404) return null;
		if (status !== 200) throw this.fail(status, "inspect", json);
		return this.toInspection(json as FlyMachine);
	}

	/**
	 * Reconciliation. `null` means Fly answered and has no Machine carrying this
	 * attempt metadata; a call that cannot reach Fly throws, per the authority note
	 * on the base interface — returning `null` on a lost connection starts a second
	 * VM on the same branch.
	 */
	async findByAttemptId(attemptId: string): Promise<SandboxInspection | null> {
		const { status, json } = await this.request(
			"GET",
			`/machines?metadata.${META.attempt}=${encodeURIComponent(attemptId)}`,
			"find_by_attempt",
		);
		if (status !== 200) throw this.fail(status, "find_by_attempt", json);

		const machines = Array.isArray(json) ? (json as FlyMachine[]) : [];
		// Fly's metadata filter is honoured server-side, but a defensive client-side
		// filter costs nothing and closes the gap if a future API ignores it.
		const matching = machines.filter((m) => m.config?.metadata?.[META.attempt] === attemptId);
		if (matching.length === 0) return null;

		if (matching.length > 1) {
			console.warn(
				`[fly] ${matching.length} Machines share attempt ${attemptId}: `
					+ `${matching.map((m) => m.id).join(", ")}. Adopting a live one; the rest are orphans `
					+ "and must be destroyed.",
			);
		}
		const inspections = matching.map((m) => this.toInspection(m));
		return (
			inspections.find((i) => i.state === "running" || i.state === "starting") ?? inspections[0]!
		);
	}

	async stop(externalId: string, _options?: StopOptions): Promise<StopOutcome> {
		// Ephemeral: stopping reclaims the box entirely. `force` so a Machine wedged
		// mid-boot is still removed rather than left billing.
		const { status, json } = await this.request(
			"DELETE",
			`/machines/${encodeURIComponent(externalId)}?force=true`,
			"stop",
		);
		if (status === 404) return "absent";
		if (status === 200 || status === 202) return "stopped";
		// Some Fly responses report an already-terminal Machine as a 412/409; treat a
		// "already"/"stopped" body as the idempotent already-gone case rather than an
		// error, because stop is called from retrying paths.
		const detail = JSON.stringify(json).toLowerCase();
		if (/already|not in a valid state|destroyed|stopped/.test(detail)) return "already_stopped";
		throw this.fail(status, "stop", json);
	}

	/**
	 * Every live Harbor-managed Machine in the app.
	 *
	 * Filtered on `harbor_managed` rather than listing the whole app, because a
	 * self-hoster's Fly app may legitimately run things Harbor did not create and
	 * every entry returned here is a stop candidate for the orphan sweep. Docker
	 * makes the same choice with `label=harbor.managed=1`.
	 *
	 * Fails CLOSED, per the authority note on the interface: a non-200 throws
	 * rather than returning `[]`. An empty list from an unreachable API reads as
	 * "no orphans anywhere", which is exactly the conclusion that lets a stranded
	 * Machine bill until somebody notices the invoice.
	 *
	 * Live boxes only. A `stopped` or `destroyed` Machine is already reclaimed —
	 * this provider is ephemeral, so `stop` destroys — and re-reporting one would
	 * have the sweep issue a delete for a box that no longer exists.
	 *
	 * The filter value is `"true"` because that is what `create` writes (see the
	 * `metadata` block there). It read `"1"` until this was fixed — copied from the
	 * docker provider's `label=harbor.managed=1`, which is correct for docker and
	 * wrong here — so this method returned `[]` for every Machine Harbor had ever
	 * created, and the orphan sweep silently reaped nothing. The fix is on the READ
	 * side deliberately: Machines stranded by the buggy version are already tagged
	 * `"true"`, so changing `create` to write `"1"` would have made this correct
	 * going forward while leaving every currently-leaking Machine invisible forever.
	 */
	async listManaged(): Promise<SandboxInspection[]> {
		const { status, json } = await this.request(
			"GET",
			`/machines?metadata.${META.managed}=true`,
			"list_managed",
		);
		if (status !== 200) throw this.fail(status, "list_managed", json);

		const machines = Array.isArray(json) ? (json as FlyMachine[]) : [];
		return machines
			// Defensive client-side filter for the same reason as `findByAttemptId`:
			// the server-side metadata filter is honoured today, and this costs nothing
			// if a future API version quietly stops honouring it.
			.filter((machine) => machine.config?.metadata?.[META.managed] === "true")
			.map((machine) => this.toInspection(machine))
			.filter(
				(inspection) => inspection.state === "running" || inspection.state === "starting",
			);
	}

	private toInspection(machine: FlyMachine): SandboxInspection {
		const metadata = machine.config?.metadata ?? {};
		const raw = machine.state ?? "unknown";
		return {
			externalId: machine.id,
			provider: PROVIDER_NAME,
			state: flyState(raw),
			rawState: raw,
			attemptId: metadata[META.attempt] ?? null,
			sessionId: metadata[META.session] ?? null,
			sandboxId: metadata[META.sandbox] ?? null,
			startedAt: machine.created_at ?? null,
			exitCode: null,
		};
	}
}

export function flyProvider(options?: FlyProviderOptions): EphemeralProvider {
	return new FlySandboxProvider(options);
}
