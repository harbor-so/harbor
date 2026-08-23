// SPDX-License-Identifier: Apache-2.0
/**
 * Every tunable in Harbor, in one file, resolved at call time.
 *
 * The rule this file exists to enforce: **no timeout, threshold or limit is a
 * module-level constant anywhere else in the codebase.** `scripts/lint-config.mjs`
 * fails the build on one, and there is a test asserting that lint rule's error
 * message so the rule itself cannot rot into a no-op.
 *
 * The reason is a specific, predictable adopter experience. A self-hoster whose
 * monorepo legitimately takes four minutes to boot hits a ninety-second default
 * on their first day. If that number is `const BOOT_TIMEOUT_MS = 90_000` halfway
 * down a lifecycle file, their options are to fork the project or to give up, and
 * most people give up. Every number here is therefore an environment variable
 * with a documented default, and additionally overridable per repository — because
 * one slow repo should not force the whole deployment to wait four minutes for
 * every other one.
 *
 * Resolution order, most specific wins:
 *
 *     repos.config[key]  →  process.env[HARBOR_*]  →  the default below
 *
 * Two further disciplines:
 *
 *  - **Every default has its derivation written down.** "Stale heartbeat is three
 *    times the heartbeat interval" is a fact somebody can check and adjust
 *    coherently. "30000" is a number nobody will ever dare touch.
 *  - **Relationships are validated at startup** by `validateConfig()`, which fails
 *    fast on an incoherent combination. A stale-heartbeat threshold shorter than
 *    the heartbeat interval means every healthy sandbox is killed as unhealthy —
 *    an outage that presents as "the product does not work" with nothing in the
 *    logs pointing at configuration.
 */

/**
 * One tunable, with everything needed to resolve, document and validate it.
 *
 * `derivation` is not a comment. It is displayed by `GET /api/health/config`, so
 * an operator reading their live configuration sees why 90 seconds was chosen
 * rather than having to find this file.
 */
interface Setting<T> {
	env: string;
	fallback: T;
	derivation: string;
	parse: (raw: string) => T;
}

const asInt = (raw: string): number => {
	const value = Number(raw);
	if (!Number.isFinite(value) || !Number.isInteger(value)) {
		throw new ConfigError(`expected an integer, got ${JSON.stringify(raw)}`);
	}
	return value;
};

const asBool = (raw: string): boolean => raw === "1" || raw.toLowerCase() === "true";

const asString = (raw: string): string => raw;

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

/**
 * The registry. Adding a tunable means adding it here — which is the point,
 * because it then appears in the health endpoint and in the generated docs
 * without anybody remembering to write them.
 */
export const SETTINGS = {
	// -- Sandbox lifecycle ---------------------------------------------------

	sandboxBootTimeoutMs: {
		env: "HARBOR_SANDBOX_BOOT_TIMEOUT_MS",
		fallback: 480_000,
		derivation:
			"A fresh boot is clone + setup.sh + start.sh. The setup hook's own budget is "
			+ "five minutes and the start hook's is two, so the outer timeout is their sum "
			+ "plus a minute of headroom for the clone — validateConfig() enforces that "
			+ "relationship, because an outer timeout smaller than the hooks' own budgets "
			+ "kills a repository that is behaving exactly as configured and blames the "
			+ "hooks. Too tight is worse than too loose here: a boot killed early looks "
			+ "like the platform is broken, while an extra minute looks like a slow repo.",
		parse: asInt,
	} satisfies Setting<number>,

	sandboxHeartbeatIntervalMs: {
		env: "HARBOR_SANDBOX_HEARTBEAT_INTERVAL_MS",
		fallback: 15_000,
		derivation:
			"How often the bridge says it is alive. Frequent enough that a dead box is "
			+ "noticed within a minute, infrequent enough that a thousand sandboxes "
			+ "produce ~66 writes/second rather than a write storm.",
		parse: asInt,
	} satisfies Setting<number>,

	sandboxStaleHeartbeatMs: {
		env: "HARBOR_SANDBOX_STALE_HEARTBEAT_MS",
		fallback: 45_000,
		derivation:
			"Three times the heartbeat interval. Two would declare a box dead on a "
			+ "single dropped packet plus one slow tick, which on a busy provider "
			+ "happens daily; three tolerates one loss and one delay. Validated at "
			+ "startup to be strictly greater than the interval, because a value below "
			+ "it kills every healthy sandbox and presents as 'nothing works'.",
		parse: asInt,
	} satisfies Setting<number>,

	sandboxInactivityTimeoutMs: {
		env: "HARBOR_SANDBOX_INACTIVITY_TIMEOUT_MS",
		fallback: 2_100_000,
		derivation:
			"One full agent turn (thirty minutes) plus five minutes of human follow-up "
			+ "before the box is snapshotted and stopped. It must exceed the turn timeout "
			+ "— validateConfig() enforces this — because a long turn that is working "
			+ "correctly emits no prompts and must not be reaped as idle. Short enough "
			+ "that an abandoned session does not bill for an hour. This is the single "
			+ "largest lever on cost in the whole system.",
		parse: asInt,
	} satisfies Setting<number>,

	agentTurnTimeoutMs: {
		env: "HARBOR_AGENT_TURN_TIMEOUT_MS",
		fallback: 1_800_000,
		derivation:
			"Thirty minutes for one prompt. Matches the default claim lease so a turn "
			+ "cannot outlive the lease that authorises it — if these disagree, an agent "
			+ "keeps working after its lease lapsed and another agent legitimately takes "
			+ "the same task. validateConfig() enforces turn <= lease at startup.",
		parse: asInt,
	} satisfies Setting<number>,

	gitPushTimeoutMs: {
		env: "HARBOR_GIT_PUSH_TIMEOUT_MS",
		fallback: 120_000,
		derivation:
			"Two minutes, and it bounds the local inspections as well as the push itself. "
			+ "A push runs after the agent has already finished, so the user is watching a "
			+ "turn that looks complete — a hang here reads as the product being stuck at "
			+ "the very last step. Two minutes covers a first push of a large branch over a "
			+ "slow link; beyond that the honest answer is to report the failure and leave "
			+ "the commits in the box rather than to keep a finished turn open.",
		parse: asInt,
	} satisfies Setting<number>,

	// -- Leases ----------------------------------------------------------------

	leaseMinutes: {
		env: "HARBOR_LEASE_MINUTES",
		fallback: 30,
		derivation:
			"The default claim lease, in minutes. Thirty matches the agent turn timeout "
			+ "— a lease that expires mid-turn means two agents on one task, and a lease "
			+ "much longer than a turn means a dead agent's task reads as claimed for "
			+ "the difference. validateConfig() enforces turn <= lease at startup.",
		parse: asInt,
	} satisfies Setting<number>,

	maxLeaseMinutes: {
		env: "HARBOR_MAX_LEASE_MINUTES",
		fallback: 480,
		derivation:
			"The ceiling on any lease an agent can request, in minutes. Eight hours is a "
			+ "working day: long enough for a legitimately long-running migration task, "
			+ "short enough that a claim taken by an agent that then died does not park "
			+ "the task until somebody notices. A request above this is clamped, not "
			+ "refused — the agent asked for 'a long time' and gets the longest allowed.",
		parse: asInt,
	} satisfies Setting<number>,

	// -- Circuit breaker -----------------------------------------------------

	circuitFailureThreshold: {
		env: "HARBOR_CIRCUIT_FAILURE_THRESHOLD",
		fallback: 3,
		derivation:
			"Three consecutive tripping failures opens the circuit. One is noise, two "
			+ "is a coincidence often enough to matter, three inside the window is a "
			+ "dependency that is down.",
		parse: asInt,
	} satisfies Setting<number>,

	circuitWindowMs: {
		env: "HARBOR_CIRCUIT_WINDOW_MS",
		fallback: 300_000,
		derivation:
			"Failures older than five minutes stop counting. Without a window the "
			+ "counter is cumulative and the circuit eventually opens on a service that "
			+ "has been healthy for a week.",
		parse: asInt,
	} satisfies Setting<number>,

	circuitCooldownMs: {
		env: "HARBOR_CIRCUIT_COOLDOWN_MS",
		fallback: 60_000,
		derivation:
			"How long the circuit stays open before one probe is allowed through. A "
			+ "minute is long enough for a provider restart, short enough that a "
			+ "recovered provider is discovered before a human notices.",
		parse: asInt,
	} satisfies Setting<number>,

	// -- Queue ---------------------------------------------------------------

	maxQueueDepth: {
		env: "HARBOR_MAX_QUEUE_DEPTH",
		fallback: 50,
		derivation:
			"Prompts waiting on one session. A cap exists because automations and child "
			+ "sessions both enqueue programmatically, which is a genuine amplification "
			+ "path — a misconfigured hourly automation with a retry loop can enqueue "
			+ "without bound, and the failure presents as a session that will not stop "
			+ "working days after anyone asked it to.",
		parse: asInt,
	} satisfies Setting<number>,

	// -- Event stream --------------------------------------------------------

	maxSnapshotEvents: {
		env: "HARBOR_MAX_SNAPSHOT_EVENTS",
		fallback: 500,
		derivation:
			"Events in one snapshot before it is truncated and the client pages for "
			+ "the rest. A snapshot is sent on every connect and reconnect, so on a "
			+ "flaky mobile connection it is the most-repeated payload in the system; "
			+ "uncapped, its size grows with the age of the session forever.",
		parse: asInt,
	} satisfies Setting<number>,

	eventRetentionCount: {
		env: "HARBOR_EVENT_RETENTION_COUNT",
		fallback: 5_000,
		derivation:
			"Events kept at full fidelity per session. Beyond this, token-level events "
			+ "are compacted into summarised turns and the originals deleted. A session "
			+ "streaming for two days otherwise grows without bound, and the bound is "
			+ "not theoretical: it is the same rows every snapshot has to read past.",
		parse: asInt,
	} satisfies Setting<number>,

	maxEventPayloadChars: {
		env: "HARBOR_MAX_EVENT_PAYLOAD_CHARS",
		fallback: 8_000,
		derivation:
			"A tool call's captured output is truncated to this before it is stored. "
			+ "The timeline is a timeline; a build log belongs in the run output, and "
			+ "the difference is what stops this table becoming a log pipeline the "
			+ "schema never signed up to be.",
		parse: asInt,
	} satisfies Setting<number>,

	maxActivityPayloadChars: {
		env: "HARBOR_MAX_ACTIVITY_PAYLOAD_CHARS",
		fallback: 16_000,
		derivation:
			"The backstop on one activity row's payload. Normalizers already clip "
			+ "individual strings; this catches a payload that is wide rather than deep — "
			+ "many small fields — which no per-field cap sees. Higher than the timeline's "
			+ "cap because activity carries structured tool arguments rather than prose.",
		parse: asInt,
	} satisfies Setting<number>,

	// -- Chat ----------------------------------------------------------------

	chatMaxContentChars: {
		env: "HARBOR_CHAT_MAX_CONTENT_CHARS",
		fallback: 8_000,
		derivation:
			"The longest a single chat message body may be before ingest refuses it. "
			+ "Long enough for a pasted stack trace or a diff hunk, short enough that one "
			+ "signed message cannot push megabytes through the event log or overrun a "
			+ "NOTIFY. A self-hoster who wants terser or roomier rooms changes it here.",
		parse: asInt,
	} satisfies Setting<number>,

	// -- Bridge --------------------------------------------------------------

	bridgeBufferLimit: {
		env: "HARBOR_BRIDGE_BUFFER_LIMIT",
		fallback: 1_000,
		derivation:
			"Events the bridge holds while disconnected from the control plane. "
			+ "Unbounded buffering OOMs the sandbox during a long partition and takes "
			+ "the agent's work with it; silently dropping puts an invisible hole in "
			+ "the record. At the cap the oldest are dropped and a visible gap marker "
			+ "is emitted, so the hole is in the record rather than hidden from it.",
		parse: asInt,
	} satisfies Setting<number>,

	credentialCacheMs: {
		env: "HARBOR_CREDENTIAL_CACHE_MS",
		fallback: 5_000,
		derivation:
			"How long the in-sandbox git credential helper reuses a brokered "
			+ "credential. Deliberately seconds, not minutes: long enough that a `git "
			+ "push` making several authenticated calls does not make several round "
			+ "trips and does not fail on a brief control-plane blip, short enough that "
			+ "a revoked installation stops working almost immediately. That coupling "
			+ "is the trade and it is why this is not zero.",
		parse: asInt,
	} satisfies Setting<number>,

	tunnelWaitMs: {
		env: "HARBOR_TUNNEL_WAIT_MS",
		fallback: 30_000,
		derivation:
			"How long the supervisor waits for tunnel URLs before running start.sh "
			+ "anyway. On timeout it logs and proceeds — degradation here is local and "
			+ "recoverable, and failing a boot because a port forward was slow would "
			+ "trade a minor inconvenience for a total one.",
		parse: asInt,
	} satisfies Setting<number>,

	// -- Hooks ---------------------------------------------------------------

	setupTimeoutMs: {
		env: "HARBOR_SETUP_TIMEOUT_MS",
		fallback: 300_000,
		derivation:
			"`.harbor/setup.sh` — dependency installation, which for a large monorepo "
			+ "is minutes. Non-fatal on a fresh boot: a broken provisioning step still "
			+ "leaves a usable box, and the warning is surfaced rather than swallowed.",
		parse: asInt,
	} satisfies Setting<number>,

	startTimeoutMs: {
		env: "HARBOR_START_TIMEOUT_MS",
		fallback: 120_000,
		derivation:
			"`.harbor/start.sh` — starting services the agent needs. Strict: a failure "
			+ "fails the boot. The asymmetry with setup.sh is deliberate. A broken "
			+ "runtime step means the agent works in an environment that lies to it, "
			+ "and confidently wrong work is more expensive than no work.",
		parse: asInt,
	} satisfies Setting<number>,

	// -- Cost ----------------------------------------------------------------

	maxSpendPerDayMicroUsd: {
		env: "HARBOR_MAX_SPEND_PER_DAY_MICRO_USD",
		fallback: 50_000_000,
		derivation:
			"$50/day per organisation, in millionths of a dollar. A default rather than "
			+ "unlimited, because every amplification path in this system is a loop with "
			+ "no human in it. On breach Harbor stops admitting new claims and does not "
			+ "kill running work — killing mid-turn wastes everything already spent.",
		parse: asInt,
	} satisfies Setting<number>,

	sandboxSpawnEstimateMicroUsd: {
		env: "HARBOR_SANDBOX_SPAWN_ESTIMATE_MICRO_USD",
		fallback: 0,
		derivation:
			"The budget reservation taken before each spawn, in millionths of a dollar. "
			+ "Zero by default — an honest zero, because Harbor cannot know what a "
			+ "sandbox-hour costs on the operator's infrastructure, and inventing a "
			+ "number would make the spend report confidently wrong. An operator who "
			+ "knows their per-spawn cost raises this so the daily cap actually gates "
			+ "spawns rather than only the token spend recorded after the fact.",
		parse: asInt,
	} satisfies Setting<number>,

	// -- Dashboard -------------------------------------------------------------

	sessionCookieMaxAgeSeconds: {
		env: "HARBOR_SESSION_COOKIE_MAX_AGE_SECONDS",
		fallback: 2_592_000,
		derivation:
			"Thirty days before a dashboard sign-in expires. A security-posture choice, "
			+ "not a technical one, which is exactly why it is a knob: an SSO shop wants "
			+ "hours, a solo self-hoster wants to never think about it. The cookie is "
			+ "HMAC-signed and revocation is by rotating AUTH_SECRET, so a shorter age "
			+ "is the only per-user lever an operator has.",
		parse: asInt,
	} satisfies Setting<number>,

	// -- Triggers (inbound event automations) --------------------------------

	triggerMaxBodyBytes: {
		env: "HARBOR_TRIGGER_MAX_BODY_BYTES",
		fallback: 1_000_000,
		derivation:
			"The largest inbound trigger payload accepted before a 413. Matches the "
			+ "connector webhook cap, and for the same reason: the HMAC signature is "
			+ "computed over the whole body, so an unbounded body is an unauthenticated "
			+ "way to make the server hash megabytes before it can reject the request.",
		parse: asInt,
	} satisfies Setting<number>,

	triggerReplayWindowSeconds: {
		env: "HARBOR_TRIGGER_REPLAY_WINDOW_SECONDS",
		fallback: 60 * 5,
		derivation:
			"How far a signed delivery timestamp (Sentry's `sentry-hook-timestamp`) may "
			+ "deviate from now, in either direction, before it is treated as a replay. "
			+ "Mirrors the Slack connector's five-minute window: generous enough for clock "
			+ "skew between the sender and this deployment, tight enough that a captured "
			+ "delivery is not a sandbox-spawning primitive forever. `Math.abs`, so a "
			+ "future-stamped delivery is rejected too — a one-sided check is forgeable by "
			+ "whoever controls the timestamp being signed over.",
		parse: asInt,
	} satisfies Setting<number>,

	triggerMaxRunsPerMinutePerAutomation: {
		env: "HARBOR_TRIGGER_MAX_RUNS_PER_MINUTE_PER_AUTOMATION",
		fallback: 10,
		derivation:
			"The most sessions one event automation may start per minute. Cron is "
			+ "naturally bounded to once a minute; an inbound webhook or a chatty Sentry "
			+ "project is not, so a retry storm is a genuine amplification path with no "
			+ "human in it. Above this, deliveries are shed — recorded, not fired — the "
			+ "same class of protection maxQueueDepth gives the enqueue path, and a "
			+ "cheaper stop than waiting for the daily spend cap to catch a runaway.",
		parse: asInt,
	} satisfies Setting<number>,

	// -- Coordination --------------------------------------------------------

	presenceWindowMs: {
		env: "HARBOR_PRESENCE_WINDOW_MS",
		fallback: 90_000,
		derivation:
			"How long after its last call an agent still counts as present. Presence is "
			+ "a byproduct of the five coordination calls rather than a heartbeat, so the "
			+ "window has to be longer than the gap between an agent's calls — a minute "
			+ "and a half tolerates an agent that is thinking rather than calling.",
		parse: asInt,
	} satisfies Setting<number>,

	claimSweepIntervalMs: {
		env: "HARBOR_CLAIM_SWEEP_INTERVAL_MS",
		fallback: 60_000,
		derivation:
			"How often lapsed leases are swept back to open. A backstop, not the "
			+ "mechanism — claim() already expires a stale holder before it inserts, so "
			+ "correctness never depends on this running. What it buys is timeliness: a "
			+ "task whose agent died reads as open in the dashboard within a minute.",
		parse: asInt,
	} satisfies Setting<number>,

	deadlineSweepIntervalMs: {
		env: "HARBOR_DEADLINE_SWEEP_INTERVAL_MS",
		fallback: 15_000,
		derivation:
			"How often sandbox deadlines — inactivity, stale heartbeats, boot timeouts, "
			+ "execution timeouts — are checked. One heartbeat interval: checking faster "
			+ "than heartbeats arrive learns nothing new, and checking much slower adds "
			+ "the gap to every timeout's effective latency. validateConfig() enforces "
			+ "that this is well below the inactivity timeout, because a sweep interval "
			+ "near the timeout it enforces makes the timeout meaningless.",
		parse: asInt,
	} satisfies Setting<number>,

	sessionTickIntervalMs: {
		env: "HARBOR_SESSION_TICK_INTERVAL_MS",
		fallback: 2_000,
		derivation:
			"How often sessions with queued prompts are advanced. This is the latency a "
			+ "prompt waits when no request-path tick picked it up, so it is the most "
			+ "user-visible interval in the system: two seconds reads as 'the agent is "
			+ "starting', ten reads as 'it is broken'. The tick is cheap when there is "
			+ "nothing to do — one indexed query — which is what allows it to be frequent.",
		parse: asInt,
	} satisfies Setting<number>,

	compactionSweepIntervalMs: {
		env: "HARBOR_COMPACTION_SWEEP_INTERVAL_MS",
		fallback: 300_000,
		derivation:
			"How often sessions over the retention count are compacted. Five minutes: "
			+ "compaction is a bound on growth, not a latency guarantee, and each pass "
			+ "costs real reads. The retention count already caps how far past the limit "
			+ "a session can get between passes at any sane event rate.",
		parse: asInt,
	} satisfies Setting<number>,

	orphanSweepIntervalMs: {
		env: "HARBOR_ORPHAN_SWEEP_INTERVAL_MS",
		fallback: 300_000,
		derivation:
			"How often the provider's live containers are reconciled against the "
			+ "database. Five minutes: an orphan costs its hourly rate, not correctness, "
			+ "and each pass lists every managed container. The sweep is the backstop "
			+ "for crash windows the saga cannot close on its own — a control plane that "
			+ "died between spawn and record — so it needs to run soon, not instantly.",
		parse: asInt,
	} satisfies Setting<number>,

	devinPollIntervalMs: {
		env: "HARBOR_DEVIN_POLL_INTERVAL_MS",
		fallback: 30_000,
		derivation:
			"How often tracked Devin sessions are polled for progress. Devin is a cloud "
			+ "agent with no hooks, so a pull is the only way to learn what it did, and "
			+ "its work is coarse and long-running — minutes to hours — so thirty seconds "
			+ "is timely without hammering a rate-limited third-party API. What actually "
			+ "bounds the API calls is not this interval but the per-tick batch cap and "
			+ "the `updated_at` short-circuit that skips a session nothing changed on.",
		parse: asInt,
	} satisfies Setting<number>,

	devinPollMaxPerTick: {
		env: "HARBOR_DEVIN_POLL_MAX_PER_TICK",
		fallback: 100,
		derivation:
			"How many Devin sessions a single poll tick will fetch. A cap on the calls "
			+ "one tick makes to Devin's API, mirroring the `.limit(100)` the automations "
			+ "tick uses on its due set. Rows are polled oldest-first, so a backlog larger "
			+ "than this drains over successive ticks rather than being dropped.",
		parse: asInt,
	} satisfies Setting<number>,

	// -- Coordination --------------------------------------------------------

	minIntentChars: {
		env: "HARBOR_MIN_INTENT_CHARS",
		fallback: 10,
		derivation:
			"Shortest intent a lease may be minted with. Intent is not documentation "
			+ "hygiene — it is the mechanism that makes reading the shared substrate "
			+ "cheaper than re-deriving it, so a lease without a real one is refused. Ten "
			+ "characters is enough to reject 'wip' and 'fix' while not demanding prose.",
		parse: asInt,
	} satisfies Setting<number>,

	suggestedAlternativesCount: {
		env: "HARBOR_SUGGESTED_ALTERNATIVES_COUNT",
		fallback: 3,
		derivation:
			"How many unclaimed tasks from the same project a losing claim is handed. A "
			+ "conflict is not an error — it is a fork in the road, and the agent needs "
			+ "somewhere to go. Three is enough to offer a choice without turning the "
			+ "refusal into its own listing.",
		parse: asInt,
	} satisfies Setting<number>,

	// -- Runs ----------------------------------------------------------------

	runOutputFlushMs: {
		env: "HARBOR_RUN_OUTPUT_FLUSH_MS",
		fallback: 1_000,
		derivation:
			"Output is buffered and flushed on a timer rather than written per chunk. A "
			+ "build log arrives in hundreds of small writes and one UPDATE each would "
			+ "swamp the database and the notify channel with nothing new to say.",
		parse: asInt,
	} satisfies Setting<number>,

	maxRunOutputChars: {
		env: "HARBOR_MAX_RUN_OUTPUT_CHARS",
		fallback: 200_000,
		derivation:
			"Bounded so a chatty agent cannot fill the database with one row. Past this "
			+ "the output is truncated with a visible marker rather than silently dropped.",
		parse: asInt,
	} satisfies Setting<number>,

	// -- Providers -----------------------------------------------------------

	sandboxProvider: {
		env: "HARBOR_SANDBOX_PROVIDER",
		fallback: "docker",
		derivation:
			"`docker` by default, and that is the strategic choice of the project. It "
			+ "is what lets someone evaluate the whole product on a laptop or inside a "
			+ "VPC with no vendor relationship at all. Remote providers are an upgrade, "
			+ "never a prerequisite.",
		parse: asString,
	} satisfies Setting<string>,

	sandboxImage: {
		env: "HARBOR_SANDBOX_IMAGE",
		fallback: "harbor-sandbox:latest",
		derivation: "The image the `docker` provider boots. Built by `npm run sandbox:build`.",
		parse: asString,
	} satisfies Setting<string>,

	enableSnapshots: {
		env: "HARBOR_ENABLE_SNAPSHOTS",
		fallback: false,
		derivation:
			"Off by default. Snapshot restore is a latency optimisation with real "
			+ "sharp edges — snapshots expire, some provider APIs are experimental, and "
			+ "on at least one provider snapshotting can terminate the source box. "
			+ "Shipping `fresh` only and letting an operator opt in is the honest "
			+ "default; shipping restore on by default means the first strange bug a "
			+ "new adopter hits is in the least observable part of the system.",
		parse: asBool,
	} satisfies Setting<boolean>,

	// -- Prebuilt repo images ------------------------------------------------

	imageBuildEnabled: {
		env: "HARBOR_IMAGE_BUILD_ENABLED",
		fallback: false,
		derivation:
			"Off by default, opt in per repository. Building an image on a schedule is "
			+ "a standing compute bill and a background loop with no human in it, so an "
			+ "operator who upgrades Harbor must see no new spend and no behaviour change "
			+ "until they deliberately turn it on for a repo whose cold start actually "
			+ "hurts. Set it in `repos.config` to enable one repo without enabling all.",
		parse: asBool,
	} satisfies Setting<boolean>,

	imageBuildIntervalMs: {
		env: "HARBOR_IMAGE_BUILD_INTERVAL_MS",
		fallback: 1_800_000,
		derivation:
			"Thirty minutes. It is the staleness "
			+ "bound on baked dependencies: a new dependency added to the repo is absent "
			+ "from the image until the next build, so this is the longest a session may "
			+ "boot with a slightly old lockfile installed. Shorter means fresher images "
			+ "and more build spend; longer means cheaper and staler. Must be at most "
			+ "`imageMaxAgeMs`, or every image is stale the moment it is published.",
		parse: asInt,
	} satisfies Setting<number>,

	imageMaxAgeMs: {
		env: "HARBOR_IMAGE_MAX_AGE_MS",
		fallback: 5_400_000,
		derivation:
			"Ninety minutes: three build intervals at the default cadence. The freshness "
			+ "cutoff a spawn applies before booting from a published image — older than "
			+ "this and the boot falls through to `fresh` rather than trust an image whose "
			+ "dependencies may have drifted. Three intervals tolerates two consecutively "
			+ "failed or skipped builds before sessions silently stop using the image; a "
			+ "value below `imageBuildIntervalMs` would make every image stale on arrival "
			+ "and quietly disable the feature, which `validateConfig` refuses.",
		parse: asInt,
	} satisfies Setting<number>,

	imageBaseImage: {
		env: "HARBOR_IMAGE_BASE_IMAGE",
		fallback: "",
		derivation:
			"The image a build starts FROM before running the repo's `setup.sh`. Empty "
			+ "means 'use `sandboxImage`', which is the right default: a prebuilt repo "
			+ "image is the base sandbox image with dependencies baked on top, so the two "
			+ "must not drift. Overridden per repo only when a repository genuinely needs "
			+ "a different toolchain base than the fleet default.",
		parse: asString,
	} satisfies Setting<string>,

	imageBuildTimeoutMs: {
		env: "HARBOR_IMAGE_BUILD_TIMEOUT_MS",
		fallback: 900_000,
		derivation:
			"Fifteen minutes. A build clones a repo and runs its `setup.sh`, which "
			+ "installs a full dependency tree — legitimately slower than a boot, so this "
			+ "is generous where `sandboxBootTimeoutMs` is tight. It is a backstop against "
			+ "a hung `setup.sh` holding the one active-build slot open forever, not a "
			+ "normal-case budget. Must be at least `sandboxBootTimeoutMs`.",
		parse: asInt,
	} satisfies Setting<number>,

	imageTickIntervalMs: {
		env: "HARBOR_IMAGE_TICK_INTERVAL_MS",
		fallback: 60_000,
		derivation:
			"How often the scheduler checks whether any repo's image is due. Cheap when "
			+ "there is nothing to do — one indexed query over `repo_images` — so it can "
			+ "be frequent without cost, and a minute keeps the actual build cadence close "
			+ "to `imageBuildIntervalMs` rather than quantised to a coarse tick.",
		parse: asInt,
	} satisfies Setting<number>,

	imageRetentionCount: {
		env: "HARBOR_IMAGE_RETENTION_COUNT",
		fallback: 2,
		derivation:
			"How many built images to keep per repo. Two: the current pointer plus one "
			+ "predecessor, so a session that spawned against the previous image just "
			+ "before a publish still finds its image on disk. Older images are pruned to "
			+ "bound disk, which otherwise grows by one image per repo every interval "
			+ "forever. Must be at least one, or a publish would prune the image it just "
			+ "published.",
		parse: asInt,
	} satisfies Setting<number>,

	autoSetupEnabled: {
		env: "HARBOR_AUTO_SETUP",
		fallback: true,
		derivation:
			"On by default, and this is the onboarding cost of the whole product. "
			+ "`.harbor/setup.sh` is optional and a missing one is silently skipped, "
			+ "which means every repository needs a hook written, committed and "
			+ "reviewed before an agent can run its tests — and for a JavaScript "
			+ "monorepo that hook is one line. So when the hook is absent, Harbor "
			+ "detects the package manager from the lockfile and installs. A present "
			+ "hook always wins, completely: a repository that described its own setup "
			+ "knew something detection does not. Off is for a deployment that would "
			+ "rather a repository fail loudly than boot with dependencies somebody "
			+ "did not ask for.",
		parse: asBool,
	} satisfies Setting<boolean>,

	githubOAuthScopes: {
		env: "HARBOR_GITHUB_OAUTH_SCOPES",
		fallback: "read:user",
		derivation:
			"What signing in to the dashboard asks GitHub for. `read:user` is the "
			+ "default and it is the whole point: looking at a dashboard should not "
			+ "require handing over write access to every repository you can push to. "
			+ "Pull-request authorship needs `repo`, and the default way to get it is "
			+ "the separate opt-in consent at /api/auth/scm, which a user grants once, "
			+ "deliberately, and can revoke on its own. An operator who would rather "
			+ "have one flow than two can set this to `read:user,repo`, at which point "
			+ "sign-in also stores the token — a real trade, made explicitly, rather "
			+ "than a scope that crept into the login button.",
		parse: asString,
	} satisfies Setting<string>,
} as const;

export type SettingKey = keyof typeof SETTINGS;

/** Per-repository overrides, as stored in `repos.config`. */
export type RepoOverrides = Partial<Record<SettingKey, unknown>>;

/**
 * Resolve one setting. Called at the point of use, never hoisted to a constant.
 *
 * Reading `process.env` on every call rather than once at import is deliberate:
 * a module-level read is captured before a test can set the variable, which
 * quietly makes every timeout in the test suite the production default. That is
 * how acceptance criterion "no test relies on a hardcoded default" gets violated
 * without anyone writing a hardcoded default.
 */
export function setting<K extends SettingKey>(
	key: K,
	overrides?: RepoOverrides,
): (typeof SETTINGS)[K]["fallback"] {
	const spec = SETTINGS[key];

	const override = overrides?.[key];
	if (override !== undefined && override !== null) {
		try {
			return spec.parse(String(override)) as (typeof SETTINGS)[K]["fallback"];
		} catch (error) {
			throw new ConfigError(
				`Repository override for ${key}: ${(error as Error).message}. `
					+ `Fix it in the repository's settings, or remove it to use ${spec.env}.`,
			);
		}
	}

	const raw = process.env[spec.env];
	if (raw !== undefined && raw !== "") {
		try {
			return spec.parse(raw) as (typeof SETTINGS)[K]["fallback"];
		} catch (error) {
			throw new ConfigError(`${spec.env}: ${(error as Error).message}.`);
		}
	}

	return spec.fallback as (typeof SETTINGS)[K]["fallback"];
}

/**
 * Relationships between settings that must hold for the system to work at all.
 *
 * Called at startup so an incoherent combination fails immediately and by name,
 * rather than producing a deployment where sandboxes are killed seconds after
 * booting and nothing in the logs says why. Each check names both variables and
 * says what the observed symptom would be — because the person reading this
 * error is usually looking at the symptom, not at the config.
 */
export function validateConfig(overrides?: RepoOverrides): void {
	const problems: string[] = [];

	const heartbeat = setting("sandboxHeartbeatIntervalMs", overrides);
	const stale = setting("sandboxStaleHeartbeatMs", overrides);
	if (stale <= heartbeat) {
		problems.push(
			`HARBOR_SANDBOX_STALE_HEARTBEAT_MS (${stale}) must be greater than `
				+ `HARBOR_SANDBOX_HEARTBEAT_INTERVAL_MS (${heartbeat}). As configured, a sandbox is `
				+ "declared stale before it can possibly have sent its next heartbeat, so every "
				+ "healthy sandbox is killed. The symptom is sessions that die seconds after "
				+ "becoming ready. Two to three times the interval is the useful range.",
		);
	}
	if (stale < heartbeat * 2) {
		problems.push(
			`HARBOR_SANDBOX_STALE_HEARTBEAT_MS (${stale}) is less than twice `
				+ `HARBOR_SANDBOX_HEARTBEAT_INTERVAL_MS (${heartbeat}). A single dropped heartbeat `
				+ "then kills a healthy sandbox, which on any real network happens daily.",
		);
	}

	const boot = setting("sandboxBootTimeoutMs", overrides);
	const setup = setting("setupTimeoutMs", overrides);
	const start = setting("startTimeoutMs", overrides);
	if (boot < setup + start) {
		problems.push(
			`HARBOR_SANDBOX_BOOT_TIMEOUT_MS (${boot}) is less than HARBOR_SETUP_TIMEOUT_MS `
				+ `(${setup}) plus HARBOR_START_TIMEOUT_MS (${start}). A repository whose hooks both `
				+ "run to their own limits would be killed by the outer timeout while behaving "
				+ "exactly as configured, and the failure would be attributed to the hooks.",
		);
	}

	const inactivity = setting("sandboxInactivityTimeoutMs", overrides);
	const turn = setting("agentTurnTimeoutMs", overrides);
	if (inactivity <= turn) {
		problems.push(
			`HARBOR_SANDBOX_INACTIVITY_TIMEOUT_MS (${inactivity}) must exceed `
				+ `HARBOR_AGENT_TURN_TIMEOUT_MS (${turn}). Otherwise a long turn that is working `
				+ "correctly is reaped as idle, and the user sees their agent stop mid-task with "
				+ "no explanation.",
		);
	}

	const lease = setting("leaseMinutes", overrides);
	const maxLease = setting("maxLeaseMinutes", overrides);
	if (lease < 1) {
		problems.push(
			`HARBOR_LEASE_MINUTES (${lease}) must be at least 1. A lease that expires `
				+ "before the claim transaction returns means every claim is already lapsed "
				+ "when the agent first acts on it, and every task is permanently contested.",
		);
	}
	if (maxLease < lease) {
		problems.push(
			`HARBOR_MAX_LEASE_MINUTES (${maxLease}) is below HARBOR_LEASE_MINUTES (${lease}). `
				+ "The ceiling would then clamp every claim below its own default, so the "
				+ "configured default is unreachable and every lease is silently shorter than "
				+ "the operator believes.",
		);
	}
	if (turn > lease * 60_000) {
		problems.push(
			`HARBOR_AGENT_TURN_TIMEOUT_MS (${turn}) exceeds HARBOR_LEASE_MINUTES `
				+ `(${lease} minutes = ${lease * 60_000}ms). A turn would then outlive the lease `
				+ "that authorises it: the lease lapses mid-turn, another agent legitimately "
				+ "claims the same task, and two agents work the same task at once — the exact "
				+ "condition leases exist to prevent.",
		);
	}

	const deadlineSweep = setting("deadlineSweepIntervalMs", overrides);
	if (deadlineSweep >= inactivity) {
		problems.push(
			`HARBOR_DEADLINE_SWEEP_INTERVAL_MS (${deadlineSweep}) is not below `
				+ `HARBOR_SANDBOX_INACTIVITY_TIMEOUT_MS (${inactivity}). The sweep that enforces `
				+ "the inactivity timeout would then run at most once per timeout window, so an "
				+ "idle sandbox bills for up to double the configured timeout before anything "
				+ "notices it.",
		);
	}

	const retention = setting("eventRetentionCount", overrides);
	const snapshotCap = setting("maxSnapshotEvents", overrides);
	if (retention < snapshotCap) {
		problems.push(
			`HARBOR_EVENT_RETENTION_COUNT (${retention}) is below HARBOR_MAX_SNAPSHOT_EVENTS `
				+ `(${snapshotCap}). Compaction would then delete events a snapshot is still `
				+ "expected to carry, so a reconnecting client would be sent a snapshot with "
				+ "holes in it and no marker saying so.",
		);
	}

	const imageInterval = setting("imageBuildIntervalMs", overrides);
	const imageMaxAge = setting("imageMaxAgeMs", overrides);
	if (imageMaxAge < imageInterval) {
		problems.push(
			`HARBOR_IMAGE_MAX_AGE_MS (${imageMaxAge}) is below HARBOR_IMAGE_BUILD_INTERVAL_MS `
				+ `(${imageInterval}). The freshness cutoff would then be shorter than the rebuild `
				+ "cadence, so every image is older than the cutoff the moment it is published and no "
				+ "session ever boots from one. The feature would appear enabled and do nothing — the "
				+ "worst outcome, because the standing build spend is paid for zero latency benefit.",
		);
	}

	const imageBuildTimeout = setting("imageBuildTimeoutMs", overrides);
	if (imageBuildTimeout < boot) {
		problems.push(
			`HARBOR_IMAGE_BUILD_TIMEOUT_MS (${imageBuildTimeout}) is below HARBOR_SANDBOX_BOOT_TIMEOUT_MS `
				+ `(${boot}). A build boots a container and then does strictly more than a normal boot — `
				+ "it also installs the full dependency tree — so a budget tighter than a plain boot's "
				+ "would kill every build during `setup.sh` and no image would ever publish.",
		);
	}

	const imageRetention = setting("imageRetentionCount", overrides);
	if (imageRetention < 1) {
		problems.push(
			`HARBOR_IMAGE_RETENTION_COUNT (${imageRetention}) must be at least 1. At zero, the prune `
				+ "that runs after a publish would delete the image that publish just pointed at, so "
				+ "every spawn would find its pointer dangling and fall back to a cold boot.",
		);
	}

	if (problems.length > 0) {
		throw new ConfigError(
			`Harbor configuration is incoherent:\n\n${problems.map((p) => `  • ${p}`).join("\n\n")}`,
		);
	}
}

/**
 * The whole resolved configuration, with provenance. Served by the health
 * endpoint so "what is this deployment actually running with" is one curl rather
 * than an archaeology exercise across a Helm chart and a Dockerfile.
 */
export function describeConfig(overrides?: RepoOverrides) {
	return (Object.keys(SETTINGS) as SettingKey[]).map((key) => {
		const spec = SETTINGS[key];
		const fromRepo = overrides?.[key] !== undefined && overrides?.[key] !== null;
		const fromEnv = !fromRepo && Boolean(process.env[spec.env]);
		return {
			key,
			env: spec.env,
			value: setting(key, overrides),
			source: fromRepo ? "repository" : fromEnv ? "environment" : "default",
			derivation: spec.derivation,
		};
	});
}
