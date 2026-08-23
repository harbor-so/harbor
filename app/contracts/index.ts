// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The wire contract. One file, and everything that crosses a process boundary is
 * defined in it.
 *
 * Three processes exchange messages in Harbor: the control plane (this Next.js
 * app), the bridge running inside a sandbox, and whatever client is attached to a
 * session — a browser, a Slack bot, a `curl`. Each of the three is written in a
 * different place and deployed on a different schedule, which is exactly the
 * situation where types drift silently and a producer starts emitting a variant no
 * consumer understands.
 *
 * The rule that prevents it: **a new event variant lands here first.** Not in the
 * producer, not in a normalizer, not as a string literal in a switch. It is
 * enforced by `contracts.test.ts` rather than left as a convention, because a
 * convention is a comment and a comment does not fail a build.
 *
 * Two smaller disciplines, both of which exist because of a specific failure:
 *
 *  - **Closed sets over free strings.** Every union here is a `const` array with a
 *    derived type, the same discipline `EVENT_TYPES` and `ACTIVITY_KINDS` already
 *    use in the schema. A producer that invents `"sandbox_booting"` when the
 *    consumer switches on `"sandbox_spawning"` fails silently at runtime and loudly
 *    at compile time; we want the loud one.
 *
 *  - **snake_case at every transport edge.** The database is snake_case, JSON on
 *    the wire is snake_case, and TypeScript in memory is camelCase. Picking one
 *    boundary to convert at — and it is this file — is what stops `session_id`,
 *    `sessionId` and `sessionID` all appearing in the same log line, which is how
 *    correlating a trace across three processes turns into grep archaeology.
 */

// ---------------------------------------------------------------------------
// Correlation
// ---------------------------------------------------------------------------

/**
 * The keys that identify one piece of work across processes.
 *
 * These names appear in JSON bodies, in `x-harbor-*` headers and in log lines,
 * and they are identical in all three. `traceId` is minted at the edge that first
 * receives a request — a webhook, a prompt POST, a cron tick — and is carried
 * unchanged through the sandbox and back, so one Slack message and the PR it
 * eventually opens share a single greppable token.
 */
export interface Correlation {
	trace_id: string;
	request_id?: string;
	session_id?: string;
	sandbox_id?: string;
	org_id?: string;
}

export const CORRELATION_KEYS = [
	"trace_id",
	"request_id",
	"session_id",
	"sandbox_id",
	"org_id",
] as const;

export type CorrelationKey = (typeof CORRELATION_KEYS)[number];

/** `trace_id` → `x-harbor-trace-id`. The only mapping, so it cannot disagree. */
export function correlationHeader(key: CorrelationKey): string {
	return `x-harbor-${key.replace(/_/g, "-")}`;
}

// ---------------------------------------------------------------------------
// Sandbox lifecycle
// ---------------------------------------------------------------------------

/**
 * Every state a sandbox row can hold.
 *
 * `failed` is in this list and is deliberately still reconnectable — see
 * `DEAD_SANDBOX_STATUSES` below for why that is not a contradiction.
 */
export const SANDBOX_STATUSES = [
	"requested",
	"spawning",
	"ready",
	"busy",
	"idle",
	"stopping",
	"stopped",
	"stale",
	"failed",
] as const;
export type SandboxStatus = (typeof SANDBOX_STATUSES)[number];

/**
 * A deny-list, not an allow-list, and the direction is the point.
 *
 * The question callers ask is "is this box dead?". Written as an allow-list of
 * live statuses, a status added next year defaults to *dead* — and a box that is
 * actually running gets abandoned, its work lost, with no error anywhere because
 * every caller thought it was behaving correctly. Written as a deny-list, an
 * unknown status defaults to *live* and callers fall through to their own checks
 * (heartbeat age, provider probe), which is the recoverable direction to fail in.
 *
 * `failed` is listed because a persisted failure blocks reconnection, but see
 * `isReconnectable` in `src/sandbox/decisions.ts`: a slow boot can outlive the
 * watchdog that marked it failed and then show up with a working bridge, and
 * refusing that box means throwing away a sandbox that is demonstrably alive.
 */
export const DEAD_SANDBOX_STATUSES: readonly SandboxStatus[] = ["stopped", "stale", "failed"];

/**
 * How a sandbox came up. Exactly one of four, resolved by the supervisor and
 * exported as `HARBOR_BOOT_MODE` so repository hooks can adapt to it.
 *
 * The distinction is not bookkeeping: `setup.sh` runs in `build` and `fresh` but
 * not in `repo_image` (where it already ran at build time) or `snapshot_restore`
 * (where its output is in the filesystem). Getting this wrong means either
 * installing dependencies twice or not at all.
 */
export const BOOT_MODES = ["build", "fresh", "repo_image", "snapshot_restore"] as const;
export type BootMode = (typeof BOOT_MODES)[number];

/**
 * Where a `build` bakes the checkout + dependencies, and where a `repo_image` boot
 * copies them from.
 *
 * NOT `/workspace`. The sandbox image declares `/workspace` a `VOLUME`, and a volume
 * is invisible to `docker commit` — anything a build writes there lands in a throwaway
 * anonymous volume the image never sees, and a later `docker run` masks it with a fresh
 * empty one. So a build provisions into this ordinary (non-volume) path, which the
 * commit captures, and a `repo_image` boot copies it into the real workspace volume
 * once, replacing the clone + install a fresh boot would pay over the network. Shared
 * between the builder (which sets `HARBOR_WORKSPACE_ROOT` to it) and the supervisor
 * (which copies out of it), so the two cannot disagree about the path.
 */
export const BAKED_WORKSPACE_ROOT = "/opt/harbor/baked";

/**
 * What a provider can do, declared rather than assumed.
 *
 * The alternative is a lowest-common-denominator interface where every provider
 * implements every method and half of them throw. That collapses two genuinely
 * different resume strategies into one shape that fits neither: snapshot-capable
 * backends restore a *new* box from saved filesystem state, while persistent
 * backends stop and later restart *the same* box. Both are correct; they are not
 * the same operation, and a manager that branches on capability can use each
 * properly.
 */
export interface SandboxCapabilities {
	/** The provider will stop the box itself after an idle timeout. */
	supportsSandboxTimeout: boolean;
	/** Filesystem state can be captured for later restore. */
	supportsSnapshots: boolean;
	/** A new box can be created from a previously captured snapshot. */
	supportsRestore: boolean;
	/** The same box can be stopped and started again, keeping its disk. */
	supportsPersistentResume?: boolean;
	/** Stopping is an explicit API call rather than a timeout side effect. */
	supportsExplicitStop?: boolean;
	/** Ports inside the box can be published on a reachable URL. */
	supportsTunnels?: boolean;
}

// ---------------------------------------------------------------------------
// The session event stream
// ---------------------------------------------------------------------------

/**
 * Everything that can appear on a session's timeline.
 *
 * Closed, and short on purpose. The temptation with an event log is to mint a
 * type per interesting moment, and within a year no consumer handles them all,
 * so the UI quietly renders nothing for a third of the stream. Fine-grained
 * detail belongs in `payload`; the *type* is what a consumer switches on and it
 * has to stay small enough that a switch covering all of it fits on a screen.
 */
export const SESSION_EVENT_TYPES = [
	/** The room exists. Always seq 1. */
	"session_created",
	/** Somebody added a prompt to the queue. Carries the author. */
	"prompt_queued",
	/** The runner took a prompt off the queue and handed it to an agent. */
	"prompt_delivered",
	/** A prompt finished — normally, or by an explicit stop. */
	"prompt_finished",
	"sandbox_requested",
	"sandbox_spawning",
	"sandbox_ready",
	"sandbox_failed",
	"sandbox_stopped",
	/** Filesystem state was captured. Carries the snapshot handle and provider. */
	"sandbox_snapshotted",
	/**
	 * Events were dropped between the sandbox and Harbor — the bridge's buffer
	 * overflowed during a partition. The hole is in the record, visibly, rather
	 * than hidden from it. Carries `dropped_events` and the window's bounds.
	 */
	"transcript_gap",
	/** Prose from the agent, streamed. */
	"agent_message",
	/** A tool the agent called. `payload` is bounded; this is not a log pipeline. */
	"agent_tool_call",
	/** The agent finished its turn. */
	"agent_finished",
	/** A branch, a PR, a screenshot, a file. */
	"artifact_created",
	/** Policy refused something. Visible, never silent — see the note below. */
	"policy_denied",
	/** A budget ran out and the session was paused. */
	"budget_exhausted",
	/** Harbor itself broke. Distinct from the agent failing at its task. */
	"session_error",
	/** A participant opened the link, or an agent attached. */
	"participant_joined",
] as const;
export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

/**
 * One entry on a session's timeline.
 *
 * `seq` is monotonic within a session and is the whole basis of lossless
 * reconnection: a client that holds `seq` knows exactly what it has, and a
 * replayed event it already applied is discarded by number rather than by
 * guessing from a timestamp. It comes from a counter on the session row bumped
 * with `UPDATE ... RETURNING`, never from `max(seq) + 1` — see the note on
 * `sessions.nextSeq` in the schema for the race that kills.
 */
export interface SessionEvent {
	id: string;
	session_id: string;
	seq: number;
	type: SessionEventType;
	/** Bounded. A tool call's output is truncated before it gets here. */
	payload: Record<string, unknown> | null;
	/** Who or what caused it: a human handle, an agent id, or `harbor`. */
	actor: string | null;
	created_at: string;
}

/**
 * What a client receives the instant it attaches, before any live event.
 *
 * **The guarantee is convergence, not exactly-once delivery**, and the
 * distinction is not pedantry — it is the difference between a promise the
 * transport can keep and one it cannot. A socket can drop after the server has
 * written an event and before the client has applied it. Without an
 * acknowledgement protocol the server cannot know which of those two happened,
 * so "every event exactly once" is unimplementable over any transport we would
 * actually ship. Claiming it anyway produces code that looks correct and a client
 * that is subtly wrong under exactly the conditions reconnection exists for.
 *
 * What is promised instead, and what the tests assert:
 *
 *  1. A snapshot **replaces** canonical client state; it is not merged into it.
 *  2. It carries `snapshot_through_seq`. Everything at or below that number is
 *     already reflected in this payload.
 *  3. Live events carry stable `id` and `seq` and are applied **idempotently** —
 *     re-applying one is a no-op, so a duplicate costs nothing and a client need
 *     never reason about whether it has seen something before.
 *  4. Events below `retained_from_seq` have been compacted and are explicitly
 *     **no longer individually replayable**. This is stated in the payload rather
 *     than discovered by a client that asks for them and gets silence.
 *  5. `truncated` means the snapshot was capped; the rest is fetched by page.
 *     Reconnect storms on a flaky network would otherwise mean repeatedly
 *     shipping the largest payload in the system.
 *
 * Together those make the client's state converge to the server's regardless of
 * what the network did, which is the property anyone actually wanted.
 *
 * Sandbox credentials are deliberately absent. They are fetched from an
 * authenticated endpoint and never travel in a snapshot or a broadcast, so a
 * snapshot can be logged, cached or replayed without leaking a token — a
 * snapshot bug leaks state, never secrets, and those are different severities.
 */
export interface SessionSnapshot {
	session: {
		id: string;
		key: string;
		title: string;
		status: string;
		created_by: string;
		created_at: string;
		last_activity_at: string;
		repo_id: string | null;
		environment_id: string | null;
		base_branch: string | null;
	};
	/** Everything at or below this seq is reflected in this payload. */
	snapshot_through_seq: number;
	/**
	 * The oldest seq still individually replayable. Events below it were compacted
	 * into summarised turns and cannot be fetched one by one, ever.
	 */
	retained_from_seq: number;
	/** The snapshot hit its size cap. `events` is the tail; page back for the rest. */
	truncated: boolean;
	events: SessionEvent[];
	participants: Array<{ participant: string; kind: string; last_seen_at: string }>;
	prompts: Array<{
		seq: number;
		author: string;
		author_kind: string;
		body: string;
		status: string;
		created_at: string;
	}>;
	sandbox: {
		id: string;
		status: SandboxStatus;
		provider: string;
		boot_mode: BootMode | null;
	} | null;
	artifacts: Array<{
		id: string;
		kind: ArtifactKind;
		title: string;
		url: string | null;
		created_at: string;
	}>;
}

// ---------------------------------------------------------------------------
// Bridge protocol — sandbox ⇄ control plane
// ---------------------------------------------------------------------------

/**
 * What the bridge sends up.
 *
 * HTTP POST up, SSE down. Not WebSockets, and that is a deployment decision
 * rather than a technical preference: a background agent platform has to survive
 * being put behind whatever load balancer, corporate proxy or ingress controller
 * the adopting company already runs, and every one of those handles POST and SSE
 * without configuration while a fraction of them mangle a protocol upgrade. The
 * traffic is also asymmetric enough that a duplex channel buys little — thousands
 * of events up, a handful of commands down.
 */
export const SANDBOX_EVENT_TYPES = [
	"boot_started",
	"boot_progress",
	"boot_ready",
	"boot_failed",
	"heartbeat",
	"agent_message",
	"agent_tool_call",
	"agent_finished",
	"agent_failed",
	"branch_pushed",
	"snapshot_taken",
	"log",
] as const;
export type SandboxEventType = (typeof SANDBOX_EVENT_TYPES)[number];

export interface SandboxEvent {
	type: SandboxEventType;
	sandbox_id: string;
	session_id: string;
	trace_id?: string;
	/** Bounded by the ingest path, not by the sender's goodwill. */
	payload?: Record<string, unknown>;
	/** ISO 8601. The sandbox's clock, used for display only — never for ordering. */
	at?: string;
}

/** What the control plane sends down. Four verbs; that is the whole vocabulary. */
export const BRIDGE_COMMANDS = ["prompt", "stop", "snapshot", "shutdown"] as const;
export type BridgeCommandType = (typeof BRIDGE_COMMANDS)[number];

export interface BridgeCommand {
	type: BridgeCommandType;
	session_id: string;
	trace_id?: string;
	prompt?: {
		id: string;
		seq: number;
		body: string;
		/**
		 * Who asked. Carried all the way through so the commit is authored by the
		 * human rather than by a bot — the bridge sets `git config user.*` from this
		 * before each prompt, which is why a multiplayer session produces correctly
		 * attributed history instead of a wall of identical bot commits.
		 */
		author: string;
		author_email: string | null;
		/**
		 * The control plane's explicit statement about authorship, and the field
		 * that lets a turn run at all when no email is on file. `agent-only` is a
		 * STATEMENT — "nobody claims authorship of these commits" — not a guess
		 * the sandbox makes; `identityForPrompt` in the bridge refuses a prompt
		 * with neither a complete identity nor this mode, precisely so the
		 * control plane cannot half-attribute by accident. Before this field was
		 * sent, every attributed prompt was refused end to end, because
		 * `author_email` was always null and no mode said that was deliberate.
		 */
		mode?: "agent-only" | "attributed-user";
		/**
		 * Where this turn's commits are pushed, resolved **per turn** rather than
		 * baked into the box's environment at spawn.
		 *
		 * Per turn because the branch is derived from a lease, and a box outlives
		 * the lease that booted it: `completeTurn` hands the lease back whenever the
		 * queue drains, so a session's third prompt runs under a claim id its
		 * sandbox has never heard of. A spawn-time variable would still name the
		 * first lease, and a spawn *retried* under a new lease would push to the old
		 * lease's branch — the failure `harborBranchName` warns about in its own
		 * docstring.
		 *
		 * Resolved as `session_repos.working_branch ?? harborBranchName(claim)`, so
		 * the first push names the lease the work began under and every later turn
		 * reuses it. Null means this deployment has no branch to push to; the turn
		 * runs, and nothing is pushed.
		 */
		push_branch?: string | null;
		/** What the branch was cut from. For the PR's base and the compare URL. */
		base_branch?: string | null;
	};
}

// ---------------------------------------------------------------------------
// Spawn admission — fencing and the idempotent saga
// ---------------------------------------------------------------------------

/**
 * Why "exactly one sandbox per unit of work" is not a promise we make.
 *
 * Claiming a lease in Postgres before calling a sandbox provider prevents
 * *ordinary* concurrent duplication: two agents racing for the same task, one
 * winner, one container. That is worth having and it is the reason claim-before-
 * spawn is the admission mechanism. But it does not survive the four ambiguous
 * failures, and pretending otherwise is how you ship a guarantee that quietly is
 * not one:
 *
 *   1. We crash after acquiring the lease and before contacting the provider.
 *   2. The provider creates the box and its response is lost in transit.
 *   3. We retry after the box exists but before we persisted its id.
 *   4. The lease expires while the original holder is genuinely still running.
 *
 * Cases 2 and 3 are indistinguishable from the caller's side without asking the
 * provider what it actually has. So the achievable property — and the one the
 * tests assert — is:
 *
 *   > **At most one *active* sandbox per lease, including after ambiguous failures.**
 *
 * The mechanism has three parts:
 *
 *   - **A spawn intent is persisted before the provider call**, carrying an
 *     `attempt_id`. That id is passed to the provider as a label or tag, so an
 *     orphan created by a lost response is discoverable rather than invisible.
 *   - **Reconciliation queries the provider by `attempt_id`** before spawning
 *     again. A box we already made is adopted, not duplicated.
 *   - **A fencing token** — a monotonically increasing integer per lease — is
 *     checked by every privileged side effect. A box whose token is stale cannot
 *     push a branch, open a PR or write to the transcript, even if it is still
 *     running and still believes it holds the work. Case 4 becomes harmless
 *     rather than a second agent pushing to the same branch.
 */
export interface SpawnIntent {
	attempt_id: string;
	claim_id: string | null;
	session_id: string;
	/** Increments per spawn attempt for this lease. Checked by every side effect. */
	fencing_token: number;
	provider: string;
	requested_at: string;
}

/**
 * Every way a spawn attempt can end. Exhaustive on purpose — callers switch on
 * this with no `default`, so a new outcome is a compile error at each decision
 * point rather than a silently unhandled case.
 */
export type SpawnOutcome =
	| { kind: "created"; sandbox_id: string; external_id: string }
	| { kind: "adopted"; sandbox_id: string; external_id: string; reason: "reconciled_orphan" }
	| { kind: "refused"; reason: SpawnRefusal }
	| { kind: "failed"; error_type: ProviderErrorType; message: string };

/**
 * Typed reasons, never booleans — and note that "denied" and "could not
 * determine" are separate members.
 *
 * Collapsing those two is a specific, well-known bug with two failure modes and
 * no good one. Treat "could not determine" as allowed and an upstream blip opens
 * a hole; treat it as denied and an upstream blip is a total outage. Keeping them
 * distinct lets each caller pick, and the two callers here pick differently on
 * purpose: **liveness fails open, authority fails closed.**
 */
export type SpawnRefusal =
	| "circuit_open"
	| "budget_exhausted"
	| "policy_denied"
	| "queue_full"
	| "lease_not_held"
	| "lease_state_unknown"
	| "session_paused"
	| "already_active";

/**
 * How a provider failure is classified, because the circuit breaker must treat
 * these differently. A transient 503 should count towards opening the circuit; a
 * permanent "that image does not exist" should not, since retrying it a hundred
 * times across a hundred sessions helps nobody and opening the circuit hides an
 * unrelated real outage behind a configuration error.
 */
export const PROVIDER_ERROR_TYPES = [
	"transient",
	"rate_limited",
	"quota_exceeded",
	"invalid_config",
	"not_found",
	"unauthorized",
	"unknown",
] as const;
export type ProviderErrorType = (typeof PROVIDER_ERROR_TYPES)[number];

/** Which of those count towards tripping the breaker. Configuration, not opinion. */
export const CIRCUIT_TRIPPING_ERROR_TYPES: readonly ProviderErrorType[] = [
	"transient",
	"rate_limited",
	"quota_exceeded",
	"unknown",
];

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

/**
 * What a session produces. Closed, because the dashboard renders each kind
 * differently and an unknown kind renders as nothing.
 */
export const ARTIFACT_KINDS = ["branch", "pull_request", "screenshot", "file", "log"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

// ---------------------------------------------------------------------------
// Client → control plane
// ---------------------------------------------------------------------------

export const CLIENT_MESSAGE_TYPES = ["prompt", "stop", "join", "warm"] as const;
export type ClientMessageType = (typeof CLIENT_MESSAGE_TYPES)[number];

/**
 * Note what is missing: there is no `author` field a client can set.
 *
 * The author of a prompt comes from the signed-in viewer on the server, always.
 * A client that can name its own author can put words in a colleague's mouth in a
 * shared room, and the record of who asked for a change is the thing multiplayer
 * sessions exist to keep honest.
 */
export interface ClientMessage {
	type: ClientMessageType;
	session_key: string;
	body?: string;
	trace_id?: string;
}

// ---------------------------------------------------------------------------
// Routing — connectors resolving an inbound message to a target
// ---------------------------------------------------------------------------

/**
 * Where an inbound Slack message, Linear issue or GitHub comment should run.
 *
 * `unknown` is a first-class result and not an error. A router that always
 * returns a guess will confidently start a session against the wrong repository,
 * and the cost of that is a stranger's branch with an agent's commits on it. Ours
 * asks instead — one Block Kit picker, one click — which is slower exactly once
 * and correct every time.
 */
export type RouteTarget =
	| { kind: "repo"; repo_id: string; confidence: RouteConfidence; reason: string }
	| { kind: "environment"; environment_id: string; confidence: RouteConfidence; reason: string }
	| { kind: "unknown"; candidates: Array<{ id: string; kind: "repo" | "environment"; label: string }> };

/**
 * How the target was decided, in descending order of trust.
 *
 * The order matters because it is also the resolution order: an explicit target
 * beats a mapping, a mapping beats a keyword, and only then does a model get
 * asked. Most inbound traffic resolves before any of it costs a token, which is
 * what lets a deployment with no model key configured still route.
 */
export const ROUTE_CONFIDENCES = ["explicit", "mapping", "keyword", "classified"] as const;
export type RouteConfidence = (typeof ROUTE_CONFIDENCES)[number];
