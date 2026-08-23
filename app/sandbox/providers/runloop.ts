// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Runloop — an agent "Devbox" reached over a plain REST control plane.
 *
 * A Runloop Devbox is a managed cloud sandbox booted from a blueprint (or a disk
 * snapshot), created and torn down through one small REST API
 * (`https://api.runloop.ai`). Like Fly and E2B it needs no vendor SDK and no
 * language shim — the whole backend is this one file, injected `fetch` and all —
 * so it plugs into the same spawn-saga, fencing, reconciliation and
 * circuit-breaker machinery `docker` does. Harbor never touches Runloop's exec or
 * file APIs: a Devbox runs its own entrypoint and calls the control plane back
 * over HTTP, exactly as the docker, Fly and E2B boxes do.
 *
 * `kind: "ephemeral"`. Runloop can suspend/resume a Devbox and snapshot its disk,
 * which would make it `persistent` or `snapshot` — but Harbor's rule is *advertise
 * the capability you can honour on a bad day* (see `docs/provider-checklist.md`).
 * A suspended Devbox eventually hits its keep-alive TTL and is reclaimed, and a
 * resume with nothing to resume has nowhere to fall back to, whereas
 * create-and-shutdown always works. Promote to `snapshot`/`persistent` only once
 * that path is proven against the contract suite.
 *
 * Two disciplines carried from the docker/Fly/E2B providers, for the same reasons:
 *   1. **The attempt id is Devbox metadata**, attached at create. Reconciliation
 *      finds an orphan from a lost create response by listing and matching on that
 *      metadata — the property that turns an invisible money-burning box into a
 *      discoverable one.
 *   2. **`findByAttemptId` fails CLOSED.** A list call that cannot reach Runloop
 *      throws `transient` rather than returning `null`, because a caller reading
 *      `null` starts a second box on the same branch.
 *
 * One Runloop-specific wrinkle: its `GET /v1/devboxes` endpoint has **no
 * server-side metadata filter** (it only filters by a single `status`). So both
 * reconciliation reads list the account and filter on `metadata` client-side,
 * which is noted at each call site.
 *
 * Verified here with an injected `fetch` (see `runloop.test.ts`); the shared
 * provider contract suite runs it against real Runloop when `RUNLOOP_API_KEY` is
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

const PROVIDER_NAME = "runloop";

/**
 * Metadata keys, mirroring the docker labels and Fly/E2B metadata one-for-one.
 * `harbor_attempt` is the idempotency key reconciliation matches on; the rest are
 * what a human greps and what a post-mortem joins on. Runloop metadata is a plain
 * string→string map, so the underscore form used by Fly/E2B carries over verbatim.
 */
const META = {
	attempt: "harbor_attempt",
	session: "harbor_session",
	sandbox: "harbor_sandbox",
	managed: "harbor_managed",
} as const;

export interface RunloopProviderOptions {
	/** Injected for tests; defaults to the global. */
	fetch?: typeof fetch;
	/** Defaults to `RUNLOOP_API_KEY`. */
	apiKey?: string;
	/** Defaults to `RUNLOOP_API_HOST` then Runloop's public control plane. */
	apiHost?: string;
	/**
	 * The keep-alive TTL, in seconds, Runloop applies as a backstop before it
	 * reclaims an idle Devbox. Harbor drives its own inactivity sweep, so this is
	 * only a ceiling that reclaims a box Harbor lost track of entirely; defaults to
	 * `RUNLOOP_KEEP_ALIVE_SEC`. Read inline (not a module constant) so a self-hoster
	 * can raise it without forking.
	 */
	keepAliveSec?: number;
}

/** The subset of Runloop's `DevboxView` this provider reads. */
interface RunloopDevbox {
	id?: string;
	status?: string;
	metadata?: Record<string, string>;
	/** Unix epoch milliseconds, per the OpenAPI `create_time_ms`. */
	create_time_ms?: number;
}

/** Runloop's `DevboxListView` envelope. */
interface RunloopDevboxList {
	devboxes?: RunloopDevbox[];
	has_more?: boolean;
	total_count?: number | null;
}

/**
 * Runloop's `DevboxViewStatus` → Harbor's six, as a deny-list overlay.
 *
 * Runloop's full vocabulary is provisioning/initializing/running/suspending/
 * suspended/resuming/failure/shutdown. The shared normaliser already reads
 * `provisioning` as starting and `suspended` as paused, so this only pins the
 * spellings it does not know — `initializing` (a boot phase) and the two terminal
 * states `shutdown` and `failure`, which the normaliser would otherwise leave as
 * `unknown` (i.e. treated as live) and so keep a dead box on the books. Everything
 * else defers to the deny-list, so a status Runloop adds next year becomes
 * `unknown` rather than a wrong guess.
 */
function runloopState(raw: string): ProviderSandboxState {
	const value = raw.trim().toLowerCase();
	if (value === "initializing") return "starting";
	if (value === "shutdown" || value === "failure") return "exited";
	return normalizeProviderState(value);
}

/** HTTP status → the circuit breaker's vocabulary. Mirrors `classifyFlyStatus`. */
function classifyRunloopStatus(status: number): ProviderErrorType {
	if (status === 401 || status === 403) return "unauthorized";
	if (status === 404) return "not_found";
	if (status === 402) return "quota_exceeded";
	if (status === 422 || status === 400) return "invalid_config";
	if (status === 429) return "rate_limited";
	if (status >= 500) return "transient";
	return "unknown";
}

export class RunloopSandboxProvider implements EphemeralProvider {
	readonly name = PROVIDER_NAME;
	readonly kind = "ephemeral" as const;
	readonly capabilities: SandboxCapabilities = {
		// Runloop enforces its own keep-alive TTL, but Harbor drives the inactivity
		// sweep so behaviour matches every other provider; two systems each believing
		// the other reaps the box is how a live agent gets killed mid-turn.
		supportsSandboxTimeout: false,
		// Runloop can snapshot a Devbox's disk and suspend/resume it, but neither path
		// is wired into Harbor's snapshot/resume model; claiming a capability before it
		// works is how a session appears to resume onto an empty workspace.
		supportsSnapshots: false,
		supportsRestore: false,
		supportsPersistentResume: false,
		supportsExplicitStop: true,
		supportsTunnels: false,
	};
	readonly supportedFeatures: readonly string[] = [];

	private readonly fetchImpl: typeof fetch;
	private readonly options: RunloopProviderOptions;

	constructor(options: RunloopProviderOptions = {}) {
		this.options = options;
		this.fetchImpl = options.fetch ?? globalThis.fetch;
	}

	private apiKey(operation: SandboxOperation): string {
		const key = this.options.apiKey ?? process.env.RUNLOOP_API_KEY;
		if (!key) {
			throw new SandboxProviderError({
				message:
					"RUNLOOP_API_KEY is not set. The Runloop provider brokers every Devbox call with a "
					+ "Runloop API key; without one it cannot create, inspect or shut down a box. Create "
					+ "one at https://platform.runloop.ai and set RUNLOOP_API_KEY.",
				errorType: "invalid_config",
				provider: PROVIDER_NAME,
				operation,
			});
		}
		return key;
	}

	private base(): string {
		return (
			this.options.apiHost ?? process.env.RUNLOOP_API_HOST ?? "https://api.runloop.ai"
		).replace(/\/+$/, "");
	}

	/**
	 * One request, one place the auth header and error classification live.
	 *
	 * A transport failure (Runloop unreachable, DNS, timeout) is `transient` and
	 * throws, never a `null` — the authority rule that keeps a network blip from
	 * becoming a second box.
	 */
	private async request(
		method: string,
		path: string,
		operation: SandboxOperation,
		body?: unknown,
	): Promise<{ status: number; json: unknown }> {
		// Resolved before the try: a missing key is an `invalid_config` the operator
		// must fix, and it must not be caught below and re-reported as a `transient`
		// Runloop outage that the circuit breaker would retry forever.
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
				message: `Runloop API unreachable during ${operation}: ${(cause as Error).message}`,
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
			message: `Runloop refused ${operation} (${status}): ${detail}`,
			errorType: classifyRunloopStatus(status),
			provider: PROVIDER_NAME,
			operation,
			detail,
		});
	}

	async create(config: CreateSandboxConfig): Promise<CreatedSandbox> {
		assertFeaturesSupported(this, config, "create");

		const keepAlive =
			this.options.keepAliveSec ?? Number(process.env.RUNLOOP_KEEP_ALIVE_SEC ?? "3600");

		const launchParameters: Record<string, unknown> = {
			keep_alive_time_seconds: keepAlive,
		};
		// Runloop's `entrypoint` is the single main script the Devbox lifecycle binds
		// to; `config.command` is argv. Only override the blueprint's own entrypoint
		// when the caller supplied one — the Harbor sandbox image is built to run with
		// none. Argv is joined because Runloop takes a script string, not a vector.
		const createBody: Record<string, unknown> = {
			// `config.image` is the Runloop blueprint id, per the provider contract.
			// (A disk snapshot would go in `snapshot_id`; not wired here.)
			blueprint_id: config.image,
			// Harbor injects the full clone→agent environment verbatim.
			environment_variables: config.env,
			metadata: {
				[META.managed]: "true",
				[META.attempt]: config.attemptId,
				[META.session]: config.sessionId,
				[META.sandbox]: config.sandboxId,
			},
			launch_parameters: launchParameters,
		};
		if (config.command && config.command.length > 0) {
			createBody.entrypoint = config.command.join(" ");
		}

		const { status, json } = await this.request("POST", "/v1/devboxes", "create", createBody);
		if (status !== 200 && status !== 201) throw this.fail(status, "create", json);

		const box = json as RunloopDevbox;
		if (!box?.id) {
			throw new SandboxProviderError({
				message:
					"Runloop created a Devbox but returned no id, so it cannot be tracked or reaped.",
				errorType: "unknown",
				provider: PROVIDER_NAME,
				operation: "create",
			});
		}

		return {
			externalId: box.id,
			provider: PROVIDER_NAME,
			attemptId: config.attemptId,
			state: runloopState(box.status ?? "provisioning"),
			createdAt: new Date().toISOString(),
		};
	}

	async inspect(externalId: string): Promise<SandboxInspection | null> {
		const { status, json } = await this.request(
			"GET",
			`/v1/devboxes/${encodeURIComponent(externalId)}`,
			"inspect",
		);
		// 404 is the one status that is an answer rather than an error: Runloop replied
		// and there is no such Devbox. Anything else non-200 is rethrown, because a
		// caller reading `null` concludes the box is gone.
		if (status === 404) return null;
		if (status !== 200) throw this.fail(status, "inspect", json);
		return this.toInspection(json as RunloopDevbox);
	}

	/**
	 * Reconciliation. `null` means Runloop answered and has no Devbox carrying this
	 * attempt metadata; a call that cannot reach Runloop throws, per the authority
	 * note on the base interface — returning `null` on a lost connection starts a
	 * second box on the same branch.
	 *
	 * Runloop's list has no server-side metadata filter and only filters by a single
	 * status, so this lists the account and filters on `metadata` client-side. A box
	 * reconciled just after an ambiguous create may still be provisioning, so the
	 * list is deliberately NOT narrowed to `running` — narrowing it would make a
	 * still-booting box read as absent and spawn a duplicate.
	 */
	async findByAttemptId(attemptId: string): Promise<SandboxInspection | null> {
		const boxes = (await this.list("find_by_attempt")).filter(
			(box) => box.metadata?.[META.attempt] === attemptId,
		);
		if (boxes.length === 0) return null;

		if (boxes.length > 1) {
			console.warn(
				`[runloop] ${boxes.length} Devboxes share attempt ${attemptId}: `
					+ `${boxes.map((b) => b.id).join(", ")}. Adopting a live one; the rest are orphans `
					+ "and must be shut down.",
			);
		}
		const inspections = boxes.map((box) => this.toInspection(box));
		return (
			inspections.find((i) => i.state === "running" || i.state === "starting") ?? inspections[0]!
		);
	}

	async stop(externalId: string, _options?: StopOptions): Promise<StopOutcome> {
		// Ephemeral: shutting down reclaims the box entirely.
		const { status, json } = await this.request(
			"POST",
			`/v1/devboxes/${encodeURIComponent(externalId)}/shutdown`,
			"stop",
		);
		if (status === 404) return "absent";
		if (status === 200 || status === 201 || status === 202 || status === 204) return "stopped";
		// A Devbox already shut down reports a 400/409 with a body saying so; treat an
		// "already"/"not running"/"shutdown" body as the idempotent already-gone case
		// rather than an error, because stop is called from retrying paths.
		const detail = JSON.stringify(json).toLowerCase();
		if (/already|not running|not in a valid state|shutdown|shut down|suspended/.test(detail)) {
			return "already_stopped";
		}
		throw this.fail(status, "stop", json);
	}

	/**
	 * Every live Harbor-managed Devbox on the account.
	 *
	 * Filtered on `harbor_managed` rather than reporting the whole account, because a
	 * self-hoster's Runloop account may legitimately run Devboxes Harbor did not
	 * create and every entry returned here is a stop candidate for the orphan sweep.
	 * Docker makes the same choice with `label=harbor.managed=1`.
	 *
	 * Fails CLOSED, per the authority note on the interface: an unreachable list
	 * throws rather than returning `[]`. An empty list from a dead API reads as "no
	 * orphans anywhere", which is exactly the conclusion that lets a stranded Devbox
	 * bill until somebody notices the invoice.
	 *
	 * Live boxes only. A `shutdown` or `failure` Devbox is already reclaimed — this
	 * provider is ephemeral, so `stop` shuts down — and re-reporting one would have
	 * the sweep issue a shutdown for a box that no longer runs.
	 */
	async listManaged(): Promise<SandboxInspection[]> {
		// Same client-side filtering as `findByAttemptId`: Runloop's list has no
		// metadata filter, and narrowing to a single `status` would drop still-booting
		// managed boxes, so fetch broadly and keep the live managed ones.
		return (await this.list("list_managed"))
			.filter((box) => box.metadata?.[META.managed] === "true")
			.map((box) => this.toInspection(box))
			.filter((i) => i.state === "running" || i.state === "starting");
	}

	/**
	 * List Devboxes for the reconciliation reads. Fails CLOSED — any non-200 throws,
	 * never returns `[]`, so an unreachable API cannot masquerade as "nothing here".
	 *
	 * No `status` filter is passed on purpose: Runloop only accepts a single status,
	 * and both callers want live-but-any-phase boxes (provisioning/initializing/
	 * running), which they narrow client-side. `limit` is read inline so a self-hoster
	 * with a large fleet can widen the page without forking.
	 */
	private async list(operation: SandboxOperation): Promise<RunloopDevbox[]> {
		const limit = Number(process.env.RUNLOOP_LIST_LIMIT ?? "100");
		const { status, json } = await this.request(
			"GET",
			`/v1/devboxes?limit=${encodeURIComponent(String(limit))}`,
			operation,
		);
		if (status !== 200) throw this.fail(status, operation, json);

		// A truncated page is not an answer.
		//
		// `has_more` was declared on the response type and read nowhere, so one page
		// was returned as though it were the whole fleet. Both callers are authority
		// operations: `findByAttemptId` concluding "absent" from page one starts a
		// duplicate box on the same branch, and `listManaged` concluding "no orphans"
		// leaves a stranded Devbox billing forever. ADR 0003 says an answer we cannot
		// prove complete is not an answer, so this throws `transient` — the caller
		// retries, and the operator gets a message naming the fix.
		//
		// Throwing rather than following a cursor is deliberate: Runloop's pagination
		// parameter is not something this repository can test against, and a guessed
		// cursor that silently pages wrong is worse than a loud refusal.
		if (this.isTruncated(json)) {
			throw new SandboxProviderError({
				message:
					`Runloop reported more Devboxes than the ${limit}-item page returned, so this `
					+ "result cannot be treated as complete — concluding 'absent' from a partial "
					+ "list would spawn a duplicate box, and concluding 'no orphans' would strand "
					+ "one. Raise RUNLOOP_LIST_LIMIT above your concurrent sandbox count.",
				errorType: "transient",
				provider: PROVIDER_NAME,
				operation,
			});
		}

		return this.asDevboxList(json);
	}

	/** `has_more` on the envelope; a bare array carries no pagination and is complete. */
	private isTruncated(json: unknown): boolean {
		if (!json || typeof json !== "object" || Array.isArray(json)) return false;
		return (json as RunloopDevboxList).has_more === true;
	}

	/** Runloop returns a `{ devboxes: [...] }` envelope; tolerate a bare array too. */
	private asDevboxList(json: unknown): RunloopDevbox[] {
		if (Array.isArray(json)) return json as RunloopDevbox[];
		if (json && typeof json === "object" && Array.isArray((json as RunloopDevboxList).devboxes)) {
			return (json as RunloopDevboxList).devboxes!;
		}
		return [];
	}

	private toInspection(box: RunloopDevbox): SandboxInspection {
		const metadata = box.metadata ?? {};
		const raw = box.status ?? "unknown";
		return {
			externalId: box.id ?? "",
			provider: PROVIDER_NAME,
			state: runloopState(raw),
			rawState: raw,
			attemptId: metadata[META.attempt] ?? null,
			sessionId: metadata[META.session] ?? null,
			sandboxId: metadata[META.sandbox] ?? null,
			startedAt:
				typeof box.create_time_ms === "number"
					? new Date(box.create_time_ms).toISOString()
					: null,
			exitCode: null,
		};
	}
}

export function runloopProvider(options?: RunloopProviderOptions): EphemeralProvider {
	return new RunloopSandboxProvider(options);
}
