// SPDX-License-Identifier: Apache-2.0
/**
 * Harbor's canonical schema.
 *
 * The one rule that shapes everything here: Harbor's own tables are the truth,
 * always. Agents never talk to Linear or GitHub — they talk to these tables
 * through five MCP tools. Connectors are sync jobs that keep `tasks` fresh from
 * outside; they are not a layer agents reach through. That is what makes
 * external tools optional rather than load-bearing, and it is why `source` and
 * `source_ref` are ordinary columns on `tasks` rather than a separate join
 * table: a Linear issue and a hand-written task are the same kind of thing to
 * an agent, and the schema should not make an agent care which is which.
 */

import { relations, sql } from "drizzle-orm";
import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

export const orgs = pgTable("orgs", {
	id: uuid("id").primaryKey().defaultRandom(),
	name: text("name").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable("users", {
	id: uuid("id").primaryKey().defaultRandom(),
	orgId: uuid("org_id")
		.notNull()
		.references(() => orgs.id),
	githubId: text("github_id").unique(),
	email: text("email"),
	name: text("name"),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One key per org, hashed.
 *
 * Stored as a SHA-256 hex digest with no salt. bcrypt exists to make an offline
 * search expensive, and a search needs a space small enough to walk — 256 bits
 * of CSPRNG output does not have one. A salt would also make the column
 * unindexable, turning authentication into a table scan on the hot path of
 * every single MCP call.
 */
export const apiKeys = pgTable("api_keys", {
	id: uuid("id").primaryKey().defaultRandom(),
	orgId: uuid("org_id")
		.notNull()
		.references(() => orgs.id),
	keyHash: text("key_hash").notNull().unique(),
	label: text("label"),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const projects = pgTable("projects", {
	id: uuid("id").primaryKey().defaultRandom(),
	orgId: uuid("org_id")
		.notNull()
		.references(() => orgs.id),
	name: text("name").notNull(),
	description: text("description"),
	archivedAt: timestamp("archived_at", { withTimezone: true }),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * `scope` is free text on purpose.
 *
 * It is a hint an agent writes about where the work lives — a path, a module, a
 * service name. Harbor does not parse it in v1 and does not pretend to detect
 * semantic overlap from it; it is shown to the next agent so a human-shaped
 * judgement can be made cheaply. Structured file-level overlap detection is
 * explicitly future work, and making this column structured now would imply a
 * guarantee the product does not yet keep.
 */
export const tasks = pgTable(
	"tasks",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		projectId: uuid("project_id").references(() => projects.id),
		title: text("title").notNull(),
		description: text("description"),
		status: text("status").notNull().default("open"),
		scope: text("scope"),
		source: text("source").notNull().default("native"),
		sourceRef: text("source_ref"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		index("tasks_org_status_idx").on(table.orgId, table.status),
		index("tasks_project_idx").on(table.projectId),
		// A connector re-delivering the same webhook must update the row it made
		// last time rather than add a second copy of the same Linear issue.
		uniqueIndex("tasks_source_ref_idx")
			.on(table.orgId, table.source, table.sourceRef)
			.where(sql`${table.sourceRef} is not null`),
	],
);

/**
 * The coordination primitive — a lease over a namespaced scope, not a lock on a
 * task row.
 *
 * The partial unique index is the entire mechanism: at most one active row per
 * `(org_id, scope)` with `released_at is null`. Two agents racing to claim the
 * same scope both issue an INSERT, Postgres serialises them, and exactly one
 * gets a unique violation. The loser is not an error to swallow — it is a
 * `claim_conflict` event, and that event is the number the product is ultimately
 * judged by.
 *
 * `scope` is `<namespace>:<identifier>` and is the only thing the invariant
 * depends on. `task_id` survives as a nullable convenience for the dashboard's
 * join, but a lease can exist with no task at all (a `github:` path), so nothing
 * load-bearing may key on it.
 *
 * Note what the index does NOT cover: expiry. An expired-but-unreleased claim
 * still occupies the slot. That is deliberate — a partial index cannot depend
 * on `now()` — and it is why `claim()` lazily releases an expired holder inside
 * the same transaction before inserting. The sweeper is a backstop that keeps
 * the event log honest, not the thing correctness depends on.
 */
export const claims = pgTable(
	"claims",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		/**
		 * The tenant this lease belongs to.
		 *
		 * Denormalised onto the claim rather than reached through `task_id`, because
		 * `task_id` is now nullable — a lease can be over a `github:...` path with no
		 * task row at all — so the org can no longer be recovered by a join. Every
		 * claim read and write filters on it directly; without the column, an agent
		 * holding one org's key could touch another org's lease by passing its id.
		 */
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		/**
		 * What is leased, as `<namespace>:<identifier>` — the load-bearing key.
		 *
		 * The kernel never parses the part after the colon; a per-namespace
		 * `ScopeResolver` (src/lib/scope.ts) decides containment. This is what
		 * generalises the lease past "a row in `tasks`": `linear:ENG-4471`,
		 * `github:acme/api#src/billing/**`. The active-lease uniqueness invariant is
		 * enforced on `(org_id, scope)`, not on `task_id`.
		 */
		scope: text("scope").notNull(),
		/**
		 * A nullable convenience foreign key for the dashboard's task join.
		 *
		 * Explicitly NOT load-bearing for the claim invariant — that moved to
		 * `scope`. A lease over a path or an external identifier need not correspond
		 * to any `tasks` row, so this is null for those and the FK is soft.
		 */
		taskId: uuid("task_id").references(() => tasks.id),
		agentId: text("agent_id").notNull(),
		/**
		 * What the holder may do, drawn from {read, write, spawn, publish, merge,
		 * delegate}. Every lease is currently minted `{read, write}`. Rights never
		 * widen: `narrow()` (src/lib/rights.ts) refuses a child lease asking for a
		 * right the parent does not hold. Enforcement of individual rights beyond
		 * that subset check is future work; the column exists now because adding it
		 * later means migrating every historical lease blind.
		 */
		rights: text("rights")
			.array()
			.notNull()
			.default(sql`'{read,write}'`),
		/**
		 * The lease this one was narrowed from, if any. Self-referencing, nullable.
		 *
		 * Nothing delegates yet, but revoking a parent must cascade to its children
		 * (a test asserts it), and that relationship cannot be reconstructed after
		 * the fact — so the edge is recorded at mint even though no code walks it.
		 */
		parentLeaseId: uuid("parent_lease_id").references((): AnyPgColumn => claims.id),
		/**
		 * Why this work is being done, in the claimant's own words.
		 *
		 * The event log already records what changed and when; what it could never
		 * answer is why somebody started — the question asked six months later,
		 * usually by whoever has to decide whether a change can be reverted.
		 *
		 * Required at mint (min 10 chars), enforced in `claim()`. This is not
		 * documentation hygiene: the intent is what makes reading the shared
		 * substrate cheaper than re-deriving it, so it must be structurally
		 * impossible to hold a lease without one.
		 *
		 * Attached to the claim rather than the task on purpose: one scope can be
		 * claimed three times for three different reasons, and the reason belongs
		 * to the attempt, not to the ticket.
		 */
		intent: text("intent").notNull(),
		/** A spec, design doc, thread or issue URL backing that intent. */
		intentRef: text("intent_ref"),
		claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		releasedAt: timestamp("released_at", { withTimezone: true }),
		completionSummary: text("completion_summary"),
	},
	(table) => [
		// The entire race mechanism, now keyed on scope-within-org rather than on a
		// task row: at most one active lease per `(org_id, scope)`. `claim()` targets
		// this exact partial index in its ON CONFLICT, so two agents racing the same
		// scope still yield one winner and one `claim_conflict`.
		uniqueIndex("one_active_lease_per_scope")
			.on(table.orgId, table.scope)
			.where(sql`${table.releasedAt} is null`),
		index("claims_org_idx").on(table.orgId),
		index("claims_expiry_idx").on(table.expiresAt).where(sql`${table.releasedAt} is null`),
		index("claims_agent_idx").on(table.agentId),
		index("claims_parent_idx").on(table.parentLeaseId),
	],
);

/**
 * A room with work in it, and no owner.
 *
 * The failure mode this design exists to avoid is a session that belongs to one
 * person. Tie a session to a single author and "send it to a colleague and let
 * them take it home" becomes impossible to retrofit — every query, every
 * permission check and every UI affordance ends up assuming one identity, and
 * unpicking that later is a rewrite. So there is no `ownerId` column, and
 * `createdBy` exists purely as provenance: it records who opened the room and
 * confers nothing.
 *
 * `key` is the shareable half of the URL. Possession of the link is what grants
 * access — the same model as an unlisted document — because requiring an invite
 * for each participant is the friction that stops anyone sharing at all.
 */
export const sessions = pgTable(
	"sessions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		/** Short, URL-safe, unguessable. Appears in /s/<key>. */
		key: text("key").notNull(),
		title: text("title").notNull(),
		taskId: uuid("task_id").references(() => tasks.id),
		/** Provenance only. Deliberately NOT ownership. */
		createdBy: text("created_by").notNull(),
		status: text("status").notNull().default("open"),
		/**
		 * The next sequence number to hand out, incremented with RETURNING.
		 *
		 * A counter here rather than `max(seq) + 1` over the prompts table, because
		 * that subquery races: under READ COMMITTED two concurrent transactions
		 * cannot see one another's uncommitted rows, both compute the same maximum,
		 * and the unique index rejects the loser — dropping somebody's message in
		 * exactly the situation multiplayer exists to support. An UPDATE on this row
		 * takes a row lock, so the second transaction waits and gets the next value.
		 */
		nextSeq: integer("next_seq").notNull().default(1),
		/**
		 * The same counter discipline, for the timeline rather than the queue.
		 *
		 * Kept separate from `nextSeq` on purpose. Prompt ordering is what humans
		 * see in the composer; event ordering is what a reconnecting client uses to
		 * work out what it missed. Sharing one counter would make every agent token
		 * advance the prompt numbering, so "message #3" would mean nothing, and any
		 * future change to how events are emitted would silently renumber the
		 * conversation.
		 */
		nextEventSeq: integer("next_event_seq").notNull().default(1),
		/**
		 * What this session works on. Both nullable: a session with neither is a
		 * scratch sandbox, which is a legitimate and useful thing to want.
		 *
		 * `environmentId` records which environment was chosen, but the *contents*
		 * are snapshotted into `session_repos` at creation — see the note there.
		 */
		repoId: uuid("repo_id"),
		environmentId: uuid("environment_id"),
		/** What the agent branches from. Defaults to the primary repo's default branch. */
		baseBranch: text("base_branch"),
		/**
		 * Which agent runs here: claude-code | codex | opencode | custom.
		 *
		 * Per session rather than per deployment, because the interesting comparison
		 * — three agents on the same prompt, see which lands — is only possible if
		 * the choice travels with the session.
		 */
		runtime: text("runtime"),
		/** Paused sessions stop consuming the queue. Set by a budget or by a human. */
		pausedReason: text("paused_reason"),
		/**
		 * The agent's own conversation id, so a replaced sandbox can carry on rather
		 * than silently starting over.
		 *
		 * A session outlives its sandboxes: a box is stopped on inactivity, reaped on
		 * a stale heartbeat, or killed by an execution timeout, and the next prompt
		 * boots a new one. The supervisor holds the resume token in a closure, so
		 * before this column every one of those events reset the agent's context
		 * while Harbor's transcript carried on looking unbroken — which reads to the
		 * user as the model having got worse, not as a restart.
		 *
		 * Written only from a verified `agent_finished` payload on the fenced ingest
		 * path, and re-injected only when the boot restored the filesystem the
		 * transcript lives on. See `resumeTokenForBoot`.
		 */
		agentResumeToken: text("agent_resume_token"),
		/**
		 * Which runtime minted that token. Not decoration: a token is adapter-
		 * specific — a Claude Code session id means nothing to OpenCode's `--session`
		 * — and `sessions.runtime` is editable, so the two can legitimately disagree.
		 * Storing the minting runtime is what lets the mismatch be detected instead
		 * of handing one agent another's identifier and getting an opaque failure on
		 * the first turn after a reboot.
		 */
		agentResumeRuntime: text("agent_resume_runtime"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex("sessions_key_idx").on(table.key),
		index("sessions_org_activity_idx").on(table.orgId, table.lastActivityAt),
	],
);

/** Everyone who has opened the link. Joining is the only membership event. */
export const sessionParticipants = pgTable(
	"session_participants",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		sessionId: uuid("session_id")
			.notNull()
			.references(() => sessions.id),
		/** A human handle or an agent id — the room does not distinguish. */
		participant: text("participant").notNull(),
		kind: text("kind").notNull().default("human"),
		joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex("participants_session_who_idx").on(table.sessionId, table.participant),
		index("participants_session_idx").on(table.sessionId),
	],
);

/**
 * Input from any client, queued rather than interleaved.
 *
 * Two decisions here, and both are corrections of the obvious design.
 *
 * `author` is required on every row. A session with several people steering has
 * to be able to answer "who asked for this?" months later, and attribution added
 * afterwards is attribution that is missing for everything already said.
 *
 * Prompts QUEUE instead of being injected the moment they arrive. When two people
 * type at once, splicing both into a running agent's context mid-turn produces
 * an agent following half of each instruction — the failure is silent and reads
 * as the model being stupid rather than as a race. A queue makes the ordering
 * explicit and lets a second thought arrive while the agent is still working on
 * the first, which is what people actually do.
 */
export const sessionPrompts = pgTable(
	"session_prompts",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		sessionId: uuid("session_id")
			.notNull()
			.references(() => sessions.id),
		/** Never nullable. Unattributed input is the thing this table exists to prevent. */
		author: text("author").notNull(),
		authorKind: text("author_kind").notNull().default("human"),
		/**
		 * The author's git identity, when one is on file. Nullable, and null means
		 * something specific: the commands route sends the prompt down as
		 * `agent-only`, so the turn runs with bot-attributed commits instead of
		 * being refused. Before this column existed every prompt went down with a
		 * null email and NO mode, and the bridge's identity check refused every
		 * attributed turn in the product.
		 */
		authorEmail: text("author_email"),
		/**
		 * The signed-in user who wrote this prompt, when there was one.
		 *
		 * The pull request for this session's work is opened with **this person's**
		 * OAuth token — that is what makes them the PR author, and what makes GitHub
		 * refuse to let them approve it. `prAuthorityForUser` takes a user id, so
		 * without this column the only route from a prompt to an identity is
		 * matching `author_email` against `users.email`, which is nullable and not
		 * unique. A near-miss there does not fail; it opens a pull request in
		 * somebody else's name.
		 *
		 * Nullable because a prompt can legitimately have no user behind it — an
		 * automation, a connector, an agent's `spawn_child`. Those sessions push a
		 * branch and hand back a compare URL rather than opening a PR as the bot.
		 */
		authorUserId: uuid("author_user_id").references(() => users.id),
		body: text("body").notNull(),
		status: text("status").notNull().default("queued"),
		/** Monotonic within a session, so ordering never depends on timestamps. */
		seq: integer("seq").notNull(),
		/**
		 * The turn's correlation id, written when the runner delivers the prompt
		 * and cleared on requeue. This is how the trace survives the hop from the
		 * runner (which mints it) to the commands route (which sends the prompt
		 * from persisted state and has no runner in the call stack).
		 */
		traceId: text("trace_id"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		deliveredAt: timestamp("delivered_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("prompts_session_seq_idx").on(table.sessionId, table.seq),
		index("prompts_session_status_idx").on(table.sessionId, table.status),
	],
);

/**
 * Who is alive right now.
 *
 * Deliberately NOT a sixth MCP tool. Presence is a byproduct of the five calls an
 * agent already makes — every one touches this row — so an agent cannot forget to
 * report, does not opt in, and spends no extra tokens being visible. A heartbeat
 * tool was the obvious design and would have made every agent pay, on every turn,
 * for the dashboard's benefit.
 *
 * Liveness is computed at read time from `lastSeenAt` rather than stored as an
 * online flag, because a flag needs somebody to clear it and the agent that
 * crashed is precisely the one that will not.
 */
export const agentPresence = pgTable(
	"agent_presence",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		agentId: text("agent_id").notNull(),
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
		lastAction: text("last_action"),
		currentTaskId: uuid("current_task_id"),
		firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex("presence_org_agent_idx").on(table.orgId, table.agentId),
		index("presence_org_seen_idx").on(table.orgId, table.lastSeenAt),
	],
);

/**
 * An agent process Harbor started, as opposed to one that merely connected.
 *
 * Harbor does not own an execution sandbox and this is not the beginning of one. A
 * run is a child process on the host running the server, wired to Harbor's own MCP
 * endpoint — enough to launch work from the dashboard on a laptop or a single
 * box, and deliberately not enough to run somebody else's code. Multi-tenant
 * execution needs a real isolation boundary — a container or a VM, which is what
 * the sandbox providers give — not a spawn() call, and pretending otherwise is
 * how you ship an RCE.
 */
export const runs = pgTable(
	"runs",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		taskId: uuid("task_id").references(() => tasks.id),
		agentId: text("agent_id").notNull(),
		/** Which binary was launched: "claude-code" | "codex". */
		runtime: text("runtime").notNull(),
		prompt: text("prompt").notNull(),
		status: text("status").notNull().default("starting"),
		pid: text("pid"),
		exitCode: text("exit_code"),
		/** Combined stdout/stderr, bounded. Not a log pipeline. */
		output: text("output").notNull().default(""),
		startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
		endedAt: timestamp("ended_at", { withTimezone: true }),
	},
	(table) => [index("runs_org_started_idx").on(table.orgId, table.startedAt)],
);

/**
 * Everything that happened. Append-only.
 *
 * Written in the same transaction as the state change it describes, so the log
 * cannot drift from reality: if a claim exists, its event exists. The weekly
 * digest is a read over this table rather than a separate analytics pipeline.
 */
export const events = pgTable(
	"events",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		taskId: uuid("task_id").references(() => tasks.id),
		agentId: text("agent_id"),
		type: text("type").notNull(),
		payload: jsonb("payload"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		index("events_org_created_idx").on(table.orgId, table.createdAt),
		index("events_type_idx").on(table.orgId, table.type, table.createdAt),
	],
);

/**
 * The passive counterpart to `events`. Append-only, high volume.
 *
 * `events` records the eight coordination facts an agent asserts by calling an
 * MCP tool — a closed, low-volume set the weekly digest reads whole. Activity is
 * a different animal: every `Bash`, `Edit`, `Read` and shell call an agent's
 * *host* makes, delivered by that host's hooks rather than by the agent choosing
 * to report. Folding it into `events` would drown the coordination log and blow
 * the digest's cost model, so it lives here instead, joined to the same
 * `orgId`/`agentId`/`taskId` so a tool call still lines up with the claim it
 * happened under.
 *
 * `runtime` is the host that emitted it (`claude-code`, `codex`, …) and
 * `runtimeSessionId` is that host's own session id — the thread of tool calls an
 * agent made in one sitting. `payload` is a bounded digest, not a log line: the
 * ingest path caps command and output strings so this table never becomes a log
 * pipeline the schema did not sign up to be.
 */
export const activity = pgTable(
	"activity",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		agentId: text("agent_id").notNull(),
		/** The claim this tool call happened under, when the agent holds one. */
		taskId: uuid("task_id").references(() => tasks.id),
		/** Which host emitted it: claude-code | codex | opencode | cursor | conductor. */
		runtime: text("runtime").notNull(),
		/** The host's own session id — one agent's thread of tool calls. */
		runtimeSessionId: text("runtime_session_id"),
		/** One of ACTIVITY_KINDS. */
		kind: text("kind").notNull(),
		/** Tool name for a tool_call: Bash, Edit, shell, mcp__server__tool, … */
		tool: text("tool"),
		/** `pre` or `post` for a tool_call; null otherwise. */
		phase: text("phase"),
		payload: jsonb("payload"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		index("activity_org_created_idx").on(table.orgId, table.createdAt),
		index("activity_org_agent_idx").on(table.orgId, table.agentId, table.createdAt),
		index("activity_org_runtime_idx").on(table.orgId, table.runtime, table.createdAt),
	],
);

export const connectors = pgTable(
	"connectors",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		type: text("type").notNull(),
		/**
		 * The id of the account on the other side: a Slack team id, a GitHub
		 * installation id, a Linear organisation id.
		 *
		 * This column is what makes Harbor multi-tenant per connector, and its
		 * absence was a documented bug: webhook ingest selected the connector row
		 * by `type` alone, so the first active row won and two orgs sharing a
		 * connector type delivered each other's issues. The connector extracts this
		 * from the *verified* payload — never from a header or a query parameter,
		 * because the whole point is that the sender cannot assert which tenant it
		 * belongs to.
		 *
		 * Nullable only so existing rows survive the migration; ingest refuses a
		 * payload whose account it cannot resolve rather than guessing.
		 */
		externalAccountId: text("external_account_id"),
		/** OAuth tokens, workspace/repo ids, webhook secrets. Never sent to a client. */
		config: jsonb("config").notNull(),
		status: text("status").notNull().default("active"),
		lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		index("connectors_org_type_idx").on(table.orgId, table.type),
		// A webhook arrives before we know which org it belongs to, so the
		// external account id has to be reachable by one indexed lookup.
		index("connectors_external_idx").on(table.type, table.status),
		// Two orgs may both install Slack; the same Slack workspace may not be
		// installed into two orgs, because then a message genuinely has two homes
		// and nothing in the payload can break the tie.
		uniqueIndex("connectors_account_idx")
			.on(table.type, table.externalAccountId)
			.where(sql`${table.externalAccountId} is not null`),
	],
);

export const digests = pgTable(
	"digests",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
		periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
		body: text("body").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [index("digests_org_created_idx").on(table.orgId, table.createdAt)],
);

// ---------------------------------------------------------------------------
// Execution plane
// ---------------------------------------------------------------------------

/**
 * A repository Harbor can work in.
 *
 * `config` holds per-repository overrides for anything an operator can tune
 * globally — boot timeouts, auto-review filters, which agent runtime to use.
 * Per-repo rather than global-only because the friction that stops a self-hoster
 * on day one is a monorepo that legitimately takes four minutes to boot against a
 * ninety-second default, and forking the project to change a constant is not an
 * acceptable answer. See `src/config.ts` for the resolution order.
 */
export const repos = pgTable(
	"repos",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		/** `github` | `gitlab`. One provider per deployment; see docs/adr/0006. */
		provider: text("provider").notNull().default("github"),
		owner: text("owner").notNull(),
		name: text("name").notNull(),
		defaultBranch: text("default_branch").notNull().default("main"),
		/** The App installation that can reach it. Null until the App is installed. */
		installationId: text("installation_id"),
		description: text("description"),
		/** Per-repo overrides. Every key is optional; absent means "use the global". */
		config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
		archivedAt: timestamp("archived_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex("repos_org_slug_idx").on(table.orgId, table.provider, table.owner, table.name),
		index("repos_org_idx").on(table.orgId),
	],
);

/**
 * A reusable, named set of repositories — frontend + API, service + shared lib.
 *
 * The load-bearing decision is not here but in `session_repos`: a session
 * *snapshots* the environment at creation. Editing or deleting an environment
 * therefore never mutates what an in-flight session is working on. The obvious
 * alternative — resolve the environment's repos on every read — means renaming a
 * repo mid-run silently changes the workspace under a running agent, and deleting
 * an environment strands every session that referenced it.
 */
export const environments = pgTable(
	"environments",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		name: text("name").notNull(),
		description: text("description"),
		archivedAt: timestamp("archived_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [uniqueIndex("environments_org_name_idx").on(table.orgId, table.name)],
);

export const environmentRepos = pgTable(
	"environment_repos",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		environmentId: uuid("environment_id")
			.notNull()
			.references(() => environments.id),
		repoId: uuid("repo_id")
			.notNull()
			.references(() => repos.id),
		/** Ordered. Position 0 is primary and drives defaults. */
		position: integer("position").notNull().default(0),
	},
	(table) => [
		uniqueIndex("environment_repos_idx").on(table.environmentId, table.repoId),
		index("environment_repos_env_idx").on(table.environmentId, table.position),
	],
);

/**
 * The repositories one session actually works in — the snapshot described above.
 *
 * Written once at session creation, from an environment, from an ad-hoc
 * selection, or from a single repo. Never recomputed. `branch` is resolved here
 * too, so "what did this session branch from" survives someone changing the
 * repository's default branch afterwards.
 */
export const sessionRepos = pgTable(
	"session_repos",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		sessionId: uuid("session_id")
			.notNull()
			.references(() => sessions.id),
		repoId: uuid("repo_id")
			.notNull()
			.references(() => repos.id),
		position: integer("position").notNull().default(0),
		baseBranch: text("base_branch").notNull(),
		/** The branch the agent pushed, once it has. `harbor/lse_<claim>`. */
		workingBranch: text("working_branch"),
	},
	(table) => [
		uniqueIndex("session_repos_idx").on(table.sessionId, table.repoId),
		index("session_repos_session_idx").on(table.sessionId, table.position),
	],
);

/**
 * A sandbox instance. One row per boot, not one row per session.
 *
 * Keeping a row per boot rather than mutating one row per session is what makes
 * "why was this session slow on Tuesday" answerable: each boot carries its mode,
 * its provider, its time-to-ready and how it ended. A single mutated row loses
 * every previous attempt, which is exactly the history you want when a repo starts
 * failing to boot.
 *
 * `authTokenHash` is a SHA-256 digest for the same reason `api_keys.key_hash` is:
 * the token grants a sandbox the ability to write into its session's event stream
 * and fetch git credentials, and a compromised database should not hand that over.
 */
export const sandboxes = pgTable(
	"sandboxes",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		sessionId: uuid("session_id")
			.notNull()
			.references(() => sessions.id),
		provider: text("provider").notNull(),
		/** The provider's own id: a Docker container id, a Fly machine id, and so on. */
		externalId: text("external_id"),
		/** One of SANDBOX_STATUSES in src/contracts. */
		status: text("status").notNull().default("requested"),
		/** One of BOOT_MODES. Null until the supervisor reports which it resolved. */
		bootMode: text("boot_mode"),
		/** Provider-specific handle for the filesystem state this box was restored from. */
		restoredFrom: text("restored_from"),
		/** Provider-specific handle for the most recent snapshot taken of this box. */
		snapshotRef: text("snapshot_ref"),
		authTokenHash: text("auth_token_hash"),
		/** Set once when the bridge first reports ready — the number time-to-ready comes from. */
		readyAt: timestamp("ready_at", { withTimezone: true }),
		lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
		stoppedAt: timestamp("stopped_at", { withTimezone: true }),
		/** Typed reason, not prose. See SandboxFailure in src/sandbox/decisions.ts. */
		failureReason: text("failure_reason"),
		/** Warnings the supervisor collected during boot — a failed setup.sh, a tunnel timeout. */
		bootWarnings: jsonb("boot_warnings"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		index("sandboxes_session_idx").on(table.sessionId, table.createdAt),
		index("sandboxes_org_status_idx").on(table.orgId, table.status),
		// The heartbeat sweep reads exactly this: live boxes ordered by staleness.
		index("sandboxes_heartbeat_idx").on(table.status, table.lastHeartbeatAt),
	],
);

/**
 * The session timeline. Append-only, monotonic, and the basis of reconnection.
 *
 * A client holds a `seq` and knows precisely what it has. On reconnect it is sent
 * a snapshot carrying a cursor, and anything that arrives on the live channel with
 * a lower or equal seq is discarded by number rather than guessed at from a
 * timestamp. That is what makes "no gaps, no duplicates" a property of the data
 * rather than of the ordering of two statements in a function.
 *
 * `compactedAt` is not decoration. A session streaming tokens for two days
 * accumulates events without bound, and a snapshot is read whole on every
 * reconnect — so the largest payload in the system grows monotonically with the
 * age of the session, and reconnect storms on a flaky network ship it repeatedly.
 * Old token-level events are folded into one summarised turn and the originals
 * deleted; `compactedAt` marks the survivor so a second pass does not re-summarise
 * a summary.
 */
export const sessionEvents = pgTable(
	"session_events",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		sessionId: uuid("session_id")
			.notNull()
			.references(() => sessions.id),
		/** Monotonic within a session. From sessions.nextEventSeq, never max()+1. */
		seq: integer("seq").notNull(),
		/** One of SESSION_EVENT_TYPES in src/contracts. */
		type: text("type").notNull(),
		/** Bounded at ingest. This is a timeline, not a log pipeline. */
		payload: jsonb("payload"),
		/** A human handle, an agent id, or `harbor` for the system itself. */
		actor: text("actor"),
		compactedAt: timestamp("compacted_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex("session_events_seq_idx").on(table.sessionId, table.seq),
		index("session_events_session_created_idx").on(table.sessionId, table.createdAt),
	],
);

/** What a session produced: a branch, a PR, a screenshot, a file. */
export const artifacts = pgTable(
	"artifacts",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		sessionId: uuid("session_id")
			.notNull()
			.references(() => sessions.id),
		repoId: uuid("repo_id").references(() => repos.id),
		/** One of ARTIFACT_KINDS. */
		kind: text("kind").notNull(),
		title: text("title").notNull(),
		url: text("url"),
		payload: jsonb("payload"),
		/**
		 * When a `pull_request` artifact was merged. Null for everything else.
		 *
		 * A timestamp rather than a boolean because "was it merged" and "when" are
		 * the same question asked at two resolutions, and the headline metric —
		 * sessions that resulted in a *merged* pull request — needs a window as much
		 * as a count. A boolean would have to be widened the first time anybody asks
		 * for last month's number.
		 *
		 * Set only from a verified source-control webhook, never by an agent.
		 * `record_artifact`'s `kind` enum deliberately excludes `pull_request` for
		 * the same reason: an agent asserting its own work merged is a metric that
		 * measures the agent's optimism.
		 */
		mergedAt: timestamp("merged_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		index("artifacts_session_idx").on(table.sessionId, table.createdAt),
		// Connectors store their thread link here (`slack:<channel>:<ts>`) and look it
		// up on EVERY inbound message in every channel the bot can see. That makes
		// this the hottest read in the connector path, so it has to be one indexed
		// equality test rather than a jsonb scan that gets slower every day the
		// product is used.
		index("artifacts_org_url_idx").on(table.orgId, table.url),
	],
);

/**
 * The Devin sessions Harbor is tracking, and the cursor it polls them with.
 *
 * Devin is a cloud agent with no hooks and no outbound webhooks — the only way to
 * learn what one did is to GET its session. This table is what makes that pull
 * idempotent and attributable: it stores where the last poll left off
 * (`lastUpdatedAt` / `lastMessageCount` / `lastStatus`) so a tick only emits the
 * activity that is new, and it maps each Devin session to a minted Harbor
 * `sessions` row so the PR it produces has a home — `artifacts.session_id` is
 * NOT NULL, and a Devin PR has to live under a session like every other artifact.
 *
 * A row leaves the poll set by its `status`: the terminal values Devin reports
 * (`finished`, `suspended`) and the `expired` we set after the session stops
 * being reachable drop it from `devin_sessions_poll_idx`. The row is kept for
 * provenance — it owns the PR artifact link — rather than deleted.
 */
export const devinSessions = pgTable(
	"devin_sessions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		/** Devin's own session id, e.g. devin-xxxx — the join key to its API. */
		devinSessionId: text("devin_session_id").notNull(),
		/** The Harbor session minted to host this Devin session's artifacts. */
		sessionId: uuid("session_id").references(() => sessions.id),
		/**
		 * Mirrors Devin's `status_enum`. The terminal set (`finished`, `suspended`)
		 * plus `expired` is what the poll query excludes, so this column is both the
		 * live state and the de-registration switch.
		 */
		status: text("status").notNull().default("working"),
		/** The previous `status_enum`, so a tick can emit only the transition. */
		lastStatus: text("last_status"),
		/** How many messages had been seen — `messages.slice(this)` is the new tail. */
		lastMessageCount: integer("last_message_count").notNull().default(0),
		/**
		 * Devin's `updated_at` at the last poll. The short-circuit cursor: an
		 * unchanged value means nothing happened and the tick does no work beyond
		 * bumping `lastPolledAt`, which is what keeps an idle long-running session
		 * from generating repeat writes every interval.
		 */
		lastUpdatedAt: timestamp("last_updated_at", { withTimezone: true }),
		lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
		prUrl: text("pr_url"),
		prArtifactId: uuid("pr_artifact_id").references(() => artifacts.id),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		// One Devin session is tracked once per org; re-registration is a no-op.
		uniqueIndex("devin_sessions_org_session_idx").on(table.orgId, table.devinSessionId),
		// The poll query: non-terminal rows, oldest-polled first.
		index("devin_sessions_poll_idx").on(table.status, table.lastPolledAt),
	],
);

// ---------------------------------------------------------------------------
// Secrets and credentials
// ---------------------------------------------------------------------------

/**
 * Encrypted values injected into a sandbox as environment variables.
 *
 * Three scopes with defined precedence — environment beats repository beats
 * global on a key collision — so a staging environment can override one key
 * without duplicating the other forty.
 *
 * A repository's secrets deliberately do NOT flow into an environment that
 * contains it. An environment is its own trust scope; inheriting member repos'
 * secrets would mean adding a repo to an environment silently widens what every
 * session in that environment can read.
 *
 * `keyId` is present from the first migration even though rotation is not
 * implemented. Adding the field now costs one column; retrofitting it later is a
 * migration of every secret and token in the system, because a ciphertext that
 * cannot say which key made it can only be rotated by decrypting all of them at
 * once with the key you are trying to retire.
 */
export const secrets = pgTable(
	"secrets",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		/** `global` | `repo` | `environment`. */
		scope: text("scope").notNull(),
		/** The repo or environment id. Null for global. */
		scopeId: uuid("scope_id"),
		name: text("name").notNull(),
		/** base64(key_id ‖ iv ‖ ciphertext ‖ tag). See src/lib/crypto.ts. */
		ciphertext: text("ciphertext").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		// `coalesce` because Postgres treats NULLs as distinct in a unique index, so
		// without it two global secrets could share a name.
		uniqueIndex("secrets_scope_name_idx").on(
			table.orgId,
			table.scope,
			sql`coalesce(${table.scopeId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
			table.name,
		),
		index("secrets_org_scope_idx").on(table.orgId, table.scope, table.scopeId),
	],
);

/**
 * A user's own token for the source control host.
 *
 * This exists for one reason: **the pull request is opened with the prompting
 * human's token, never with the app's.** The sandbox pushes a branch using
 * short-lived brokered credentials, reports the branch name, and the control plane
 * opens the PR as the person who asked. The consequence is that they cannot
 * approve their own agent's changes, which makes unreviewed agent code a
 * structural impossibility rather than a policy somebody has to enforce.
 *
 * A user without a row here — signed in through SSO with no SCM identity — does
 * not silently fall back to the bot. `src/git/` refuses, pushes the branch, hands
 * back a compare URL, and says loudly which property was lost.
 */
export const userScmTokens = pgTable(
	"user_scm_tokens",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id),
		provider: text("provider").notNull().default("github"),
		login: text("login").notNull(),
		email: text("email"),
		/** Same envelope as `secrets.ciphertext`. */
		ciphertext: text("ciphertext").notNull(),
		scopes: text("scopes"),
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [uniqueIndex("user_scm_tokens_idx").on(table.userId, table.provider)],
);

// ---------------------------------------------------------------------------
// Automations
// ---------------------------------------------------------------------------

/**
 * Something that starts a session without a human present.
 *
 * `consecutiveFailures` and the auto-pause it drives are the whole reason this
 * table is more than a cron string. An automation that fails is usually going to
 * keep failing, and one that fires hourly against a broken repo will spawn
 * twenty-four sandboxes a day, each costing money, until somebody notices. Three
 * strikes and it pauses itself.
 */
export const automations = pgTable(
	"automations",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		name: text("name").notNull(),
		/** `cron` | `webhook` | `github` | `slack` | `linear`. */
		source: text("source").notNull(),
		/** Cron expression + timezone, or the condition set for an event source. */
		spec: jsonb("spec").notNull().default(sql`'{}'::jsonb`),
		/** `repo` | `environment`. */
		targetKind: text("target_kind").notNull(),
		targetId: uuid("target_id").notNull(),
		prompt: text("prompt").notNull(),
		runtime: text("runtime"),
		enabled: boolean("enabled").notNull().default(true),
		consecutiveFailures: integer("consecutive_failures").notNull().default(0),
		pausedReason: text("paused_reason"),
		lastRunAt: timestamp("last_run_at", { withTimezone: true }),
		nextRunAt: timestamp("next_run_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		index("automations_org_idx").on(table.orgId),
		// The scheduler reads exactly this: enabled automations that are due.
		index("automations_due_idx").on(table.enabled, table.nextRunAt),
	],
);

export const automationRuns = pgTable(
	"automation_runs",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		automationId: uuid("automation_id")
			.notNull()
			.references(() => automations.id),
		sessionId: uuid("session_id").references(() => sessions.id),
		status: text("status").notNull().default("running"),
		error: text("error"),
		/**
		 * The delivery identity for an event-triggered run — a Sentry event id, a
		 * sender's `X-Harbor-Delivery-Id`, or a hash of the raw body. Null for cron
		 * and manual "Run now" runs, which have no external delivery to deduplicate.
		 *
		 * This is the whole idempotency guarantee. Slack, Sentry and webhook senders
		 * all retry a delivery that did not get a 2xx, and a retry re-runs the whole
		 * pipeline — so without a durable "have I already acted on this exact
		 * delivery" the same alert spawns a second sandbox and a second PR every time
		 * the network has a bad second. The partial unique index below makes the
		 * second insert conflict rather than duplicate, and the reasoning is the same
		 * one the connector `tasks (org, source, source_ref)` index relies on.
		 */
		dedupeKey: text("dedupe_key"),
		startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
		endedAt: timestamp("ended_at", { withTimezone: true }),
	},
	(table) => [
		index("automation_runs_idx").on(table.automationId, table.startedAt),
		// One run per (automation, delivery). Partial, because cron and manual runs
		// carry no delivery id and must not collapse into a single row.
		uniqueIndex("automation_runs_dedupe_idx")
			.on(table.automationId, table.dedupeKey)
			.where(sql`${table.dedupeKey} is not null`),
	],
);

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

/**
 * What everything cost, attributed to the lease it was spent under.
 *
 * Server-side and present from the first migration rather than added when
 * somebody gets a surprise invoice. A background agent platform has at least four
 * independent amplification paths — automations firing on a schedule, child
 * sessions spawning siblings, connectors turning every issue into a session, and
 * retries — and each of them is a loop that spends money without a human in it.
 *
 * Attribution is to `claimId`, not to a session, because the claim is the unit of
 * work that has an intent, a holder and a scope attached. "This lease cost $4.20"
 * is a sentence somebody can act on; "session 8fda cost $4.20" is not.
 *
 * `microUsd` is an integer of millionths of a dollar. Money in a float accumulates
 * error over a million rows, and the error is always in the direction of the
 * total being wrong in a report somebody makes a decision from.
 */
export const costEvents = pgTable(
	"cost_events",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		/** `sandbox_spawn` | `sandbox_seconds` | `tokens` | `provider_call`. */
		kind: text("kind").notNull(),
		claimId: uuid("claim_id").references(() => claims.id),
		sessionId: uuid("session_id").references(() => sessions.id),
		repoId: uuid("repo_id").references(() => repos.id),
		/** The human this is charged to, when there is one. */
		actor: text("actor"),
		provider: text("provider"),
		model: text("model"),
		/** Tokens, seconds, or calls — units depend on `kind`. */
		quantity: integer("quantity").notNull().default(0),
		microUsd: integer("micro_usd").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		index("cost_events_org_created_idx").on(table.orgId, table.createdAt),
		index("cost_events_claim_idx").on(table.claimId),
		index("cost_events_repo_idx").on(table.repoId, table.createdAt),
	],
);

/**
 * Circuit breaker state, one row per provider per org — deliberately NOT per session.
 *
 * A per-session breaker means that when a provider's API is down, every session
 * independently discovers this by burning its own three spawns and its own
 * cooldown. Fifty sessions produce a hundred and fifty doomed spawn attempts
 * against a dependency that is already failing, which is a thundering herd aimed
 * at the thing least able to absorb it. Shared state means the first session pays
 * the discovery cost and the rest are refused instantly with an accurate reason.
 */
export const circuitBreakers = pgTable(
	"circuit_breakers",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		provider: text("provider").notNull(),
		consecutiveFailures: integer("consecutive_failures").notNull().default(0),
		firstFailureAt: timestamp("first_failure_at", { withTimezone: true }),
		lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
		openedAt: timestamp("opened_at", { withTimezone: true }),
		lastErrorType: text("last_error_type"),
	},
	(table) => [uniqueIndex("circuit_breakers_idx").on(table.orgId, table.provider)],
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const orgsRelations = relations(orgs, ({ many }) => ({
	projects: many(projects),
	tasks: many(tasks),
	events: many(events),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
	org: one(orgs, { fields: [projects.orgId], references: [orgs.id] }),
	tasks: many(tasks),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
	org: one(orgs, { fields: [tasks.orgId], references: [orgs.id] }),
	project: one(projects, { fields: [tasks.projectId], references: [projects.id] }),
	claims: many(claims),
}));

export const claimsRelations = relations(claims, ({ one }) => ({
	org: one(orgs, { fields: [claims.orgId], references: [orgs.id] }),
	task: one(tasks, { fields: [claims.taskId], references: [tasks.id] }),
	parent: one(claims, {
		fields: [claims.parentLeaseId],
		references: [claims.id],
		relationName: "lease_parent",
	}),
}));

export type Task = typeof tasks.$inferSelect;
export type Claim = typeof claims.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type HarborEvent = typeof events.$inferSelect;
export type Activity = typeof activity.$inferSelect;

/** Closed set. Every consumer switches on these, so they must not drift. */
export const EVENT_TYPES = [
	"task_created",
	"claimed",
	"released",
	"completed",
	"claim_conflict",
	"claim_expired",
	"claim_renewed",
	"connector_synced",
	"automation_delivery",
	// The record shape a verifier layer will one day write to. Only the `stop`
	// hook produces one today (whether a session ended cleanly). It exists now so
	// the autonomy ramp — a query over this history — has data to accumulate
	// before anything reads it. See src/lib/verifier.ts.
	"verifier_outcome",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Closed set, same discipline as EVENT_TYPES: every consumer switches on these,
 * so a new kind is a deliberate schema change, not a string a normalizer invents.
 * Deliberately coarse — the host's fine-grained event name lives in `tool`/`phase`
 * and `payload`, not in a kind explosion.
 */
export const ACTIVITY_KINDS = [
	"tool_call",
	"session_start",
	"session_end",
	"prompt",
	"stop",
	"subagent",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** The hosts Harbor can ingest activity from. Matches the `[runtime]` route segment. */
export const ACTIVITY_RUNTIMES = [
	"claude-code",
	"codex",
	"opencode",
	"cursor",
	"conductor",
	// A cloud agent with no hooks: its activity is pulled by the devin poll loop
	// (src/devin/poll.ts) and fed through the same `recordActivity` path, not
	// pushed by a host. The generic `/api/hooks/devin` route also accepts it for
	// manual replay, but the poller is authoritative.
	"devin",
] as const;
export type ActivityRuntime = (typeof ACTIVITY_RUNTIMES)[number];

// ---------------------------------------------------------------------------
// Chat: signed events, and the rooms they flow through
// ---------------------------------------------------------------------------

/**
 * An identity, which is a public key.
 *
 * This is the idea the chat model turns on: a human and an agent are the same
 * kind of thing — a keypair — so a channel never has to distinguish them, and
 * agent↔agent, agent↔human and human↔human are one primitive rather than three.
 * `pubkey` is the Ed25519 public key in hex and is the identity used in every
 * signed event; `kind` is display sugar, not a permission.
 *
 * The private half is never here. Humans hold theirs in the browser, agents in
 * their own process; the server only ever learns the public key, so this table
 * can leak in full and forge nothing. `userId` links a human principal back to
 * its dashboard login as provenance; an agent's principal has no user.
 */
export const principals = pgTable(
	"principals",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		/** Ed25519 public key, hex. The identity itself. */
		pubkey: text("pubkey").notNull(),
		kind: text("kind").notNull().default("human"),
		displayName: text("display_name").notNull(),
		userId: uuid("user_id").references(() => users.id),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		// Scoped to the org: a pubkey is only ever resolved together with the org the
		// connection already proved, so two orgs holding the same key is not a
		// collision to prevent.
		uniqueIndex("principals_org_pubkey_idx").on(table.orgId, table.pubkey),
		index("principals_org_idx").on(table.orgId),
	],
);

/**
 * A channel: a room with no owner.
 *
 * The ownerless decision is carried over from sessions and for the same reason —
 * the moment a room belongs to one identity, "hand it to a colleague" stops being
 * retrofittable. `createdBy` is the creator's pubkey as provenance and confers
 * nothing. `kind` shapes how access is granted, never who may be in the room:
 * `group` is key-joinable, `direct` is a fixed roster, `task` is bound to a task.
 * `nextSeq` is the same row-locked counter sessions uses, so two concurrent posts
 * cannot collide on a sequence number.
 */
export const channels = pgTable(
	"channels",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		/** Short, URL-safe, unguessable. Appears in /c/<key>. */
		key: text("key").notNull(),
		kind: text("kind").notNull().default("group"),
		title: text("title").notNull(),
		taskId: uuid("task_id").references(() => tasks.id),
		/** Creator's pubkey. Provenance only, deliberately NOT ownership. */
		createdBy: text("created_by").notNull(),
		nextSeq: integer("next_seq").notNull().default(1),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex("channels_key_idx").on(table.key),
		index("channels_org_activity_idx").on(table.orgId, table.lastActivityAt),
	],
);

/**
 * Membership is the access gate.
 *
 * A subscription and a read both check for a row here before anything is
 * returned, so a private channel cannot leak to a non-member. `lastSeenSeq` is a
 * per-member read cursor — it lets an agent pull everything said since it last
 * looked in one batch, and doubles as the unread count for humans.
 */
export const channelMembers = pgTable(
	"channel_members",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		channelId: uuid("channel_id")
			.notNull()
			.references(() => channels.id),
		/** The member's pubkey. */
		pubkey: text("pubkey").notNull(),
		kind: text("kind").notNull().default("human"),
		displayName: text("display_name").notNull(),
		/** Highest durable seq this member has read. Advances on read. */
		lastSeenSeq: integer("last_seen_seq").notNull().default(0),
		joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex("members_channel_pubkey_idx").on(table.channelId, table.pubkey),
		index("members_channel_idx").on(table.channelId),
	],
);

/**
 * The signed event log — the substrate everything else reads.
 *
 * The primary key is the event id (a hash of the body), which makes redelivery
 * idempotent for free: the same signed event sent twice is one row, and an
 * `ON CONFLICT DO NOTHING` absorbs the duplicate.
 *
 * `sig` is nullable, and the split is deliberate. Content events (`message`,
 * `reaction`) are end-to-end signed by their author and carry a `sig`. Membership
 * and system events (`join`, `leave`, `system`, `channel_create`) are authored by
 * the server in response to an already-authenticated action and have none.
 * Ephemeral kinds (`typing`, `presence`) are never written here at all.
 *
 * `authoredAt` is the author's own clock; `ingestedAt` is when the server accepted
 * it. Ordering never uses either — it uses `seq`, which the server assigns.
 */
export const chatEvents = pgTable(
	"chat_events",
	{
		/** SHA-256 hex of the canonical serialization. The event's identity. */
		id: text("id").primaryKey(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		channelId: uuid("channel_id")
			.notNull()
			.references(() => channels.id),
		/** Author's pubkey. */
		pubkey: text("pubkey").notNull(),
		authorKind: text("author_kind").notNull().default("human"),
		kind: text("kind").notNull(),
		/** Monotonic within a channel. The only thing ordering depends on. */
		seq: integer("seq").notNull(),
		content: text("content").notNull(),
		tags: jsonb("tags").notNull().default([]),
		/** Ed25519 signature, hex. Null for server-authored system/membership events. */
		sig: text("sig"),
		authoredAt: timestamp("authored_at", { withTimezone: true }).notNull(),
		ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		// The ordered read path, and the backstop against a seq being reused.
		uniqueIndex("chat_events_channel_seq_idx").on(table.channelId, table.seq),
		index("chat_events_org_ingested_idx").on(table.orgId, table.ingestedAt),
	],
);

export const channelsRelations = relations(channels, ({ one, many }) => ({
	org: one(orgs, { fields: [channels.orgId], references: [orgs.id] }),
	members: many(channelMembers),
	events: many(chatEvents),
}));

export const channelMembersRelations = relations(channelMembers, ({ one }) => ({
	channel: one(channels, { fields: [channelMembers.channelId], references: [channels.id] }),
}));

export const chatEventsRelations = relations(chatEvents, ({ one }) => ({
	channel: one(channels, { fields: [chatEvents.channelId], references: [channels.id] }),
}));

export type Principal = typeof principals.$inferSelect;
export type Channel = typeof channels.$inferSelect;
export type ChannelMember = typeof channelMembers.$inferSelect;
export type ChatEvent = typeof chatEvents.$inferSelect;

// ---------------------------------------------------------------------------
// Prebuilt repo images — the producer of `repo_image` boots
// ---------------------------------------------------------------------------

/**
 * The outcomes an image build attempt can end in. Closed set, same discipline as
 * every other status in this file: consumers switch on these with no `default`
 * arm, so adding one is a compile error at each decision site rather than a string
 * a normalizer quietly invents.
 *
 * `running` is the only non-terminal value, and it is load-bearing: the partial
 * unique index `one_active_build_per_repo` keys on `finished_at is null`, so a
 * `running` row IS the "one build in flight" claim. `skipped` records a tick that
 * declined to build — a concurrency loser, an unchanged HEAD, or a refused budget
 * reservation — as data rather than as a silent no-op, so the schedule is auditable.
 */
export const IMAGE_BUILD_STATUSES = ["running", "success", "failed", "skipped"] as const;
export type ImageBuildStatus = (typeof IMAGE_BUILD_STATUSES)[number];

/**
 * The published prebuilt-image pointer for one repo, and the schedule that feeds it.
 *
 * One row per image-building repo, carrying two things that a naive design would
 * split into two tables and then have to keep consistent across a crash: the
 * *pointer* a spawn reads (`imageRef`/`builtFromSha`/`builtAt`), and the *schedule*
 * a tick advances (`nextBuildAt`/`consecutiveFailures`/`pausedReason`). It is the
 * single-table `automations` model (see that table) applied to image builds, for
 * the same reason: the auto-pause after repeated failures is the whole point, and
 * splitting the counter from the pointer buys nothing but a second thing to get
 * wrong.
 *
 * The invisibility of build time depends on one rule this shape enforces: the
 * pointer columns advance ONLY inside the transaction that finalises a `success`.
 * A build that fails, times out, or is still running touches the schedule columns
 * and leaves the pointer exactly as the last good build left it — so a session
 * spawned mid-build boots the previous image, never a half-built one and never a
 * cold boot it would not otherwise have paid. The columns are nullable because a
 * repo that has opted in but never built successfully has a schedule and no pointer
 * yet; a spawn reading a null `imageRef` simply falls through to today's behaviour.
 *
 * Whether image building is enabled, how stale it may get, and which base image to
 * build from are per-repo *config*, not columns — they live in `repos.config` and
 * resolve through `setting()`. Only mutable per-repo *state* lives here.
 */
export const repoImages = pgTable(
	"repo_images",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		repoId: uuid("repo_id")
			.notNull()
			.references(() => repos.id),
		/** The provider handle to boot from. Null until the first successful build. */
		imageRef: text("image_ref"),
		/** The default-branch commit the current image was built at. Drives the unchanged-HEAD skip. */
		builtFromSha: text("built_from_sha"),
		/** When the current image was published. Drives the freshness cutoff at spawn. */
		builtAt: timestamp("built_at", { withTimezone: true }),
		/** The provider `kind` that built it, for display and for the health endpoint. */
		builtByProvider: text("built_by_provider"),
		/** Advanced BEFORE a build runs, so a crash mid-build does not leave the repo perpetually due. */
		nextBuildAt: timestamp("next_build_at", { withTimezone: true }),
		consecutiveFailures: integer("consecutive_failures").notNull().default(0),
		/** Set when consecutive failures cross the threshold; non-null excludes the repo from the tick. */
		pausedReason: text("paused_reason"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		// One pointer per repo. The tick upserts against this.
		uniqueIndex("repo_images_repo_idx").on(table.repoId),
		// The scheduler reads exactly this: repos whose next build is due.
		index("repo_images_due_idx").on(table.nextBuildAt),
	],
);

/**
 * One image build attempt.
 *
 * The append-only ledger behind `repo_images`: every tick that decides to build
 * writes a `running` row here first, and the `one_active_build_per_repo` partial
 * unique index is what makes "two concurrent ticks for one repo must not both
 * build" a database guarantee rather than a hope. Two racing ticks both INSERT a
 * `running` row; Postgres serialises them on the index; exactly one lands and the
 * loser's INSERT conflicts, at which point the loser records a `skipped` row and
 * moves on. This is the same coordination `one_active_lease_per_scope` provides for
 * claims — a partial index, not a read-then-write check, because the latter races
 * under READ COMMITTED and a mock passes it every time.
 *
 * `finishedAt is null` IS the predicate the index is partial on, so a terminal
 * status must always be written together with `finishedAt`, and a crash that leaves
 * a `running` row with a null `finishedAt` correctly blocks new builds until the
 * stuck row is swept — the safe direction to fail.
 */
export const imageBuilds = pgTable(
	"image_builds",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orgId: uuid("org_id")
			.notNull()
			.references(() => orgs.id),
		repoId: uuid("repo_id")
			.notNull()
			.references(() => repos.id),
		status: text("status").notNull().default("running"),
		/** The default-branch HEAD this attempt built (or would have built) at. */
		commitSha: text("commit_sha"),
		startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
		/** Null while running. Written together with a terminal status; the index depends on it. */
		finishedAt: timestamp("finished_at", { withTimezone: true }),
		failureReason: text("failure_reason"),
		/** Where the build log was written, for the human debugging a `failed` row. */
		logLocation: text("log_location"),
	},
	(table) => [
		index("image_builds_repo_idx").on(table.repoId, table.startedAt),
		// One in-flight build per repo. Partial on the running predicate, so terminal
		// rows do not collapse into a single row and history is preserved.
		uniqueIndex("one_active_build_per_repo")
			.on(table.repoId)
			.where(sql`${table.finishedAt} is null`),
	],
);

export type RepoImage = typeof repoImages.$inferSelect;
export type ImageBuild = typeof imageBuilds.$inferSelect;
