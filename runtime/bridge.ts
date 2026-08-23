// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The sandbox's half of the control-plane connection: SSE down, HTTP POST up.
 *
 * ## Why not a WebSocket
 *
 * Stated here rather than only in the contract, because this is the file somebody
 * will be tempted to "fix". A background agent platform is adopted by putting it
 * behind whatever ingress the company already runs — an ALB, an nginx someone
 * configured in 2019, a corporate proxy, an Istio sidecar. Every one of those
 * handles `POST` and `text/event-stream` with no configuration. A meaningful
 * fraction of them mangle a protocol upgrade: they strip the `Upgrade` header,
 * buffer the response, or terminate the connection at a 60-second idle timeout
 * that nobody can find the setting for. The traffic is also lopsided — thousands
 * of events up, four verbs down — so a duplex channel buys almost nothing in
 * exchange for the deployments it costs.
 *
 * ## The invariant that shapes everything below
 *
 * **Lifecycle state is authoritative over transport.** Losing the connection does
 * not stop the agent, does not fail the turn and does not discard work. The agent
 * process keeps running, its output keeps accumulating in a bounded buffer, and
 * when the connection returns the record catches up — with an explicit marker if
 * anything was lost. The opposite arrangement, where a dropped SSE stream aborts
 * the turn, means a thirty-second network blip costs twenty minutes of an agent's
 * work and a user's money, and network blips are not rare.
 *
 * Everything policy-shaped here — how much to buffer, how long to back off, what a
 * dropped event leaves behind — lives in `boot-decisions.ts` as a pure function
 * and is tested there at its exact boundary. This file performs the effects.
 */

import { execFile } from "node:child_process";
import { setting } from "../core/kernel/config.js";
import {
	attributedIdentity,
	GitIdentityError,
	type AgentInterrupt,
	type GitIdentity,
} from "../app/contracts/agent.js";
import {
	correlationHeader,
	type BridgeCommand,
	type BridgeCommandType,
	type SandboxEvent,
	type SandboxEventType,
} from "../app/contracts/index.js";
import {
	assertNever,
	pushBounded,
	reconnectDelayMs,
	type BufferEntry,
} from "./boot-decisions.js";

// ---------------------------------------------------------------------------
// Git identity — refused, never guessed
// ---------------------------------------------------------------------------

/**
 * The shape of `BridgeCommand.prompt` as this file reads it.
 *
 * Wider than the contract on purpose, in one direction: `mode`. The contract
 * carries `author` and `author_email` but no explicit identity mode, so an
 * `agent-only` prompt — a scheduled dependency bump nobody is claiming authorship
 * of — is currently expressible only as "email is null", which is exactly the
 * ambiguity `GitIdentity` exists to remove. This reads an optional `mode` when the
 * control plane sends one and refuses when it does not, rather than inventing a
 * default. See the note at the bottom of `docs/sandbox-runtime.md`.
 */
export interface PromptIdentityFields {
	author?: string | null;
	author_email?: string | null;
	mode?: unknown;
}

/**
 * Resolve the git identity for a prompt, or raise.
 *
 * There is no third branch and there must never be one. Commit attribution is the
 * trust anchor of the whole PR model: the human authors, the bot commits,
 * therefore the human cannot approve their own agent's work. An identity guessed
 * here — falling back to the bot, to the session creator, to the last person who
 * spoke — makes the repository history lie about who asked for a change, silently,
 * in a way that is discovered months later by someone auditing a merge.
 *
 * So: an explicit `agent-only` mode is honoured, a complete name and email are
 * honoured, and everything else raises. An unrecognised mode string raises too — a
 * control plane sending `mode: "auto"` is a version skew, and quietly treating a
 * word we do not understand as "do whatever" is the same guess wearing a hat.
 */
export function identityForPrompt(prompt: PromptIdentityFields): GitIdentity {
	const mode = prompt.mode;
	if (mode !== undefined && mode !== null) {
		if (mode === "agent-only") return { mode: "agent-only" };
		if (mode !== "attributed-user") {
			throw new GitIdentityError(
				`This prompt carries identity mode ${JSON.stringify(mode)}, which this sandbox `
					+ "runtime does not recognise. Refusing rather than picking one: an unrecognised "
					+ "mode is a version skew between the control plane and the sandbox image, and "
					+ "guessing produces commits attributed to the wrong person.",
			);
		}
	}
	// Throws GitIdentityError with the full explanation when either half is absent.
	return attributedIdentity(prompt.author, prompt.author_email);
}

// ---------------------------------------------------------------------------
// Configuration and seams
// ---------------------------------------------------------------------------

export interface BridgeConfig {
	/** Origin of the control plane, no trailing slash. */
	controlUrl: string;
	sandboxId: string;
	sessionId: string;
	/** Bearer token minted for this sandbox. Never logged, never in an event. */
	token: string;
	/**
	 * The fence this box was spawned with, presented on every privileged call.
	 *
	 * Authentication alone cannot distinguish the current box from an honest zombie:
	 * a sandbox whose lease lapsed while it kept running still holds a genuine
	 * token. The control plane rejects a stale fence with 409, and this bridge
	 * treats that as final rather than retryable — see `handleFenceRefusal`.
	 */
	fencingToken: number;
	traceId?: string;
	/** Where `git config` is applied before an attributed turn. */
	workspace: string;
}

/** One turn, as the bridge asks for it. The supervisor owns how it is executed. */
export interface TurnInvocation {
	promptId: string;
	seq: number;
	body: string;
	identity: GitIdentity;
	traceId?: string;
	timeoutMs: number;
	/** Where to push what this turn commits. Null disables the push for this turn. */
	pushBranch: string | null;
	baseBranch: string | null;
}

/**
 * What the bridge needs done that it does not do itself.
 *
 * A seam rather than a class hierarchy, because the two callers are the supervisor
 * and the test, and the test has to be able to drive a full partition-and-recover
 * cycle without a network, a git binary or an agent CLI.
 */
export interface BridgeHandlers {
	runTurn(invocation: TurnInvocation): Promise<void>;
	interrupt(kind: AgentInterrupt): void;
	/** Flush and quiesce so a filesystem snapshot is not taken mid-write. */
	quiesceForSnapshot(): Promise<void>;
	shutdown(reason: string): void;
}

export interface BridgeDeps {
	fetch: typeof fetch;
	now: () => number;
	random: () => number;
	sleep: (ms: number) => Promise<void>;
	/** Applied in the workspace before an attributed turn. */
	setGitIdentity: (workspace: string, identity: GitIdentity) => Promise<void>;
	log: (code: string, detail?: Record<string, unknown>) => void;
}

export type OutboundEvent = {
	type: SandboxEventType;
	payload?: Record<string, unknown>;
};

export function defaultBridgeDeps(): BridgeDeps {
	return {
		fetch: globalThis.fetch,
		now: () => Date.now(),
		random: () => Math.random(),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()),
		setGitIdentity: applyGitIdentity,
		log: (code, detail) => {
			console.log(`[bridge] ${code}${detail ? ` ${JSON.stringify(detail)}` : ""}`);
		},
	};
}

/**
 * Write the author into the repository's own config before the turn runs.
 *
 * The adapter already sets `GIT_AUTHOR_*` in the child's environment, so why also
 * write the config? Because agents shell out, and what they shell out to is not
 * always the agent's own child: a `Makefile` target, a pre-commit hook, a
 * `husky` script, a `gh pr create` in a subshell that re-execs through a wrapper.
 * Environment inheritance survives most of those and not all of them, and the one
 * that does not is the one that produces a commit authored by `root@sandbox`. The
 * config write is durable for anything run inside the checkout, so the two
 * together cover both paths.
 */
async function applyGitIdentity(workspace: string, identity: GitIdentity): Promise<void> {
	const name = identity.mode === "agent-only" ? "Harbor" : identity.name;
	const email =
		identity.mode === "agent-only" ? "harbor[bot]@users.noreply.github.com" : identity.email;

	await gitConfig(workspace, "user.name", name);
	await gitConfig(workspace, "user.email", email);
}

function gitConfig(cwd: string, key: string, value: string): Promise<void> {
	return new Promise((resolve, reject) => {
		// argv, never a shell string: `value` is a display name that came from an
		// external identity provider and can contain anything a person can type.
		execFile("git", ["config", key, value], { cwd }, (error) =>
			error ? reject(error) : resolve(),
		);
	});
}

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

export class Bridge {
	private buffer: Array<BufferEntry<SandboxEvent>> = [];
	private flushing: Promise<void> | null = null;
	private turns: Promise<void> = Promise.resolve();
	private heartbeat: NodeJS.Timeout | null = null;
	private stopped = false;
	private attempt = 0;
	/**
	 * Prompt ids this box has already accepted, for the life of the process.
	 *
	 * Unbounded, and that is the right call rather than an oversight: it holds one
	 * short string per prompt, `maxQueueDepth` bounds how many can be outstanding,
	 * and a session long enough for this to matter has cost thousands of times more
	 * in tokens than it has in strings. An LRU here would evict the id of a prompt
	 * whose redelivery is still possible, which is the one thing it must not do.
	 */
	private readonly seenPrompts = new Set<string>();

	constructor(
		private readonly config: BridgeConfig,
		private readonly handlers: BridgeHandlers,
		private readonly deps: BridgeDeps = defaultBridgeDeps(),
	) {}

	/**
	 * Queue an event for the control plane.
	 *
	 * Synchronous and infallible by design. Every caller is on a path where a
	 * rejected promise would have to be swallowed anyway — a line of agent stdout, a
	 * boot warning, a heartbeat — and an `emit` that can throw is an `emit` that
	 * eventually kills a turn because the control plane was briefly unreachable.
	 */
	emit(event: OutboundEvent): void {
		const full: SandboxEvent = {
			type: event.type,
			sandbox_id: this.config.sandboxId,
			session_id: this.config.sessionId,
			at: new Date(this.deps.now()).toISOString(),
		};
		if (this.config.traceId !== undefined) full.trace_id = this.config.traceId;
		if (event.payload !== undefined) full.payload = event.payload;

		const push = pushBounded(this.buffer, full, setting("bridgeBufferLimit"), full.at as string);
		this.buffer = push.buffer;
		if (push.gap === "created") {
			this.deps.log("bridge.buffer_overflow", { dropped: push.droppedNow });
		}
		void this.flush();
	}

	/** Everything still waiting to be sent. Ordered, gap markers included. */
	bufferSnapshot(): ReadonlyArray<BufferEntry<SandboxEvent>> {
		return this.buffer;
	}

	/**
	 * Connect, stay connected, and keep trying.
	 *
	 * Resolves only when `stop()` is called. Never rejects: a bridge whose start
	 * promise rejects on the first failed connect is a bridge that gives up on a
	 * control plane that was mid-deploy, and the sandbox it was serving then sits
	 * there costing money with an agent nobody can reach.
	 */
	async start(): Promise<void> {
		this.startHeartbeat();
		while (!this.stopped) {
			try {
				await this.streamCommands();
				// A clean end of stream is normal — a proxy idle timeout, a control-plane
				// rolling restart — and is not a failure, so the attempt counter does not
				// grow and the next connect is immediate rather than backed off.
				this.attempt = 0;
			} catch (error) {
				this.attempt += 1;
				this.deps.log("bridge.stream_error", {
					attempt: this.attempt,
					message: (error as Error).message,
				});
			}
			if (this.stopped) break;
			await this.deps.sleep(this.nextDelayMs());
		}
	}

	/**
	 * The backoff, with both bounds derived from settings rather than invented.
	 *
	 * The ceiling is the stale-heartbeat threshold: there is no value in a
	 * reconnect scheduled further out than the point at which the control plane has
	 * already written this box off, because by then the session has been failed over
	 * and coming back adds a second writer rather than a recovery. The base is a
	 * sixteenth of the heartbeat interval, so an ordinary blip is recovered from
	 * well inside a single heartbeat and never shows up as a missed one.
	 */
	private nextDelayMs(): number {
		return reconnectDelayMs({
			attempt: this.attempt,
			baseMs: Math.floor(setting("sandboxHeartbeatIntervalMs") / 16),
			ceilingMs: setting("sandboxStaleHeartbeatMs"),
			random: this.deps.random(),
		});
	}

	private startHeartbeat(): void {
		if (this.heartbeat !== null) return;
		const interval = setInterval(() => {
			this.emit({ type: "heartbeat", payload: { buffered: this.buffer.length } });
		}, setting("sandboxHeartbeatIntervalMs"));
		interval.unref?.();
		this.heartbeat = interval;
	}

	/**
	 * Stop accepting work and get the record out.
	 *
	 * Called from SIGTERM/SIGINT and from a `shutdown` command. The drain is the
	 * whole reason this is not just `process.exit`: a container being stopped has a
	 * grace period, and the events sitting in the buffer at that moment are the ones
	 * that explain *why* the session ended. Losing them means the timeline stops
	 * mid-sentence and the user is left to guess.
	 *
	 * `graceMs` bounds the attempt, because a sandbox that refuses to exit is killed
	 * by the provider anyway and taking the full grace period to fail is worse than
	 * failing fast.
	 */
	async stop(graceMs: number): Promise<void> {
		this.stopped = true;
		if (this.heartbeat !== null) {
			clearInterval(this.heartbeat);
			this.heartbeat = null;
		}
		const deadline = this.deps.now() + graceMs;
		while (this.buffer.length > 0 && this.deps.now() < deadline) {
			const before = this.buffer.length;
			await this.flush();
			if (this.buffer.length === 0) break;
			if (this.buffer.length >= before) {
				// No progress: the control plane is unreachable. Sleeping the whole grace
				// period on a dead endpoint just delays the exit, so back off once and
				// re-check rather than spinning.
				await this.deps.sleep(this.nextDelayMs());
			}
		}
		if (this.buffer.length > 0) {
			this.deps.log("bridge.drain_incomplete", { remaining: this.buffer.length });
		}
	}

	// -- Upstream ------------------------------------------------------------

	/**
	 * Send whatever is buffered, and remove only what was actually accepted.
	 *
	 * Entries are removed **by identity**, not by count. The obvious version —
	 * "drop the first N" — is wrong whenever an overflow evicts from the head while
	 * a POST is in flight, at which point the first N are no longer the N that were
	 * sent and a successful flush silently deletes events that never left the box.
	 * That is a data-loss bug that only appears under exactly the conditions this
	 * buffer exists for, which is the worst possible place for one.
	 */
	private flush(): Promise<void> {
		if (this.flushing !== null) return this.flushing;
		if (this.buffer.length === 0) return Promise.resolve();

		// One batch per call, capped at the ingest endpoint's own per-batch limit
		// rather than at a number invented here. `bridgeBufferLimit` defaults to twice
		// `maxSnapshotEvents`, so a full buffer flushed in one POST would be refused
		// with a 413 — and a bridge that only fails when the buffer is full is a
		// bridge that only fails during the outage it exists to survive.
		const inFlight = this.buffer.slice(0, setting("maxSnapshotEvents"));
		const body = JSON.stringify({ events: inFlight.map((entry) => this.toWire(entry)) });

		const run = (async () => {
			try {
				const response = await this.deps.fetch(
					`${this.config.controlUrl}/api/sandbox/${this.config.sandboxId}/events`,
					{ method: "POST", headers: this.headers({ "content-type": "application/json" }), body },
				);
				if (response.status === 409) {
					// The fence was refused. This box is superseded and everything it has to
					// say is now noise at best and a second writer at worst, so it stops
					// rather than retrying — retrying is what turns a lapsed lease into two
					// agents interleaving sentences into one transcript.
					this.deps.log("bridge.fence_refused", { status: 409, direction: "up" });
					this.handlers.shutdown("fence_superseded");
					return;
				}
				if (!response.ok) {
					this.deps.log("bridge.flush_rejected", { status: response.status });
					return;
				}
				const sent = new Set<BufferEntry<SandboxEvent>>(inFlight);
				this.buffer = this.buffer.filter((entry) => !sent.has(entry));
				// A backlog larger than one batch drains over several POSTs rather than
				// waiting for the next `emit` to nudge it — an agent that goes quiet right
				// after a partition would otherwise leave the rest of its transcript in the
				// buffer until the box was stopped.
				if (this.buffer.length > 0) queueMicrotask(() => void this.flush());
			} catch (error) {
				this.deps.log("bridge.flush_failed", { message: (error as Error).message });
			} finally {
				this.flushing = null;
			}
		})();

		this.flushing = run;
		return run;
	}

	/**
	 * A gap becomes a first-class event on the timeline, not a log line.
	 *
	 * `log` is the carrier because `SandboxEventType` has no gap member and inventing
	 * one in the sandbox would be exactly the drift the contract file exists to
	 * prevent. The payload is explicit enough that the UI can render it as a break in
	 * the stream: the hole is in the record, which is the entire requirement.
	 */
	private toWire(entry: BufferEntry<SandboxEvent>): SandboxEvent {
		if (entry.kind === "event") return entry.event;
		return {
			type: "log",
			sandbox_id: this.config.sandboxId,
			session_id: this.config.sessionId,
			at: entry.lastDroppedAt,
			payload: {
				level: "warning",
				code: "bridge.buffer_overflow",
				dropped_events: entry.droppedEvents,
				first_dropped_at: entry.firstDroppedAt,
				last_dropped_at: entry.lastDroppedAt,
				message:
					`${entry.droppedEvents} event(s) were dropped while this sandbox could not reach `
					+ "Harbor. The agent kept working; this part of its transcript is gone. Raise "
					+ "HARBOR_BRIDGE_BUFFER_LIMIT if partitions here are routinely this long.",
			},
		};
	}

	private headers(extra: Record<string, string> = {}): Record<string, string> {
		const headers: Record<string, string> = {
			authorization: `Bearer ${this.config.token}`,
			"x-harbor-fencing-token": String(this.config.fencingToken),
			[correlationHeader("sandbox_id")]: this.config.sandboxId,
			[correlationHeader("session_id")]: this.config.sessionId,
			...extra,
		};
		if (this.config.traceId !== undefined) {
			headers[correlationHeader("trace_id")] = this.config.traceId;
		}
		return headers;
	}

	// -- Downstream ----------------------------------------------------------

	private async streamCommands(): Promise<void> {
		const response = await this.deps.fetch(
			`${this.config.controlUrl}/api/sandbox/${this.config.sandboxId}/commands`,
			{ method: "GET", headers: this.headers({ accept: "text/event-stream" }) },
		);
		if (response.status === 409) {
			// Same reasoning as the uplink: a refused fence is a verdict, not a blip.
			// Backing off and retrying a superseded box forever is how a zombie stays
			// connected long enough to be handed a prompt.
			this.deps.log("bridge.fence_refused", { status: 409, direction: "down" });
			this.handlers.shutdown("fence_superseded");
			this.stopped = true;
			return;
		}
		if (!response.ok || response.body === null) {
			throw new Error(`command stream returned ${response.status}`);
		}
		this.attempt = 0;
		this.deps.log("bridge.connected");

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let pending = "";

		while (!this.stopped) {
			const { done, value } = await reader.read();
			if (done) return;
			pending += decoder.decode(value, { stream: true });

			// SSE frames are separated by a blank line. Anything before the last
			// separator is complete; the tail is held until more bytes arrive, which is
			// what stops a JSON object split across two TCP segments from being parsed
			// as two broken ones.
			const parts = pending.split("\n\n");
			pending = parts.pop() ?? "";
			for (const frame of parts) this.handleFrame(frame);
		}
	}

	/**
	 * Parse one frame, and **never throw**.
	 *
	 * A malformed frame must not kill the loop. The realistic sources are a proxy
	 * that injected a keep-alive comment, a control plane a version ahead sending a
	 * field this image does not know, and a truncated write during a deploy. In all
	 * three the correct response is to skip the frame and keep the connection: an
	 * exception here disconnects a healthy sandbox, and if the malformed frame is
	 * being retransmitted, disconnecting turns one bad frame into a reconnect loop.
	 */
	private handleFrame(frame: string): void {
		const lines = frame.split("\n");
		// `: keep-alive` comments and the `ready` handshake are not commands. Naming
		// them here rather than letting them fall through to the parser keeps the
		// "unrecognised frame" log meaningful — a log that fires four times a minute
		// on healthy traffic is a log nobody reads when it fires for a real reason.
		const name = lines.find((line) => line.startsWith("event:"))?.slice("event:".length).trim();
		const data = lines
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice("data:".length).trim())
			.join("\n");
		if (name === "ready") {
			this.deps.log("bridge.stream_ready");
			return;
		}
		if (data === "" || data === "[DONE]") return;

		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			this.deps.log("bridge.frame_unparseable", { bytes: data.length });
			return;
		}
		const command = asCommand(parsed);
		if (command === null) {
			this.deps.log("bridge.frame_not_a_command", { got: describe(parsed) });
			return;
		}
		try {
			this.dispatch(command);
		} catch (error) {
			this.deps.log("bridge.dispatch_failed", { message: (error as Error).message });
		}
	}

	/**
	 * Four verbs, exhaustive, no `default`.
	 *
	 * Adding a fifth to the contract is a compile error here rather than a command
	 * the sandbox silently ignores — and a silently ignored command is the worst
	 * shape this failure can take, because the control plane records that it sent a
	 * `stop` and the user watches the agent carry on.
	 */
	private dispatch(command: BridgeCommand): void {
		switch (command.type) {
			case "prompt": {
				const prompt = command.prompt;
				if (prompt === undefined) {
					this.deps.log("bridge.prompt_without_body");
					return;
				}
				// **Deduplicate by prompt id.** Commands are derived from persisted state
				// rather than from an in-memory queue, precisely so that a bridge which
				// reconnects to a different replica still receives its prompt — and the
				// price of that design is redelivery. Without this check a flaky
				// connection runs the same prompt two, three, five times, each one a full
				// paid turn against the same workspace.
				if (this.seenPrompts.has(prompt.id)) {
					this.deps.log("bridge.prompt_redelivered", { prompt_id: prompt.id });
					return;
				}
				this.seenPrompts.add(prompt.id);
				this.enqueueTurn(command, prompt);
				return;
			}
			case "stop":
				this.handlers.interrupt("stop");
				return;
			case "snapshot":
				// Flush first: a snapshot freezes the filesystem, and an event still in
				// this buffer when that happens is restored into a *new* box that will
				// send it again with a stale timestamp.
				this.turns = this.turns
					.then(() => this.flush())
					.then(() => this.handlers.quiesceForSnapshot())
					.catch((error) => this.deps.log("bridge.snapshot_failed", { message: String(error) }));
				return;
			case "shutdown":
				this.handlers.shutdown("control_plane_requested");
				return;
		}
		return assertNever(command.type, "BridgeCommandType in dispatch");
	}

	/**
	 * Turns run one at a time, in arrival order, on a chain that survives failure.
	 *
	 * The chain is what makes a second `prompt` arriving mid-turn harmless. Without
	 * it two agent processes edit the same checkout concurrently, and the result is
	 * a merge conflict inside an uncommitted working tree that neither agent knows
	 * how to describe.
	 */
	private enqueueTurn(command: BridgeCommand, prompt: NonNullable<BridgeCommand["prompt"]>): void {
		this.turns = this.turns.then(async () => {
			let identity: GitIdentity;
			try {
				identity = identityForPrompt(prompt as PromptIdentityFields);
			} catch (error) {
				// Refused, not guessed — and surfaced on the timeline rather than only in
				// the log, because the fix (connect the author's SCM identity, or enqueue
				// as agent-only) belongs to the person who sent the prompt.
				this.emit({
					type: "agent_failed",
					payload: {
						prompt_id: prompt.id,
						reason: "git_identity_unavailable",
						message: (error as Error).message,
					},
				});
				this.deps.log("bridge.identity_refused", { prompt_id: prompt.id });
				return;
			}

			try {
				await this.deps.setGitIdentity(this.config.workspace, identity);
			} catch (error) {
				// Also fatal to the turn. Running anyway would produce commits attributed
				// to whatever identity happened to be in the image's global config, which
				// is the wrong-author bug arriving by a different road.
				this.emit({
					type: "agent_failed",
					payload: {
						prompt_id: prompt.id,
						reason: "git_config_failed",
						message: (error as Error).message,
					},
				});
				return;
			}

			const invocation: TurnInvocation = {
				promptId: prompt.id,
				seq: prompt.seq,
				body: prompt.body,
				identity,
				timeoutMs: setting("agentTurnTimeoutMs"),
				// Absent and explicitly null mean the same thing here — no branch — so a
				// control plane too old to send the field degrades to "runs, pushes
				// nothing" rather than to a crash or to a guessed branch name.
				pushBranch: prompt.push_branch ?? null,
				baseBranch: prompt.base_branch ?? null,
			};
			if (command.trace_id !== undefined) invocation.traceId = command.trace_id;

			try {
				await this.handlers.runTurn(invocation);
			} catch (error) {
				this.emit({
					type: "agent_failed",
					payload: {
						prompt_id: prompt.id,
						reason: "turn_threw",
						message: (error as Error).message,
					},
				});
			}
		});
	}

	/** Resolves when every queued turn has finished. Used by the shutdown path. */
	async settled(): Promise<void> {
		await this.turns;
	}
}

// ---------------------------------------------------------------------------
// Wire validation
// ---------------------------------------------------------------------------

const COMMAND_TYPES: ReadonlySet<string> = new Set<BridgeCommandType>([
	"prompt",
	"stop",
	"snapshot",
	"shutdown",
]);

/**
 * Accept a frame as a command, or return null.
 *
 * Validation rather than a cast, because the alternative is a `prompt` with no
 * `body` reaching the adapter and the agent being handed `undefined` as its task.
 * Null rather than a throw so the caller's "skip the frame, keep the stream"
 * policy stays in one place.
 */
export function asCommand(value: unknown): BridgeCommand | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.type !== "string" || !COMMAND_TYPES.has(record.type)) return null;
	if (typeof record.session_id !== "string" || record.session_id === "") return null;

	const command = { type: record.type as BridgeCommandType, session_id: record.session_id } as BridgeCommand;
	if (typeof record.trace_id === "string") command.trace_id = record.trace_id;

	if (command.type === "prompt") {
		const prompt = record.prompt;
		if (typeof prompt !== "object" || prompt === null) return null;
		const fields = prompt as Record<string, unknown>;
		if (typeof fields.id !== "string" || typeof fields.body !== "string") return null;
		command.prompt = {
			id: fields.id,
			seq: typeof fields.seq === "number" ? fields.seq : 0,
			body: fields.body,
			author: typeof fields.author === "string" ? fields.author : "",
			author_email: typeof fields.author_email === "string" ? fields.author_email : null,
			...(typeof fields.mode === "string" ? { mode: fields.mode } : {}),
			// Anything that is not a non-empty string becomes null rather than being
			// passed through. A branch of `""`, `0` or an object reaching the push
			// would be a ref built from junk; null is the documented "do not push".
			push_branch: typeof fields.push_branch === "string" && fields.push_branch !== ""
				? fields.push_branch
				: null,
			base_branch: typeof fields.base_branch === "string" && fields.base_branch !== ""
				? fields.base_branch
				: null,
		} as BridgeCommand["prompt"];
	}
	return command;
}

function describe(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}
