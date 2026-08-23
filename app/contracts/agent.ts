// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The coding-agent contract. Bring your own agent.
 *
 * This file exists because "the supervisor starts the agent" is not a
 * specification. Without naming the executable, the input format, the event
 * output, what stop means as distinct from cancel, where model credentials come
 * from, who is authoritative for token counts, and what happens when the process
 * dies mid-turn, neither the sandbox runtime nor cost accounting can be written
 * coherently — they would each invent an answer and the answers would disagree.
 *
 * So it is defined once, here, before either is built.
 *
 * The reason it is an interface at all rather than one hard-coded agent: a
 * company adopting a background agent platform has already standardised on a
 * coding agent, and asking them to switch is asking them to re-run an evaluation
 * they finished last quarter. The competing open implementation is welded to a
 * single agent, and that is the reason it cannot be adopted by a team that uses
 * a different one. Harbor already ships event normalizers for four of them
 * (`src/activity/`), which is most of the work.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The agents Harbor knows how to drive.
 *
 * `custom` is the escape hatch and is deliberately last: an operator supplies an
 * argv template and a stream format, and gets the same lifecycle as a built-in.
 * Without it, "bring your own agent" means "bring one of ours", and the first
 * team with an in-house agent has to fork.
 */
export const AGENT_RUNTIMES = ["claude-code", "codex", "opencode", "cursor", "custom"] as const;
export type AgentRuntime = (typeof AGENT_RUNTIMES)[number];

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * How git identity is supplied to a turn.
 *
 * A discriminated union with exactly two members, and **no third meaning
 * "figure it out"**. Commit attribution is the trust anchor of the whole PR
 * model: the human authors the commit, the bot commits it, and therefore the
 * human cannot approve their own agent's work. An adapter that guesses an
 * identity when one is missing — falling back to the bot, or to the last person
 * who spoke, or to a default in a config file — breaks that quietly and produces
 * a repository history that lies about who asked for what.
 *
 * So a missing identity raises. `agent-only` is a real, explicit choice for work
 * nobody is claiming authorship of (a scheduled dependency bump); it is not the
 * fallback for "we could not tell".
 */
export type GitIdentity =
	| { mode: "agent-only" }
	| { mode: "attributed-user"; name: string; email: string };

export class GitIdentityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GitIdentityError";
	}
}

/**
 * Build an identity, or refuse. The only constructor — adapters must not build
 * the object literal themselves, because that is where the guess creeps back in.
 */
export function attributedIdentity(
	name: string | null | undefined,
	email: string | null | undefined,
): GitIdentity {
	if (!name?.trim() || !email?.trim()) {
		throw new GitIdentityError(
			"Cannot attribute this commit: the prompt author has no name and email on file. "
				+ "Either connect their source-control identity, or enqueue with mode 'agent-only' "
				+ "to state explicitly that nobody is claiming authorship. Harbor will not guess, "
				+ "because a wrong author makes the repository history lie about who asked for a change.",
		);
	}
	return { mode: "attributed-user", name: name.trim(), email: email.trim() };
}

/**
 * One turn of work handed to an agent.
 *
 * `resume_token` is what makes a session a conversation rather than a series of
 * unrelated commands. Every supported agent has some notion of continuing a prior
 * thread (`--resume`, a session id, a transcript path); the adapter maps this
 * opaque string onto whichever it is. Null means start fresh.
 */
export interface AgentTurnRequest {
	prompt_id: string;
	session_id: string;
	seq: number;
	body: string;
	identity: GitIdentity;
	/** Opaque to Harbor; meaningful only to the adapter that produced it. */
	resume_token: string | null;
	/** Absolute path the agent runs in. The primary repository's clone. */
	workspace: string;
	/** Model override for this turn, if the session or prompt asked for one. */
	model?: string;
	/** MCP servers to inject, already resolved and authorised. */
	mcp_servers?: Record<string, McpServerSpec>;
	/** Wall-clock ceiling for this turn. Never a module constant — see src/config.ts. */
	timeout_ms: number;
}

export interface McpServerSpec {
	type: "http" | "stdio";
	url?: string;
	command?: string;
	args?: string[];
	headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Stop versus cancel — two different words for two different things
// ---------------------------------------------------------------------------

/**
 * `stop` asks the agent to wind up: finish the tool call in flight, write what
 * it has, exit cleanly. Work already done survives and the turn is recorded as
 * stopped. This is the button a human presses when they realise they asked for
 * the wrong thing.
 *
 * `cancel` kills the process. Nothing is written, the turn is recorded as
 * cancelled, and the workspace is left wherever the agent got to. This is what a
 * timeout or a budget breach uses.
 *
 * They were one verb in the first draft, and collapsing them means either every
 * timeout waits politely for an agent that may be wedged, or every human "stop"
 * throws away a half-finished edit. Neither is acceptable, so there are two.
 */
export const AGENT_INTERRUPTS = ["stop", "cancel"] as const;
export type AgentInterrupt = (typeof AGENT_INTERRUPTS)[number];

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * What an adapter emits while a turn runs.
 *
 * Normalised — every agent has its own stream format and this is the shape they
 * are all translated into, by the normalizers already in `src/activity/`. The
 * translation happens in the sandbox, close to the process that produced it, so
 * the control plane never has to know that one agent calls it `assistant` and
 * another calls it `agent_message`.
 */
export type AgentStreamEvent =
	| { kind: "message"; text: string }
	| { kind: "tool_call"; tool: string; phase: "pre" | "post"; summary: string }
	| { kind: "usage"; usage: AgentUsage }
	| { kind: "warning"; message: string };

/**
 * Token and cost accounting, and **who is authoritative for it**.
 *
 * The adapter is authoritative when the agent reports usage itself, which the
 * supported ones do. Harbor does not re-tokenize, estimate from character counts,
 * or reconcile against a provider bill — an estimate that disagrees with the real
 * invoice is worse than no number, because somebody will make a decision from it.
 *
 * When an agent reports nothing, `source` is `unavailable` and the cost row is
 * written with `quantity: 0` and an explicit marker rather than a guess. A gap in
 * the data reads as a gap; a fabricated number reads as fact.
 */
export interface AgentUsage {
	source: "agent_reported" | "unavailable";
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens?: number;
	cache_write_tokens?: number;
	model: string | null;
	/**
	 * Cost the agent itself reported, in millionths of a dollar. Absent when the
	 * agent reports tokens but not money — Harbor then prices it from the model
	 * table and marks the row `estimated`.
	 */
	micro_usd?: number;
}

/** How a turn ended. Exhaustive; callers switch with no `default`. */
export type AgentTurnResult =
	| { status: "completed"; resume_token: string | null; usage: AgentUsage }
	| { status: "stopped"; resume_token: string | null; usage: AgentUsage }
	| { status: "cancelled"; resume_token: string | null; usage: AgentUsage }
	| { status: "timed_out"; resume_token: string | null; usage: AgentUsage }
	| {
			status: "failed";
			resume_token: string | null;
			usage: AgentUsage;
			exit_code: number | null;
			message: string;
	  };

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * What every agent integration implements. Six members, and each earns its place.
 */
export interface AgentAdapter {
	runtime: AgentRuntime;

	/**
	 * Where model credentials come from, declared rather than assumed.
	 *
	 * Some agents take an API key in the environment; some carry their own
	 * subscription OAuth and want no key at all; one wants a file on disk. An
	 * adapter that silently expects `ANTHROPIC_API_KEY` and gets nothing produces
	 * a boot that succeeds and a first turn that fails with a provider error,
	 * which reads to the user as "Harbor is broken".
	 *
	 * Declaring it means the control plane can refuse *before* spawning a box —
	 * cheaper, and the error names the variable.
	 */
	credentials: AgentCredentialSpec;

	/** Argv for a turn. Never a shell string: the prompt is attacker-influenced text. */
	command(request: AgentTurnRequest): { bin: string; args: string[]; env: Record<string, string> };

	/** One line of the agent's stdout → zero or more normalised events. */
	parseLine(line: string): AgentStreamEvent[];

	/** How the process is asked to wind up, versus killed. */
	interrupt(interrupt: AgentInterrupt): NodeJS.Signals;

	/**
	 * Pull the resume token out of a finished run, so the next turn continues the
	 * same thread rather than starting a stranger.
	 */
	resumeTokenFrom(stdout: string, workspace: string): string | null;

	/**
	 * Crash recovery.
	 *
	 * If the sandbox restarts mid-turn — the box was snapshotted, the supervisor
	 * was OOM-killed, the provider migrated the machine — can the turn be
	 * reattached, or must it be replayed?
	 *
	 * `reattach` means the agent persists enough state to be resumed from disk.
	 * `replay` means the turn is re-sent from the queue, which is safe because
	 * prompts are idempotent at the queue level and the workspace is a git
	 * checkout that can be inspected. `abandon` means neither is safe and the turn
	 * is recorded as failed with a reason the user can read.
	 *
	 * Declaring this per adapter stops the supervisor from applying one recovery
	 * strategy to agents with genuinely different durability.
	 */
	recovery: "reattach" | "replay" | "abandon";
}

/**
 * How an adapter gets model access. A discriminated union, because "an API key"
 * is not general enough and "whatever the agent needs" is not specific enough.
 */
export type AgentCredentialSpec =
	| { mode: "env_key"; variable: string; required: true }
	| { mode: "env_key_optional"; variable: string; required: false }
	| { mode: "subscription_oauth"; broker: string }
	| { mode: "none" };
