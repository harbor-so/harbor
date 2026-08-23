// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Daytona — a cloud development sandbox reached over a plain REST control plane.
 *
 * Daytona runs sandboxes (containers booted from a "snapshot", its name for a
 * prebuilt image) behind one REST control plane (`https://app.daytona.io/api`).
 * Harbor never touches Daytona's exec/filesystem data plane: a box runs its own
 * entrypoint and calls the Harbor control plane back over HTTP, exactly as the
 * docker, Fly and E2B boxes do. So this provider needs only the REST half, which
 * makes it the same self-contained `fetch`-and-nothing-else shape as `fly.ts` and
 * `e2b.ts` — no `@daytonaio/sdk`, no language shim.
 *
 * **What this provider does NOT do.** It advertises `kind: "ephemeral"`. Daytona
 * genuinely supports stop/start and snapshot/restore, which would make it
 * `persistent` or `snapshot` — but Harbor's rule is *advertise the capability you
 * can honour on a bad day* (see `docs/provider-checklist.md`). A stopped Daytona
 * sandbox can be auto-archived or auto-deleted out from under us by the account's
 * own retention intervals, and a resume with nothing to resume has nowhere to fall
 * back to, whereas create-and-delete always works. Promote to `persistent`/`snapshot`
 * only once that resume path is proven against the contract suite.
 *
 * Two disciplines carried from `fly.ts` / `e2b.ts`, for the same reasons:
 *   1. **The attempt id is a sandbox label**, attached at create. Reconciliation
 *      lists on it to turn a box from a lost create response into a discoverable
 *      one rather than an invisible orphan burning money.
 *   2. **`findByAttemptId` fails CLOSED.** A list call that cannot reach Daytona
 *      throws `transient` rather than returning `null`, because a caller reading
 *      `null` starts a second box on the same branch.
 *
 * Verified here with an injected `fetch` (see `daytona.test.ts`); the shared
 * provider contract suite runs it against real Daytona when `DAYTONA_API_KEY` is
 * set and skips loud when it is not.
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

const PROVIDER_NAME = "daytona";

/**
 * Label keys, mirroring the docker labels and Fly/E2B metadata one-for-one.
 * `harbor_attempt` is the idempotency key reconciliation lists on; the rest are
 * what a human greps and what a post-mortem joins on. Daytona labels are a plain
 * `Record<string, string>`, so underscores (not the docker `harbor.` dotted form).
 */
const LABEL = {
	attempt: "harbor_attempt",
	session: "harbor_session",
	sandbox: "harbor_sandbox",
	managed: "harbor_managed",
} as const;

export interface DaytonaProviderOptions {
	/** Injected for tests; defaults to the global. */
	fetch?: typeof fetch;
	/** Defaults to `DAYTONA_API_KEY`. */
	apiKey?: string;
	/** Defaults to `DAYTONA_API_URL` then Daytona's public control plane. */
	apiUrl?: string;
	/** Target region to place the sandbox in. Defaults to `DAYTONA_TARGET`. */
	target?: string;
	/** Optional org scoping header. Defaults to `DAYTONA_ORGANIZATION_ID`. */
	organizationId?: string;
}

/**
 * A Daytona sandbox, as the REST control plane returns it. Only the fields Harbor
 * reads are typed; the payload carries many more (cpu, memory, runnerId, …).
 */
interface DaytonaSandbox {
	id?: string;
	state?: string;
	labels?: Record<string, string>;
	createdAt?: string;
}

/**
 * Daytona's sandbox states → Harbor's six, as a deny-list that defers to the
 * shared normaliser. Daytona says `started` (not `running`) and has several
 * boot/prep spellings the normaliser does not know; map only those and let
 * `normalizeProviderState` handle `stopped`→exited and anything unrecognised →
 * `unknown` (which liveness treats as live — fail open, per `isLive`).
 *
 * Full backend vocabulary, for reference: creating, restoring, destroyed,
 * destroying, started, stopped, starting, stopping, error, build_failed,
 * pending_build, building_snapshot, unknown, pulling_snapshot, archived,
 * archiving, resizing.
 */
function daytonaState(raw: string): ProviderSandboxState {
	const value = raw.trim().toLowerCase();
	if (value === "started") return "running";
	if (value === "destroyed" || value === "destroying") return "gone";
	// Prep/boot states: not yet running, but emphatically live and not reclaimable.
	if (
		value === "creating"
		|| value === "restoring"
		|| value === "pending_build"
		|| value === "building_snapshot"
		|| value === "pulling_snapshot"
	) {
		return "starting";
	}
	return normalizeProviderState(value);
}

/** HTTP status → the circuit breaker's vocabulary. Mirrors `classifyFlyStatus`. */
function classifyDaytonaStatus(status: number): ProviderErrorType {
	if (status === 401 || status === 403) return "unauthorized";
	if (status === 404) return "not_found";
	if (status === 402) return "quota_exceeded";
	if (status === 422 || status === 400) return "invalid_config";
	if (status === 429) return "rate_limited";
	if (status >= 500) return "transient";
	return "unknown";
}

export class DaytonaSandboxProvider implements EphemeralProvider {
	readonly name = PROVIDER_NAME;
	readonly kind = "ephemeral" as const;
	readonly capabilities: SandboxCapabilities = {
		// Daytona can auto-stop on its own idle interval, but Harbor drives the
		// inactivity sweep so behaviour matches every other provider; two systems
		// each believing the other reaps the box is how a live agent gets killed
		// mid-turn.
		supportsSandboxTimeout: false,
		// Daytona snapshots and stop/start both exist; neither is wired, so neither is
		// advertised — see the header. Claiming a capability before it is proven
		// against the contract suite ships a resume path that silently drops work.
		supportsSnapshots: false,
		supportsRestore: false,
		supportsPersistentResume: false,
		supportsExplicitStop: true,
		// Daytona can expose preview URLs for ports, but wiring that into Harbor's
		// tunnel model is not done, and claiming it before it works is how an operator
		// ships a dev server to the public internet by accident.
		supportsTunnels: false,
	};
	// No optional features yet: `assertFeaturesSupported` refuses an unknown one
	// loudly rather than letting an operator believe a box is more constrained than
	// it is.
	readonly supportedFeatures: readonly string[] = [];

	private readonly fetchImpl: typeof fetch;
	private readonly options: DaytonaProviderOptions;

	constructor(options: DaytonaProviderOptions = {}) {
		this.options = options;
		this.fetchImpl = options.fetch ?? globalThis.fetch;
	}

	private apiKey(operation: SandboxOperation): string {
		const key = this.options.apiKey ?? process.env.DAYTONA_API_KEY;
		if (!key) {
			throw new SandboxProviderError({
				message:
					"DAYTONA_API_KEY is not set. The Daytona provider brokers every sandbox call with a "
					+ "Daytona API key; without one it cannot create, inspect or delete a box. Create one "
					+ "in the dashboard at https://app.daytona.io (Keys) and set DAYTONA_API_KEY.",
				errorType: "invalid_config",
				provider: PROVIDER_NAME,
				operation,
			});
		}
		return key;
	}

	private base(): string {
		return (
			this.options.apiUrl
			?? process.env.DAYTONA_API_URL
			?? "https://app.daytona.io/api"
		).replace(/\/+$/, "");
	}

	/**
	 * One request, one place the auth header and error classification live.
	 *
	 * A transport failure (Daytona unreachable, DNS, timeout) is `transient` and
	 * throws, never a `null` — the authority rule that keeps a network blip from
	 * becoming a second box. The API key is resolved before the try so a missing key
	 * surfaces as `invalid_config` and is not caught here and re-reported as a
	 * `transient` outage the circuit breaker would retry forever.
	 */
	private async request(
		method: string,
		path: string,
		operation: SandboxOperation,
		body?: unknown,
	): Promise<{ status: number; json: unknown }> {
		const key = this.apiKey(operation);
		const url = `${this.base()}${path}`;
		const headers: Record<string, string> = {
			Authorization: `Bearer ${key}`,
			"Content-Type": "application/json",
		};
		const orgId = this.options.organizationId ?? process.env.DAYTONA_ORGANIZATION_ID;
		if (orgId) headers["X-Daytona-Organization-ID"] = orgId;

		let response: Response;
		try {
			response = await this.fetchImpl(url, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		} catch (cause) {
			throw new SandboxProviderError({
				message: `Daytona API unreachable during ${operation}: ${(cause as Error).message}`,
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
			message: `Daytona refused ${operation} (${status}): ${detail}`,
			errorType: classifyDaytonaStatus(status),
			provider: PROVIDER_NAME,
			operation,
			detail,
		});
	}

	async create(config: CreateSandboxConfig): Promise<CreatedSandbox> {
		assertFeaturesSupported(this, config, "create");

		// Harbor drives its own inactivity sweep, so auto-stop is disabled by default
		// (0 = never). Read inline, not a module constant, so a self-hoster can raise
		// it as a backstop for a box Harbor lost track of entirely — exactly as Fly
		// reads its VM size inline.
		const autoStopInterval = Number(process.env.DAYTONA_AUTO_STOP_MINUTES ?? "0");
		const target = this.options.target ?? process.env.DAYTONA_TARGET;

		const { status, json } = await this.request("POST", "/sandbox", "create", {
			// `config.image` is the Daytona snapshot ref, per the provider contract.
			snapshot: config.image,
			// Harbor injects the full clone→agent environment; Daytona runs the
			// snapshot's own start command.
			env: config.env,
			// The single most important line: the attempt id (and friends) become
			// searchable labels AS PART OF create, so a box from a lost create response
			// is discoverable rather than an invisible orphan.
			labels: {
				[LABEL.managed]: "true",
				[LABEL.attempt]: config.attemptId,
				[LABEL.session]: config.sessionId,
				[LABEL.sandbox]: config.sandboxId,
			},
			autoStopInterval,
			...(target ? { target } : {}),
		});
		if (status !== 200 && status !== 201) throw this.fail(status, "create", json);

		const box = json as DaytonaSandbox;
		if (!box?.id) {
			throw new SandboxProviderError({
				message: "Daytona created a sandbox but returned no id, so it cannot be tracked or reaped.",
				errorType: "unknown",
				provider: PROVIDER_NAME,
				operation: "create",
			});
		}

		return {
			externalId: box.id,
			provider: PROVIDER_NAME,
			attemptId: config.attemptId,
			state: daytonaState(box.state ?? "creating"),
			createdAt: new Date().toISOString(),
		};
	}

	async inspect(externalId: string): Promise<SandboxInspection | null> {
		const { status, json } = await this.request(
			"GET",
			`/sandbox/${encodeURIComponent(externalId)}`,
			"inspect",
		);
		// 404 is the one status that is an answer rather than an error: Daytona replied
		// and there is no such sandbox. Anything else non-200 is rethrown, because a
		// caller reading `null` concludes the box is gone.
		if (status === 404) return null;
		if (status !== 200) throw this.fail(status, "inspect", json);
		return this.toInspection(json as DaytonaSandbox);
	}

	/**
	 * Reconciliation. `null` means Daytona answered and has no sandbox carrying this
	 * attempt label; a call that cannot reach Daytona throws, per the authority note
	 * on the base interface — returning `null` on a lost connection starts a second
	 * box on the same branch.
	 */
	async findByAttemptId(attemptId: string): Promise<SandboxInspection | null> {
		const boxes = await this.list("find_by_attempt", { [LABEL.attempt]: attemptId });
		// Server-side label filter is honoured, but a defensive client-side filter
		// costs nothing and closes the gap if a future API ignores it.
		const matching = boxes.filter((box) => box.labels?.[LABEL.attempt] === attemptId);
		if (matching.length === 0) return null;

		if (matching.length > 1) {
			console.warn(
				`[daytona] ${matching.length} sandboxes share attempt ${attemptId}: `
					+ `${matching.map((b) => b.id).join(", ")}. Adopting a live one; the rest are orphans `
					+ "and must be deleted.",
			);
		}
		const inspections = matching.map((box) => this.toInspection(box));
		return (
			inspections.find((i) => i.state === "running" || i.state === "starting") ?? inspections[0]!
		);
	}

	async stop(externalId: string, _options?: StopOptions): Promise<StopOutcome> {
		// Ephemeral: deleting reclaims the box entirely. `force` so a sandbox wedged
		// mid-boot is still removed rather than left billing.
		const { status, json } = await this.request(
			"DELETE",
			`/sandbox/${encodeURIComponent(externalId)}?force=true`,
			"stop",
		);
		if (status === 404) return "absent";
		if (status === 200 || status === 202 || status === 204) return "stopped";
		// A sandbox already destroyed can report 409/400 or a body saying so; treat it
		// as the idempotent already-gone case rather than an error, because stop is
		// called from retrying paths.
		const detail = JSON.stringify(json).toLowerCase();
		if (/already|not found|destroyed|destroying|stopped|invalid state/.test(detail)) {
			return "already_stopped";
		}
		throw this.fail(status, "stop", json);
	}

	/**
	 * Every live Harbor-managed sandbox.
	 *
	 * Filtered on `harbor_managed` rather than listing the whole account, because a
	 * self-hoster's Daytona account may legitimately run things Harbor did not create
	 * and every entry returned here is a stop candidate for the orphan sweep.
	 *
	 * Fails CLOSED, per the authority note on the interface: an unreachable API
	 * throws rather than returning `[]`. An empty list from a dead control plane reads
	 * as "no orphans anywhere", which is exactly the conclusion that lets a stranded
	 * sandbox bill until somebody notices the invoice.
	 *
	 * Live boxes only. A stopped/destroyed sandbox is already reclaimed — this
	 * provider is ephemeral, so `stop` deletes — and re-reporting one would have the
	 * sweep issue a delete for a box that no longer exists.
	 */
	async listManaged(): Promise<SandboxInspection[]> {
		const boxes = await this.list("list_managed", { [LABEL.managed]: "true" });
		return boxes
			.filter((box) => box.labels?.[LABEL.managed] === "true")
			.map((box) => this.toInspection(box))
			.filter((i) => i.state === "running" || i.state === "starting");
	}

	/**
	 * `GET /sandbox?labels=<JSON>` — the shared list path for both reconciliation
	 * calls. Daytona takes the label filter as a JSON-encoded object in a single
	 * query parameter. A non-200 throws (fails closed); the transport failure is
	 * already turned into a `transient` throw by `request`.
	 */
	private async list(
		operation: SandboxOperation,
		labels: Record<string, string>,
	): Promise<DaytonaSandbox[]> {
		const query = encodeURIComponent(JSON.stringify(labels));
		const { status, json } = await this.request("GET", `/sandbox?labels=${query}`, operation);
		if (status !== 200) throw this.fail(status, operation, json);
		if (Array.isArray(json)) return json as DaytonaSandbox[];
		// Daytona has returned both a bare array and a `{ sandboxes: [...] }` envelope
		// across versions; tolerate either.
		if (json && typeof json === "object" && Array.isArray((json as { sandboxes?: unknown }).sandboxes)) {
			return (json as { sandboxes: DaytonaSandbox[] }).sandboxes;
		}
		return [];
	}

	private toInspection(box: DaytonaSandbox): SandboxInspection {
		const labels = box.labels ?? {};
		const raw = box.state ?? "unknown";
		return {
			externalId: box.id ?? "",
			provider: PROVIDER_NAME,
			state: daytonaState(raw),
			rawState: raw,
			attemptId: labels[LABEL.attempt] ?? null,
			sessionId: labels[LABEL.session] ?? null,
			sandboxId: labels[LABEL.sandbox] ?? null,
			startedAt: box.createdAt ?? null,
			exitCode: null,
		};
	}
}

export function daytonaProvider(options?: DaytonaProviderOptions): EphemeralProvider {
	return new DaytonaSandboxProvider(options);
}
