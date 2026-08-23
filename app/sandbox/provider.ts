// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * What a sandbox backend has to implement, with capabilities expressed as TYPES.
 *
 * The obvious shape for this file is a single wide interface where every method
 * exists, half of them are optional, and a `capabilities` object of runtime
 * booleans tells you which ones are real. That shape has one specific,
 * recurring failure: nothing ties the
 * boolean to the method. `provider.restoreFromSnapshot?.(ref)` on a backend that
 * cannot restore is not a crash and not an error — it is `undefined`, silently,
 * and the resume path continues as though a box came back. The session then
 * appears to resume onto an empty workspace and the agent starts its next turn
 * with none of the work it did an hour ago. Nobody sees an exception; they see an
 * agent that "forgot".
 *
 * So capability is the discriminant of a union instead:
 *
 *     type SandboxProvider = EphemeralProvider | SnapshotProvider | PersistentProvider
 *
 * and `restoreFromSnapshot` does not exist on the type unless it exists at
 * runtime. Calling it without narrowing is a compile error, which is where that
 * bug belongs. `capabilities` survives for display and for the health endpoint —
 * an operator wants to read what their provider can do — but no control flow may
 * branch on it. Control flow branches on `kind`.
 *
 * Three members, not two, because "resume" is genuinely two different operations
 * that people keep collapsing into one:
 *
 *   - **snapshot/restore** captures filesystem state and boots a NEW box from it.
 *     The old box is gone; the new one has a different external id, a different
 *     host, possibly a different IP.
 *   - **pause/resume** stops and later restarts THE SAME box, keeping its disk,
 *     its id and usually its host.
 *
 * A manager that thinks it has one operation writes code that is wrong for the
 * other: it either leaks the original box (treating restore as if it resumed one)
 * or it re-registers a new external id for a box whose id never changed.
 *
 * `docker` is the canonical implementation of this interface and the default. See
 * `providers/docker.ts` — running the whole product on a laptop with no vendor
 * account is the point of this project, not a fallback.
 */

import { CIRCUIT_TRIPPING_ERROR_TYPES } from "../contracts/index.js";
import type { ProviderErrorType, SandboxCapabilities } from "../contracts/index.js";

// ---------------------------------------------------------------------------
// Exhaustiveness
// ---------------------------------------------------------------------------

/**
 * The compile-time half of "no `default` branch".
 *
 * Every switch over a closed set in this package ends by falling through to this
 * with the scrutinee narrowed to `never`. Adding a member to the set therefore
 * breaks the build at every decision point that has not been updated — which is
 * the entire reason the sets are closed. A `default:` arm would compile instead
 * and pick some behaviour for the new member, and the behaviour it picks is
 * always the one that was safe for the old members and wrong for the new one.
 *
 * The runtime throw is a formality: reaching it means a value crossed a boundary
 * that types said it could not, which is worth failing loudly for.
 */
export function assertNever(value: never, context: string): never {
	throw new Error(
		`${context}: unhandled variant ${JSON.stringify(value)}. `
			+ "A member was added to a closed set without updating every switch over it.",
	);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Which provider call failed. Carried on the error so logs say where, not just what. */
export const SANDBOX_OPERATIONS = [
	"create",
	"stop",
	"inspect",
	"find_by_attempt",
	"list_managed",
	"snapshot",
	"restore",
	"pause",
	"resume",
	"build_image",
	"prune_images",
] as const;
export type SandboxOperation = (typeof SANDBOX_OPERATIONS)[number];

/**
 * The only error a provider may throw, and it is typed for the circuit breaker.
 *
 * The breaker's job is to stop hammering a backend that is down. It cannot do
 * that job from an `Error` with a string message, because the two failures it
 * must treat oppositely look identical at that level: "the daemon is not
 * answering" (retry later, count towards opening the circuit) and "that image
 * name is not a valid reference" (retrying is pointless, and counting it opens
 * the circuit on a configuration typo — which then hides a real outage behind a
 * user error, in the one place an operator is looking for the real outage).
 *
 * `errorType` is therefore mandatory at every throw site, and providers classify
 * from the backend's own output rather than defaulting to `transient`. See
 * `CIRCUIT_TRIPPING_ERROR_TYPES` in the contracts for which ones count.
 */
export class SandboxProviderError extends Error {
	readonly errorType: ProviderErrorType;
	readonly provider: string;
	readonly operation: SandboxOperation;
	/** Backend output, already truncated by the provider. Never a secret. */
	readonly detail: string | null;
	readonly cause: unknown;

	constructor(input: {
		message: string;
		errorType: ProviderErrorType;
		provider: string;
		operation: SandboxOperation;
		detail?: string | null;
		cause?: unknown;
	}) {
		super(input.message);
		this.name = "SandboxProviderError";
		this.errorType = input.errorType;
		this.provider = input.provider;
		this.operation = input.operation;
		this.detail = input.detail ?? null;
		this.cause = input.cause;
	}

	/**
	 * Whether this failure should count towards opening the circuit.
	 *
	 * Read from the contract's list rather than re-decided here, so the breaker and
	 * the providers cannot drift into disagreeing about what "transient" means.
	 */
	get tripsCircuit(): boolean {
		return CIRCUIT_TRIPPING_ERROR_TYPES.includes(this.errorType);
	}
}

// ---------------------------------------------------------------------------
// Runtime state, and the liveness asymmetry
// ---------------------------------------------------------------------------

/**
 * What a provider says a box is doing right now.
 *
 * Deliberately smaller than any backend's own vocabulary. Docker alone has
 * created/running/paused/restarting/removing/exited/dead, and a remote provider
 * will have its own seven; normalising into six here is what lets one lifecycle
 * manager drive all of them.
 *
 * `unknown` is a first-class member and not an error. A backend that grows a new
 * state next year, or a probe that comes back with something we do not recognise,
 * must map to `unknown` and NOT to a guess — see `isLive` for what `unknown`
 * then means.
 */
export const PROVIDER_SANDBOX_STATES = [
	"starting",
	"running",
	"paused",
	"exited",
	"gone",
	"unknown",
] as const;
export type ProviderSandboxState = (typeof PROVIDER_SANDBOX_STATES)[number];

/**
 * **Liveness fails OPEN.** An unrecognised state is treated as live.
 *
 * The question callers ask is "may I stop caring about this box / spawn another
 * one?". Answering "yes" for a box that is actually running is the expensive
 * mistake: the running agent keeps working, keeps spending, keeps pushing to the
 * branch, and a second box is started alongside it. Answering "no" for a box that
 * is actually dead costs one wasted reconciliation pass, which the next sweep
 * fixes.
 *
 * So the mapping is a deny-list — only states we positively know mean "not
 * running" are dead — and `unknown` sits on the live side. This is the exact
 * inverse of the rule applied to *authority* (`findByAttemptId`, below), and the
 * asymmetry is deliberate: being wrong about liveness should waste a probe, being
 * wrong about authority should never be possible. Both comments say so, at both
 * sites, because someone will eventually "fix" one of them to match the other.
 *
 * Same direction as `DEAD_SANDBOX_STATUSES` in the contracts, for the same reason.
 */
export function isLive(state: ProviderSandboxState): boolean {
	switch (state) {
		case "starting":
			return true;
		case "running":
			return true;
		case "paused":
			// A paused box still holds its disk, its ports and (on most backends) its
			// bill. It is not running, but it is emphatically not reclaimable, and the
			// only caller that cares about the difference asks for `state` directly.
			return true;
		case "exited":
			return false;
		case "gone":
			return false;
		case "unknown":
			return true;
	}
	return assertNever(state, "isLive");
}

/**
 * Raw backend state string → our closed set, as a deny-list.
 *
 * Written this way round on purpose. An allow-list ("running" and "up" mean
 * live, everything else is dead) silently reclassifies every state a backend adds
 * later as dead, and the symptom is boxes being reaped while their agent is
 * mid-turn — with no error, because every layer believed it was doing the right
 * thing. A deny-list gets the new state wrong in the direction that only costs a
 * probe.
 *
 * Providers may override this when their backend's vocabulary is known exactly;
 * it is the fallback that keeps an unknown string from becoming a guess.
 */
export function normalizeProviderState(raw: string): ProviderSandboxState {
	const value = raw.trim().toLowerCase();
	// Dead first: these are the only strings that may produce a non-live answer.
	if (["exited", "stopped", "dead", "removing", "removed", "terminated", "killed"].includes(value)) {
		return "exited";
	}
	if (["gone", "destroyed", "deleted", "not_found"].includes(value)) return "gone";
	if (["paused", "suspended", "frozen"].includes(value)) return "paused";
	if (["created", "restarting", "starting", "provisioning", "pending", "booting"].includes(value)) {
		return "starting";
	}
	if (["running", "up", "active", "ready"].includes(value)) return "running";
	return "unknown";
}

// ---------------------------------------------------------------------------
// Creating a box
// ---------------------------------------------------------------------------

/**
 * Everything a provider needs to start one box, and nothing else.
 *
 * The field count is a design constraint, not an accident. A struct that grows a
 * field per optional behaviour — several of them booleans that all mean "install
 * this optional thing" — forces every provider to read the whole thing to find out
 * which parts are irrelevant to it. Optional behaviour goes in `features` instead,
 * which is one map with one rule (below), so adding an optional capability never
 * widens this interface and never touches a provider that does not implement it.
 */
export interface CreateSandboxConfig {
	sessionId: string;
	sandboxId: string;
	/**
	 * The idempotency key for this spawn attempt, and the reason reconciliation is
	 * possible at all.
	 *
	 * Providers MUST attach this to the box as a label, tag or equivalent
	 * searchable metadata before the box can start doing anything, so that a box
	 * created by a call whose response we never received is *discoverable* rather
	 * than an invisible orphan burning money. `findByAttemptId` is the other half.
	 * See the `SpawnIntent` note in src/contracts for the four ambiguous failures
	 * this closes.
	 */
	attemptId: string;
	/** Backend-specific image or template reference. For `local`, the host runtime id. */
	image: string;
	/** Absolute path the agent works in, inside the box. */
	workspace: string;
	/** Injected verbatim. Already decrypted, already scoped; providers never resolve secrets. */
	env: Record<string, string>;
	/**
	 * Wall-clock ceiling for the create call itself. Resolved by the caller from
	 * `setting("sandboxBootTimeoutMs")` — never by the provider from a constant,
	 * because a monorepo that legitimately takes four minutes to boot must be able
	 * to say so without forking this file.
	 */
	timeoutMs: number;
	/**
	 * Optional behaviour, one map instead of a boolean per feature.
	 *
	 * The rule that makes an open map safe: a key a provider does not support is a
	 * hard `invalid_config` error, never a silent no-op. Silently ignoring
	 * `network_disabled` on a backend that cannot do it means an operator who
	 * believes the agent is offline is running it with full network access, and
	 * they find out from an egress log rather than from Harbor. Absent means off;
	 * unsupported means refused.
	 */
	features: Record<string, boolean>;
	/**
	 * Argv for the process the box should run, when the caller has one.
	 *
	 * Absent means the image's own entrypoint, which is what the Harbor sandbox
	 * image is built for. Supplied by tests, by images that are not ours, and by
	 * the `local` provider's single-element prompt. Always argv, never a command
	 * line: the elements are attacker-influenced and a shell would reinterpret them.
	 */
	command?: string[];
}

/** Is an optional feature on? Absent is off — the caller must ask for it explicitly. */
export function featureEnabled(config: CreateSandboxConfig, feature: string): boolean {
	return config.features[feature] === true;
}

/**
 * Refuse a create that asks for something this provider cannot do.
 *
 * Called by every provider at the top of `create`. The failure it prevents is the
 * one described on `CreateSandboxConfig.features`: a feature that quietly does
 * nothing is worse than one that errors, because the operator's mental model of
 * the box's isolation stays wrong until something leaks.
 */
export function assertFeaturesSupported(
	provider: { name: string; supportedFeatures: readonly string[] },
	config: CreateSandboxConfig,
	operation: SandboxOperation,
): void {
	const asked = Object.entries(config.features)
		.filter(([, on]) => on === true)
		.map(([key]) => key);
	const unsupported = asked.filter((key) => !provider.supportedFeatures.includes(key));
	if (unsupported.length === 0) return;
	throw new SandboxProviderError({
		message:
			`The ${provider.name} provider does not support ${unsupported.join(", ")}. `
			+ `It supports: ${provider.supportedFeatures.join(", ") || "no optional features"}. `
			+ "Refusing rather than ignoring: a feature that silently does nothing leaves the "
			+ "operator believing the box is more constrained than it is.",
		errorType: "invalid_config",
		provider: provider.name,
		operation,
	});
}

/** A box that now exists. The external id is the provider's own handle for it. */
export interface CreatedSandbox {
	externalId: string;
	provider: string;
	attemptId: string;
	state: ProviderSandboxState;
	/** ISO 8601, from our clock. Display and ordering within Harbor only. */
	createdAt: string;
}

/**
 * What a probe found. `null` from the probing methods means definitively absent —
 * see the authority note on `findByAttemptId`.
 */
export interface SandboxInspection {
	externalId: string;
	provider: string;
	state: ProviderSandboxState;
	/** Exactly what the backend said, before normalisation. Kept for post-mortems. */
	rawState: string;
	/** Read back from the box's own labels, so reconciliation can verify what it found. */
	attemptId: string | null;
	sessionId: string | null;
	sandboxId: string | null;
	startedAt: string | null;
	exitCode: number | null;
}

/**
 * Why `stop` returns a reason instead of `void` or a boolean.
 *
 * Stop is called from paths that retry — a timeout sweep, a user pressing stop
 * twice, a reconciler cleaning up after an ambiguous failure — so it must be
 * idempotent. But "idempotent" is not the same as "indistinguishable": the
 * lifecycle manager writes a `sandbox_stopped` event for a box it actually
 * stopped and stays quiet for one that was already gone, and with a `void` return
 * it cannot tell, so it either writes duplicate events onto the timeline or none
 * at all. A typed outcome costs nothing and makes both callers correct.
 */
export type StopOutcome =
	/** We asked the backend to stop it and it did. */
	| "stopped"
	/** It existed but had already exited. Nothing was done. */
	| "already_stopped"
	/** The backend has no record of it at all. Nothing was done. */
	| "absent";

export interface StopOptions {
	/**
	 * How long the box gets to wind up before it is killed, in milliseconds.
	 *
	 * Resolved by the caller from configuration. The provider falls back to a
	 * setting rather than a constant when this is absent, because "how long a
	 * shutting-down box may take to flush its buffered events" is exactly the kind
	 * of number a self-hoster with a slow disk needs to change.
	 */
	graceMs?: number;
}

/** A handle to captured filesystem state. Opaque outside the provider that made it. */
export interface SnapshotRef {
	/** The provider that produced it. Restoring on a different one is refused. */
	provider: string;
	/** Backend-specific: an image tag, a volume id, a URL. */
	handle: string;
	/** The box it was taken from, for provenance when a restore goes wrong. */
	sourceExternalId: string;
	takenAt: string;
}

// ---------------------------------------------------------------------------
// The providers
// ---------------------------------------------------------------------------

export const SANDBOX_PROVIDER_KINDS = ["ephemeral", "snapshot", "persistent"] as const;
export type SandboxProviderKind = (typeof SANDBOX_PROVIDER_KINDS)[number];

/** The four operations every backend must have. Anything more is a capability. */
interface SandboxProviderBase {
	readonly name: string;
	readonly kind: SandboxProviderKind;
	/**
	 * For display and for `GET /api/health/config`. **Never branch on this.**
	 * Branch on `kind`, which the compiler checks; these booleans are a description
	 * of the provider written by the provider, and a description can be wrong.
	 */
	readonly capabilities: SandboxCapabilities;
	/** Feature keys this provider implements. Anything else in `features` is refused. */
	readonly supportedFeatures: readonly string[];

	create(config: CreateSandboxConfig): Promise<CreatedSandbox>;

	/** Idempotent by contract; see `StopOutcome`. */
	stop(externalId: string, options?: StopOptions): Promise<StopOutcome>;

	/** `null` means the backend answered and has no such box. */
	inspect(externalId: string): Promise<SandboxInspection | null>;

	/**
	 * **Authority fails CLOSED.** `null` means *definitively absent*, never "I could
	 * not tell".
	 *
	 * This is the reconciliation primitive. After an ambiguous create failure the
	 * spawn saga asks this exact question — "does the box I may have created exist?"
	 * — and a `null` answer causes it to create another one. So a provider that
	 * cannot reach its backend MUST throw a `SandboxProviderError` (usually
	 * `transient`) rather than return `null`: returning `null` on a lost connection
	 * turns one network blip into two running agents on the same branch, both
	 * pushing, and the second one is invisible to the first.
	 *
	 * That is the mirror image of the liveness rule on `isLive`, where an
	 * indeterminate answer resolves to *live*. Both rules point the same way in
	 * consequence — never conclude that something dangerous is gone — and opposite
	 * ways in mechanism. Do not "fix" one to match the other.
	 */
	findByAttemptId(attemptId: string): Promise<SandboxInspection | null>;

	/**
	 * Every LIVE box this backend is running that carries Harbor's management
	 * marker. The other half of reconciliation: `findByAttemptId` answers "did
	 * attempt X produce a box", this answers "what boxes exist at all" — which is
	 * the only question that finds a container whose row was corrupted, whose
	 * conclusion was raced, or whose control plane died between create and record.
	 *
	 * **Authority fails CLOSED, same as `findByAttemptId`.** A backend that
	 * cannot answer MUST throw, never return `[]`: the caller treats the list as
	 * the complete population of running boxes, and an empty answer from a dead
	 * daemon reads as "no orphans anywhere" — the exact conclusion that lets a
	 * stranded container bill forever.
	 *
	 * Live boxes only. Stopped containers are deliberately kept for post-mortems
	 * (see the docker provider's `stop`) and must not appear here, because every
	 * entry in this list is a stop candidate.
	 */
	listManaged(): Promise<SandboxInspection[]>;
}

/** Create, stop, inspect. No resume of any kind: a stopped box is gone. */
export interface EphemeralProvider extends SandboxProviderBase {
	readonly kind: "ephemeral";
}

/**
 * Captures filesystem state and boots a NEW box from it.
 *
 * The restored box has a different external id. Callers must register it as a new
 * sandbox row rather than reusing the old one — the old box does not come back,
 * and treating the restore as a resume leaves a stale row pointing at nothing.
 */
export interface SnapshotProvider extends SandboxProviderBase {
	readonly kind: "snapshot";
	snapshot(externalId: string): Promise<SnapshotRef>;
	restoreFromSnapshot(ref: SnapshotRef, config: CreateSandboxConfig): Promise<CreatedSandbox>;
}

/**
 * Stops and later restarts THE SAME box, disk intact, id unchanged.
 *
 * `resume` returns the same `externalId` it was given. A caller that allocates a
 * new sandbox row for it has leaked the original.
 */
export interface PersistentProvider extends SandboxProviderBase {
	readonly kind: "persistent";
	pause(externalId: string): Promise<void>;
	resume(externalId: string): Promise<CreatedSandbox>;
}

export type SandboxProvider = EphemeralProvider | SnapshotProvider | PersistentProvider;

/** Narrowing helpers, so callers branch on the discriminant rather than on a boolean. */
export function isSnapshotProvider(provider: SandboxProvider): provider is SnapshotProvider {
	return provider.kind === "snapshot";
}

export function isPersistentProvider(provider: SandboxProvider): provider is PersistentProvider {
	return provider.kind === "persistent";
}

/** What to build, and what to publish it as. */
export interface ImageBuildConfig {
	/** The image to build FROM, before the repo's `setup.sh` bakes dependencies on top. */
	base: string;
	/** The reference to publish the result as, e.g. `harbor-repo-<id>:<sha>`. */
	targetTag: string;
	workspace: string;
	/**
	 * The same environment contract a spawn uses. A build IS a boot in `build` mode,
	 * so this carries `HARBOR_BOOT_MODE=build` and `HARBOR_REPOS`, and the in-box
	 * supervisor clones and runs `setup.sh` from it exactly as it would for a session.
	 */
	env: Record<string, string>;
	features: Record<string, boolean>;
	/** Wall-clock ceiling for the whole build, killed past it. */
	timeoutMs: number;
}

/** A successfully built, bootable image. */
export interface BuiltImage {
	/** The handle a later spawn boots from. */
	imageRef: string;
	/** The provider that built it. */
	provider: string;
	/** A bounded tail of the build log, kept for the `image_builds` record. */
	log: string;
}

/**
 * A provider that can bake a per-repo image with dependencies pre-installed.
 *
 * This capability is ORTHOGONAL to `kind`, which is why it is a separate interface
 * and not a fourth discriminant: `docker` is a `snapshot` provider AND an image
 * builder, and a fourth `kind` would force it to be only one. So image-building is a
 * mixin a provider may also implement, discovered through `isImageBuildingProvider`
 * — the same "capability is a type, not a boolean" discipline the snapshot and
 * persistent capabilities follow. A provider that cannot build images (the `local`
 * provider) simply does not implement it, has no `buildImage` method on its type,
 * and calling one on it is a **compile error** rather than a runtime refusal.
 *
 * It deliberately does NOT hang an optional `buildImage?()` off `SandboxProviderBase`
 * paired with a `supportsImages` boolean. That shape — the one the codebase rejects
 * everywhere — lets `provider.buildImage?.(cfg)` return `undefined` on a backend that
 * cannot build, with nothing tying the boolean to the method, and the failure surfaces
 * as a repo whose image never appears and no error that says why.
 */
export interface ImageBuildingProvider {
	/**
	 * Discriminant, present and `true` only on providers that build images. The guard
	 * reads it so the narrowing is a type check rather than a `typeof method` sniff.
	 */
	readonly buildsImages: true;

	/**
	 * Build and publish an image, or throw.
	 *
	 * A non-zero `setup.sh` MUST fail the build and publish nothing — baking a broken
	 * image is the one permanent permissiveness, inherited by every box from it with
	 * no warning. The thrown `SandboxProviderError` is a `config`-type (non-tripping)
	 * error, not `transient`: a repository's broken setup is the repository's problem
	 * and must not open the provider's circuit against every other repo.
	 */
	buildImage(config: ImageBuildConfig): Promise<BuiltImage>;

	/**
	 * Remove images this provider built under `tagPrefix` that are not in `keep`,
	 * returning the references actually removed. Bounds the disk an unattended,
	 * per-interval build loop would otherwise grow forever.
	 */
	pruneImages(tagPrefix: string, keep: readonly string[]): Promise<string[]>;
}

/**
 * Narrowing helper for the image-building capability.
 *
 * `"buildsImages" in provider` is a real type narrowing, so this needs no cast and
 * a provider that lacks the field cannot pass. A `SandboxProvider` from the registry
 * therefore cannot call `buildImage` without going through this guard, and a value
 * statically typed as the `local` provider cannot call it at all.
 */
export function isImageBuildingProvider(
	provider: SandboxProvider,
): provider is SandboxProvider & ImageBuildingProvider {
	return "buildsImages" in provider && provider.buildsImages === true;
}

/**
 * How a session on this provider comes back after its box was stopped.
 *
 * The one place the lifecycle manager needs to branch, hoisted here so it is
 * written once and is exhaustive. A new provider kind breaks this switch, which
 * is the intended way to discover that resume has a third meaning.
 *
 * `fresh_boot` carries a typed reason rather than being an empty variant: the
 * user-visible message on a cold start is "this provider cannot resume, so we
 * rebuilt the workspace", and that sentence needs to know why.
 */
export type ResumeStrategy =
	| { kind: "snapshot_restore"; provider: SnapshotProvider }
	| { kind: "same_box"; provider: PersistentProvider }
	| { kind: "fresh_boot"; reason: "provider_is_ephemeral" };

export function resumeStrategyFor(provider: SandboxProvider): ResumeStrategy {
	switch (provider.kind) {
		case "snapshot":
			return { kind: "snapshot_restore", provider };
		case "persistent":
			return { kind: "same_box", provider };
		case "ephemeral":
			return { kind: "fresh_boot", reason: "provider_is_ephemeral" };
	}
	return assertNever(provider, "resumeStrategyFor");
}
