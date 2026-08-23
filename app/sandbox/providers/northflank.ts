// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Northflank — a Harbor sandbox mapped onto a **deployment service** inside a
 * Northflank project, reached over a plain REST control plane
 * (`https://api.northflank.com`, injected `fetch`, no vendor SDK). Same
 * self-contained shape as `fly.ts` and `e2b.ts`.
 *
 * `kind: "ephemeral"`. Northflank has no ephemeral "sandbox" primitive at all —
 * the closest durable thing is a long-lived deployment service running an
 * external container image, so `create` spins one up and `stop` deletes it.
 * There is no pause/resume and no snapshot; a stopped box is gone.
 *
 * WHAT THIS PROVIDER DOES NOT DO (read this before trusting reconciliation):
 *
 *   - **No server-side metadata search.** Northflank services carry no free-form,
 *     queryable label/tag map the way Fly (`metadata.*`) or E2B (`metadata=`) do.
 *     So `findByAttemptId`/`listManaged` cannot ask the backend "give me the
 *     service for attempt X". They **list every service in the project and filter
 *     client-side** by the `harbor-` name prefix. On a project that also runs
 *     non-Harbor services this is still safe (the prefix excludes them), but it is
 *     O(all services) per reconciliation pass, not an indexed lookup.
 *
 *   - **The attempt id lives in the resource NAME and DESCRIPTION, not a tag.**
 *     Northflank service names are constrained (3–54 chars, must start with a
 *     letter, only letters/digits/single hyphens — see `serviceName`). A Harbor
 *     attempt id can be longer or contain characters that pattern forbids, so the
 *     name is a *sanitised + truncated* form `harbor-<slug>` and is therefore
 *     **lossy**: two attempt ids can collide on the same service name. To
 *     disambiguate, the create call ALSO stamps the FULL, unmodified attempt id
 *     into the service's free-text `description` field (Northflank allows 200
 *     chars), and that is the field `findByAttemptId` matches on exactly. The name
 *     prefix is only the coarse "is this one of ours" marker; the description is
 *     the authority. If a future Northflank API stops returning `description` on
 *     list entries, matching degrades to the lossy name and the collision risk
 *     above becomes real — that is the single documented weakness of this scheme.
 *
 *   - **First page only, bounded.** Service listing is cursor-paginated; this
 *     provider follows the cursor up to `NORTHFLANK_LIST_MAX_PAGES` pages so a
 *     project with hundreds of services still reconciles, but a project larger
 *     than that ceiling can hide an orphan past the last page. Raise the ceiling
 *     via env if you run at that scale.
 *
 * Two disciplines carried from `fly.ts`/`e2b.ts`, for the same reasons:
 *   1. **The attempt id is stamped at create** (name + description), so a service
 *      created by a call whose response we never received is discoverable rather
 *      than an invisible orphan burning money.
 *   2. **`findByAttemptId` and `listManaged` fail CLOSED.** A list call that
 *      cannot reach Northflank throws `transient` rather than returning
 *      `null`/`[]`, because a caller reading "nothing" starts a second box on the
 *      same branch.
 *
 * Verified here with an injected `fetch` (see `northflank.test.ts`); the shared
 * provider contract suite runs it against real Northflank when
 * `NORTHFLANK_API_TOKEN` and `NORTHFLANK_PROJECT_ID` are set.
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

const PROVIDER_NAME = "northflank";

/**
 * The coarse marker that a service is Harbor's: its name starts with this.
 * Every Harbor service is named `harbor-<slug-of-attempt-id>` (see `serviceName`).
 */
const NAME_PREFIX = "harbor-";

export interface NorthflankProviderOptions {
	/** Injected for tests; defaults to the global. */
	fetch?: typeof fetch;
	/** Defaults to `NORTHFLANK_API_TOKEN`. */
	token?: string;
	/** The Northflank project the services live in. Defaults to `NORTHFLANK_PROJECT_ID`. */
	projectId?: string;
	/** Defaults to `NORTHFLANK_API_HOST` then Northflank's public endpoint. */
	apiHost?: string;
	/**
	 * The compute plan id every service is created on. Northflank requires a plan;
	 * defaults to `NORTHFLANK_DEPLOYMENT_PLAN`. Read inline (not a module constant)
	 * so a self-hoster can size the box without forking. List valid ids with
	 * `GET /v1/plans`.
	 */
	deploymentPlan?: string;
	/** How many instances of the service to run. Defaults to `NORTHFLANK_INSTANCES`, then 1. */
	instances?: number;
}

/** The subset of a Northflank service object this provider reads. */
interface NorthflankService {
	id?: string;
	name?: string;
	description?: string;
	tags?: string[];
	createdAt?: string;
	status?: {
		build?: { status?: string; lastTransitionTime?: string };
		deployment?: { status?: string; reason?: string; lastTransitionTime?: string };
	};
}

/**
 * Northflank's deployment/build status vocabulary → Harbor's six, as a deny-list
 * over the spellings we know, deferring the rest to `normalizeProviderState`.
 *
 * Northflank reports UPPERCASE status enums under `status.deployment.status` (and
 * `status.build.status` for services that build). `COMPLETED` is a settled,
 * running deployment; the in-flight build/deploy states map to `starting`; the
 * terminal failure states map to `exited`. The generic `running`/`active` /
 * `deploying`/`building` / `stopped`/`failed` spellings are handled too, so this
 * survives Northflank renaming an enum without silently reclassifying a live box
 * as dead — `normalizeProviderState` catches the unknowns as `unknown` (live).
 */
function northflankState(raw: string): ProviderSandboxState {
	const value = raw.trim().toLowerCase();
	// A deployment that has settled is running; a finished build is likewise "up".
	if (value === "completed" || value === "success") return "running";
	// In-flight build/deploy phases → still coming up.
	if (
		[
			"in_progress",
			"deploying",
			"building",
			"cloning",
			"uploading",
			"submitting",
			"queued",
			"scheduling",
		].includes(value)
	) {
		return "starting";
	}
	// Terminal failures → the box is not coming back on its own.
	if (
		["failure", "failed", "submission_failure", "crashed", "aborted", "unschedulable"].includes(
			value,
		)
	) {
		return "exited";
	}
	return normalizeProviderState(value);
}

/** HTTP status → the circuit breaker's vocabulary. Mirrors `classifyFlyStatus`. */
function classifyNorthflankStatus(status: number): ProviderErrorType {
	if (status === 401 || status === 403) return "unauthorized";
	if (status === 404) return "not_found";
	if (status === 402) return "quota_exceeded";
	if (status === 422 || status === 400) return "invalid_config";
	if (status === 429) return "rate_limited";
	if (status >= 500) return "transient";
	return "unknown";
}

export class NorthflankSandboxProvider implements EphemeralProvider {
	readonly name = PROVIDER_NAME;
	readonly kind = "ephemeral" as const;
	readonly capabilities: SandboxCapabilities = {
		// Northflank keeps a service running until it is deleted; Harbor drives the
		// inactivity sweep itself, so this stays false like every other provider.
		supportsSandboxTimeout: false,
		supportsSnapshots: false,
		supportsRestore: false,
		supportsPersistentResume: false,
		supportsExplicitStop: true,
		// Northflank services can publish a public URL, but wiring that into Harbor's
		// tunnel model is not done, and claiming it before it works ships a dev server
		// to the public internet by accident.
		supportsTunnels: false,
	};
	readonly supportedFeatures: readonly string[] = [];

	private readonly fetchImpl: typeof fetch;
	private readonly options: NorthflankProviderOptions;

	constructor(options: NorthflankProviderOptions = {}) {
		this.options = options;
		this.fetchImpl = options.fetch ?? globalThis.fetch;
	}

	private token(operation: SandboxOperation): string {
		const token = this.options.token ?? process.env.NORTHFLANK_API_TOKEN;
		if (!token) {
			throw new SandboxProviderError({
				message:
					"NORTHFLANK_API_TOKEN is not set. The Northflank provider brokers every service "
					+ "call with an API token; without one it cannot create, inspect or delete a box. "
					+ "Create one under Account settings → API tokens and set NORTHFLANK_API_TOKEN.",
				errorType: "invalid_config",
				provider: PROVIDER_NAME,
				operation,
			});
		}
		return token;
	}

	private projectId(operation: SandboxOperation): string {
		const project = this.options.projectId ?? process.env.NORTHFLANK_PROJECT_ID;
		if (!project) {
			throw new SandboxProviderError({
				message:
					"NORTHFLANK_PROJECT_ID is not set. Northflank services live inside a project; "
					+ "Harbor needs to know which one to create them in. Create one in the Northflank "
					+ "dashboard and set NORTHFLANK_PROJECT_ID to its id.",
				errorType: "invalid_config",
				provider: PROVIDER_NAME,
				operation,
			});
		}
		return project;
	}

	private base(): string {
		return (
			this.options.apiHost
			?? process.env.NORTHFLANK_API_HOST
			?? "https://api.northflank.com"
		).replace(/\/+$/, "");
	}

	/**
	 * A service name Northflank will accept, derived from the attempt id.
	 *
	 * Northflank names must be 3–54 chars, start with a letter, and contain only
	 * letters, digits and single hyphens. The `harbor-` prefix supplies the leading
	 * letter and the managed marker; the attempt id is lowercased, non-alphanumerics
	 * are collapsed to single hyphens, edges trimmed, and the tail truncated so the
	 * whole name fits 54 chars. This is LOSSY — see the file header. The full attempt
	 * id is preserved in `description` for exact matching.
	 */
	private serviceName(attemptId: string): string {
		const slug = attemptId
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "");
		// 54 total − len("harbor-") = 47 chars of slug, trimmed of any hyphen the cut left.
		const tail = slug.slice(0, 54 - NAME_PREFIX.length).replace(/-+$/g, "");
		return `${NAME_PREFIX}${tail || "x"}`;
	}

	/**
	 * One request, one place the auth header and error classification live. `path`
	 * is appended after `/v1/projects/{projectId}`.
	 *
	 * A transport failure (Northflank unreachable, DNS, timeout) is `transient` and
	 * throws, never a `null` — the authority rule that keeps a network blip from
	 * becoming a second box. Token and project id are resolved BEFORE the try so a
	 * missing credential surfaces as `invalid_config`, not as a caught `transient`
	 * the circuit breaker would retry forever.
	 */
	private async request(
		method: string,
		path: string,
		operation: SandboxOperation,
		body?: unknown,
	): Promise<{ status: number; json: unknown }> {
		const authToken = this.token(operation);
		const project = this.projectId(operation);
		const url = `${this.base()}/v1/projects/${encodeURIComponent(project)}${path}`;
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
				message: `Northflank API unreachable during ${operation}: ${(cause as Error).message}`,
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
		// Northflank wraps errors as `{ error: { status, message, id, details } }`.
		const err =
			json && typeof json === "object" && "error" in json
				? (json as { error: unknown }).error
				: null;
		const detail =
			err && typeof err === "object" && "message" in err
				? String((err as { message: unknown }).message).slice(0, 500)
				: JSON.stringify(json).slice(0, 500);
		return new SandboxProviderError({
			message: `Northflank refused ${operation} (${status}): ${detail}`,
			errorType: classifyNorthflankStatus(status),
			provider: PROVIDER_NAME,
			operation,
			detail,
		});
	}

	/** Northflank wraps success bodies as `{ data: ... }`; this unwraps defensively. */
	private dataOf(json: unknown): unknown {
		if (json && typeof json === "object" && "data" in json) {
			return (json as { data: unknown }).data;
		}
		return json;
	}

	async create(config: CreateSandboxConfig): Promise<CreatedSandbox> {
		assertFeaturesSupported(this, config, "create");

		const deploymentPlan =
			this.options.deploymentPlan ?? process.env.NORTHFLANK_DEPLOYMENT_PLAN ?? "nf-compute-20";
		const instances = this.options.instances ?? Number(process.env.NORTHFLANK_INSTANCES ?? "1");

		const deployment: Record<string, unknown> = {
			instances,
			// `config.image` is an external container image, per the provider contract.
			external: { imagePath: config.image },
		};
		// Only override the image's own entrypoint when the caller supplied argv — the
		// Harbor sandbox image is built to run with none. NOTE: Northflank's docker
		// override shape (`deployment.docker`) is not verified against a live schema;
		// this branch is exercised only when a caller passes `command`, which the
		// Harbor default never does. Passed as argv, never a joined command line.
		if (config.command && config.command.length > 0) {
			deployment.docker = { configType: "customEntrypoint", customEntrypoint: config.command };
		}

		const { status, json } = await this.request("POST", "/services/deployment", "create", {
			name: this.serviceName(config.attemptId),
			// The FULL attempt id, unmodified, in a field Northflank returns on list —
			// this is what `findByAttemptId` matches on exactly, since the name is lossy.
			description: this.encodeMeta(config),
			// A visible marker in the Northflank UI. Not relied on for reconciliation
			// (tag semantics/constraints are unverified); the name prefix is authority.
			tags: [NAME_PREFIX.replace(/-$/, "")],
			billing: { deploymentPlan },
			deployment,
			// Harbor injects the full clone→agent environment verbatim.
			runtimeEnvironment: config.env,
		});
		if (status !== 200 && status !== 201) throw this.fail(status, "create", json);

		const box = this.dataOf(json) as NorthflankService;
		// GET/DELETE address the service by its generated id/slug, which Northflank
		// derives from the name — capture it rather than reusing the name we sent.
		const id = box?.id;
		if (!id) {
			throw new SandboxProviderError({
				message:
					"Northflank created a service but returned no id, so it cannot be tracked or reaped.",
				errorType: "unknown",
				provider: PROVIDER_NAME,
				operation: "create",
			});
		}

		return {
			externalId: id,
			provider: PROVIDER_NAME,
			attemptId: config.attemptId,
			state: northflankState(rawStateOf(box) ?? "deploying"),
			createdAt: new Date().toISOString(),
		};
	}

	async inspect(externalId: string): Promise<SandboxInspection | null> {
		const { status, json } = await this.request(
			"GET",
			`/services/${encodeURIComponent(externalId)}`,
			"inspect",
		);
		// 404 is the one status that is an answer rather than an error: Northflank
		// replied and there is no such service. Anything else non-200 is rethrown,
		// because a caller reading `null` concludes the box is gone.
		if (status === 404) return null;
		if (status !== 200) throw this.fail(status, "inspect", json);
		return this.toInspection(this.dataOf(json) as NorthflankService);
	}

	/**
	 * Reconciliation. `null` means Northflank answered and no managed service
	 * carries this attempt id in its description; a call that cannot reach
	 * Northflank throws, per the authority note on the base interface — returning
	 * `null` on a lost connection starts a second box on the same branch.
	 *
	 * Matched on the FULL attempt id in `description`, not the lossy service name,
	 * so two attempts whose names collide are still told apart.
	 */
	async findByAttemptId(attemptId: string): Promise<SandboxInspection | null> {
		const services = await this.listServices("find_by_attempt");
		const matching = services.filter(
			(svc) => isManaged(svc) && decodeMeta(svc.description).attempt === attemptId,
		);
		if (matching.length === 0) return null;

		if (matching.length > 1) {
			console.warn(
				`[northflank] ${matching.length} services share attempt ${attemptId}: `
					+ `${matching.map((s) => s.id).join(", ")}. Adopting a live one; the rest are `
					+ "orphans and must be deleted.",
			);
		}
		const inspections = matching.map((svc) => this.toInspection(svc));
		return (
			inspections.find((i) => i.state === "running" || i.state === "starting") ?? inspections[0]!
		);
	}

	async stop(externalId: string, _options?: StopOptions): Promise<StopOutcome> {
		// Ephemeral: deleting the service reclaims the box entirely.
		const { status, json } = await this.request(
			"DELETE",
			`/services/${encodeURIComponent(externalId)}`,
			"stop",
		);
		if (status === 404) return "absent";
		if (status === 200 || status === 202 || status === 204) return "stopped";
		// A service already deleted can report 404 (handled) or an "already"/"not
		// found" body on some paths; treat that as the idempotent already-gone case
		// rather than an error, because stop is called from retrying paths.
		const detail = JSON.stringify(json).toLowerCase();
		if (/already|not found|does not exist|deleting|deleted/.test(detail)) return "already_stopped";
		throw this.fail(status, "stop", json);
	}

	/**
	 * Every LIVE Harbor-managed service in the project.
	 *
	 * Filtered on the `harbor-` name prefix rather than listing the whole project,
	 * because a self-hoster's Northflank project may legitimately run services
	 * Harbor did not create and every entry returned here is a stop candidate.
	 *
	 * Fails CLOSED, per the authority note on the interface: an unreachable list
	 * throws rather than returning `[]`. An empty list from a dead API reads as "no
	 * orphans anywhere", the exact conclusion that lets a stranded service bill
	 * until somebody notices the invoice.
	 *
	 * Live boxes only. A stopped service in this ephemeral provider has been deleted
	 * (see `stop`), so a terminal service re-reported here would have the sweep issue
	 * a delete for a box that no longer exists.
	 */
	async listManaged(): Promise<SandboxInspection[]> {
		const services = await this.listServices("list_managed");
		return services
			.filter((svc) => isManaged(svc))
			.map((svc) => this.toInspection(svc))
			.filter((i) => i.state === "running" || i.state === "starting");
	}

	/**
	 * List every service in the project, following the cursor. Shared by
	 * `findByAttemptId` and `listManaged`, and the single fail-closed choke point:
	 * any non-200 throws. Bounded by `NORTHFLANK_LIST_MAX_PAGES` (read inline, not a
	 * module constant) so a huge project cannot spin forever — see the header's note
	 * that an orphan past the last page is invisible.
	 */
	private async listServices(operation: SandboxOperation): Promise<NorthflankService[]> {
		const maxPages = Number(process.env.NORTHFLANK_LIST_MAX_PAGES ?? "20");
		const all: NorthflankService[] = [];
		let cursor: string | null = null;
		for (let page = 0; page < maxPages; page += 1) {
			const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
			const { status, json } = await this.request("GET", `/services${query}`, operation);
			if (status !== 200) throw this.fail(status, operation, json);

			const data = this.dataOf(json);
			const services = asServiceList(data);
			all.push(...services);

			const next = nextCursor(json);
			if (!next) break;
			cursor = next;
		}
		return all;
	}

	/** The compact `attempt|session|sandbox` string stored in `description`. */
	private encodeMeta(config: CreateSandboxConfig): string {
		const encoded = `${config.attemptId}|${config.sessionId}|${config.sandboxId}`;
		// Northflank caps description at 200 chars and rejects an over-long one. If the
		// combined ids exceed that, keep the attempt id alone — it is the reconciliation
		// key that must survive; session/sandbox are only used for post-mortem joins.
		return encoded.length <= 200 ? encoded : config.attemptId.slice(0, 200);
	}

	private toInspection(svc: NorthflankService): SandboxInspection {
		const raw = rawStateOf(svc) ?? "unknown";
		const meta = decodeMeta(svc.description);
		return {
			externalId: svc.id ?? "",
			provider: PROVIDER_NAME,
			state: northflankState(raw),
			rawState: raw,
			attemptId: meta.attempt,
			sessionId: meta.session,
			sandboxId: meta.sandbox,
			startedAt:
				svc.status?.deployment?.lastTransitionTime
				?? svc.status?.build?.lastTransitionTime
				?? svc.createdAt
				?? null,
			exitCode: null,
		};
	}
}

/** Prefer the deployment status; fall back to the build status; else nothing. */
function rawStateOf(svc: NorthflankService): string | null {
	return svc.status?.deployment?.status ?? svc.status?.build?.status ?? null;
}

/** A service is Harbor's iff its name carries the managed prefix. */
function isManaged(svc: NorthflankService): boolean {
	return typeof svc.name === "string" && svc.name.startsWith(NAME_PREFIX);
}

/** Decode the `attempt|session|sandbox` description back into its three ids. */
function decodeMeta(description: string | undefined): {
	attempt: string | null;
	session: string | null;
	sandbox: string | null;
} {
	if (!description) return { attempt: null, session: null, sandbox: null };
	const [attempt, session, sandbox] = description.split("|");
	return {
		attempt: attempt || null,
		session: session || null,
		sandbox: sandbox || null,
	};
}

/**
 * Northflank returns the service array under `{ data: { services: [...] } }`; a
 * defensive reader also accepts a bare array or a `{ services: [...] }` envelope
 * in case a future API version flattens it.
 */
function asServiceList(data: unknown): NorthflankService[] {
	if (Array.isArray(data)) return data as NorthflankService[];
	if (data && typeof data === "object" && Array.isArray((data as { services?: unknown }).services)) {
		return (data as { services: NorthflankService[] }).services;
	}
	return [];
}

/** The next page cursor from `{ pagination: { hasNextPage, cursor } }`, or null. */
function nextCursor(json: unknown): string | null {
	if (!json || typeof json !== "object" || !("pagination" in json)) return null;
	const pagination = (json as { pagination: unknown }).pagination;
	if (!pagination || typeof pagination !== "object") return null;
	const { hasNextPage, cursor } = pagination as { hasNextPage?: boolean; cursor?: string };
	if (hasNextPage && typeof cursor === "string" && cursor.length > 0) return cursor;
	return null;
}

export function northflankProvider(options?: NorthflankProviderOptions): EphemeralProvider {
	return new NorthflankSandboxProvider(options);
}
