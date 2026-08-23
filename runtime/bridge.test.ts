// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The bridge under the conditions it exists for: a partition, a flapping
 * connection, a control plane sending something this image does not understand,
 * and a prompt with nobody's name on it.
 *
 * Nothing is mocked in the sense of a mocking library. The seams — `fetch`,
 * `sleep`, `random`, `setGitIdentity` — are constructor parameters, so the tests
 * drive real code paths with real `ReadableStream`s and real `Response`s, and the
 * only thing standing in for the network is a function that returns them. That
 * matters here more than usual: the bugs this file is guarding against are timing
 * bugs, and a mock that resolves instantly hides most of them.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitIdentityError } from "../app/contracts/agent.js";
import type { SandboxEvent } from "../app/contracts/index.js";
import {
	Bridge,
	asCommand,
	identityForPrompt,
	type BridgeDeps,
	type BridgeHandlers,
	type TurnInvocation,
} from "./bridge.js";

const CONFIG = {
	controlUrl: "https://harbor.test",
	sandboxId: "sbx_1",
	sessionId: "ses_1",
	token: "secret-token",
	fencingToken: 7,
	workspace: "/workspace/app",
};

interface Recorder {
	deps: BridgeDeps;
	handlers: BridgeHandlers;
	sleeps: number[];
	logs: Array<{ code: string; detail?: Record<string, unknown> }>;
	turns: TurnInvocation[];
	interrupts: string[];
	posted: SandboxEvent[][];
	identities: Array<{ workspace: string; identity: unknown }>;
}

function recorder(overrides: Partial<BridgeDeps> = {}): Recorder {
	const state: Recorder = {
		sleeps: [],
		logs: [],
		turns: [],
		interrupts: [],
		posted: [],
		identities: [],
		deps: null as unknown as BridgeDeps,
		handlers: null as unknown as BridgeHandlers,
	};
	state.deps = {
		fetch: async () => {
			throw new Error("no control plane in this test");
		},
		now: () => Date.parse("2026-01-01T00:00:00.000Z"),
		random: () => 1,
		sleep: async (ms) => {
			state.sleeps.push(ms);
		},
		setGitIdentity: async (workspace, identity) => {
			state.identities.push({ workspace, identity });
		},
		log: (code, detail) => {
			state.logs.push(detail === undefined ? { code } : { code, detail });
		},
		...overrides,
	};
	state.handlers = {
		runTurn: async (invocation) => {
			state.turns.push(invocation);
		},
		interrupt: (kind) => {
			state.interrupts.push(kind);
		},
		quiesceForSnapshot: async () => {},
		shutdown: (reason) => {
			state.interrupts.push(`shutdown:${reason}`);
		},
	};
	return state;
}

/** An SSE response whose frames this test pushes by hand. */
function sseResponse(): { response: Response; push: (frame: string) => void; close: () => void } {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});
	return {
		response: new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
		push: (frame) => controller.enqueue(encoder.encode(frame)),
		close: () => controller.close(),
	};
}

const originalEnv = { ...process.env };
afterEach(() => {
	process.env = { ...originalEnv };
});

describe("bounded buffering", () => {
	beforeEach(() => {
		process.env.HARBOR_BRIDGE_BUFFER_LIMIT = "4";
	});

	it("emits exactly one gap marker for a partition and keeps the newest events", async () => {
		// The two failure modes this asserts against are both real and both bad:
		// unbounded buffering OOMs the box and takes the agent's work with it, and
		// silently dropping leaves an invisible hole in the transcript that a reader
		// interprets as "the agent did nothing for forty minutes".
		const state = recorder();
		const bridge = new Bridge(CONFIG, state.handlers, state.deps);

		for (let i = 1; i <= 20; i += 1) {
			bridge.emit({ type: "agent_message", payload: { n: i } });
		}
		await Promise.resolve();

		const buffer = bridge.bufferSnapshot();
		const gaps = buffer.filter((entry) => entry.kind === "gap");
		expect(gaps).toHaveLength(1);
		expect(buffer[0]?.kind).toBe("gap");
		expect(gaps[0]).toMatchObject({ droppedEvents: 16 });

		const kept = buffer.flatMap((entry) => (entry.kind === "event" ? [entry.event.payload?.n] : []));
		expect(kept).toEqual([17, 18, 19, 20]);
	});

	it("never sends more events in one batch than the ingest endpoint accepts", async () => {
		// bridgeBufferLimit defaults to twice maxSnapshotEvents, so a full buffer sent
		// as one POST is a 413 — and a bridge that only fails when the buffer is full
		// is a bridge that only fails during the outage it exists to survive.
		process.env.HARBOR_BRIDGE_BUFFER_LIMIT = "1000";
		process.env.HARBOR_MAX_SNAPSHOT_EVENTS = "5";
		const batches: number[] = [];
		const state = recorder({
			fetch: async (_url, init) => {
				batches.push(
					(JSON.parse(String((init as RequestInit).body)) as { events: unknown[] }).events.length,
				);
				return new Response("{}", { status: 200 });
			},
		});
		const bridge = new Bridge(CONFIG, state.handlers, state.deps);

		for (let i = 1; i <= 17; i += 1) bridge.emit({ type: "agent_message", payload: { n: i } });
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(batches.length).toBeGreaterThan(1);
		for (const size of batches) expect(size).toBeLessThanOrEqual(5);
		expect(batches.reduce((a, b) => a + b, 0)).toBe(17);
		expect(bridge.bufferSnapshot()).toHaveLength(0);
	});

	it("puts the gap in the record on the wire, not only in the log", async () => {
		const bodies: string[] = [];
		const state = recorder({
			// A control plane that answers slowly, which is the realistic partition:
			// the POST is in flight while the agent keeps producing output.
			fetch: async (_url, init) => {
				bodies.push(String((init as RequestInit).body));
				await new Promise((resolve) => setTimeout(resolve, 20));
				return new Response("{}", { status: 200 });
			},
		});
		const bridge = new Bridge(CONFIG, state.handlers, state.deps);

		for (let i = 1; i <= 20; i += 1) bridge.emit({ type: "agent_message", payload: { n: i } });
		await new Promise((resolve) => setTimeout(resolve, 60));
		bridge.emit({ type: "agent_finished", payload: {} });
		await new Promise((resolve) => setTimeout(resolve, 60));

		const sent = bodies.flatMap((body) => (JSON.parse(body) as { events: SandboxEvent[] }).events);
		const markers = sent.filter((event) => event.payload?.code === "bridge.buffer_overflow");
		expect(markers.length).toBeGreaterThanOrEqual(1);
		expect(markers[0]?.type).toBe("log");
		expect(markers[0]?.payload?.level).toBe("warning");
		expect(markers[0]?.payload?.dropped_events).toBeTypeOf("number");
	});

	it("does not delete unsent events when an overflow races a successful POST", async () => {
		// The naive flush removes "the first N entries" after a 200. If an overflow
		// evicted from the head while the POST was in flight, the first N are no
		// longer the N that were sent, and the flush deletes events that never left
		// the box — data loss that only occurs under exactly the conditions the
		// buffer exists for.
		let release: () => void = () => {};
		const state = recorder({
			fetch: async () => {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return new Response("{}", { status: 200 });
			},
		});
		const bridge = new Bridge(CONFIG, state.handlers, state.deps);

		bridge.emit({ type: "agent_message", payload: { n: 1 } });
		await Promise.resolve();
		for (let i = 2; i <= 12; i += 1) bridge.emit({ type: "agent_message", payload: { n: i } });
		release();
		for (let i = 0; i < 10; i += 1) await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 5));

		// Whatever survived the overflow is the newest window, unbroken, and never a
		// hole punched by the flush.
		const kept = bridge
			.bufferSnapshot()
			.flatMap((entry) => (entry.kind === "event" ? [Number(entry.event.payload?.n)] : []));
		for (let i = 1; i < kept.length; i += 1) {
			expect(kept[i]!).toBe(kept[i - 1]! + 1);
		}
	});
});

describe("reconnection", () => {
	beforeEach(() => {
		process.env.HARBOR_SANDBOX_HEARTBEAT_INTERVAL_MS = "16000";
		process.env.HARBOR_SANDBOX_STALE_HEARTBEAT_MS = "48000";
	});

	it("backs off exponentially and stays bounded by the stale-heartbeat threshold", async () => {
		// The bound is the point. An unbounded doubling reaches hours, and a sandbox
		// that reconnects in two hours has already been written off by the control
		// plane — coming back then adds a second writer rather than a recovery.
		const state = recorder();
		let bridge!: Bridge;
		state.deps.fetch = async () => {
			throw new Error("connection refused");
		};
		state.deps.sleep = async (ms) => {
			state.sleeps.push(ms);
			if (state.sleeps.length >= 15) await bridge.stop(0);
		};
		bridge = new Bridge(CONFIG, state.handlers, state.deps);

		await bridge.start();

		expect(state.sleeps.length).toBeGreaterThanOrEqual(15);
		// base = heartbeat / 16 = 1000ms, random pinned to 1 so the jitter window is
		// at its top and the numbers are exact rather than approximate.
		expect(state.sleeps.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000]);
		for (const delay of state.sleeps) {
			expect(delay).toBeLessThanOrEqual(48_000);
			expect(delay).toBeGreaterThan(0);
		}
		expect(state.sleeps.at(-1)).toBe(48_000);
	});

	it("treats a clean end of stream as normal and reconnects without backing off", async () => {
		// A proxy idle timeout or a rolling restart of the control plane ends the
		// stream cleanly. Counting that as a failure means a deployment quietly
		// pushes every sandbox in the fleet into a 45-second reconnect delay.
		const state = recorder();
		let bridge!: Bridge;
		let connects = 0;
		state.deps.fetch = async () => {
			connects += 1;
			const sse = sseResponse();
			queueMicrotask(() => sse.close());
			return sse.response;
		};
		state.deps.sleep = async (ms) => {
			state.sleeps.push(ms);
			if (state.sleeps.length >= 3) await bridge.stop(0);
		};
		bridge = new Bridge(CONFIG, state.handlers, state.deps);

		await bridge.start();

		expect(connects).toBeGreaterThanOrEqual(3);
		expect(new Set(state.sleeps)).toEqual(new Set([1_000]));
	});
});

describe("the command stream", () => {
	it("survives a malformed frame and keeps delivering the ones after it", async () => {
		// Version skew, a proxy-injected keep-alive, and a truncated write during a
		// deploy all produce this. Throwing here disconnects a healthy sandbox, and if
		// the frame is being retransmitted it turns one bad frame into a reconnect
		// loop.
		const state = recorder();
		let bridge!: Bridge;
		const sse = sseResponse();
		state.deps.fetch = async (url, init) => {
			if ((init as RequestInit).method === "POST") return new Response("{}", { status: 200 });
			return sse.response;
		};
		state.deps.sleep = async () => {
			await bridge.stop(0);
		};
		bridge = new Bridge(CONFIG, state.handlers, state.deps);

		const serving = bridge.start();
		await new Promise((resolve) => setTimeout(resolve, 5));

		sse.push("data: {not json at all}\n\n");
		sse.push(": a keep-alive comment with no data line\n\n");
		sse.push('data: {"type":"teleport","session_id":"ses_1"}\n\n');
		sse.push('data: {"type":"prompt","session_id":"ses_1"}\n\n');
		sse.push('data: {"type":"stop","session_id":"ses_1"}\n\n');
		await new Promise((resolve) => setTimeout(resolve, 5));
		sse.close();
		await serving;

		expect(state.interrupts).toEqual(["stop"]);
		expect(state.logs.map((entry) => entry.code)).toContain("bridge.frame_unparseable");
		expect(state.logs.map((entry) => entry.code)).toContain("bridge.frame_not_a_command");
	});

	it("reassembles a JSON object split across two chunks", async () => {
		// A frame arriving in two TCP segments is ordinary. Parsing each segment as
		// its own frame turns a valid command into two unparseable ones, and the
		// command is simply never executed.
		const state = recorder();
		let bridge!: Bridge;
		const sse = sseResponse();
		state.deps.fetch = async (_url, init) =>
			(init as RequestInit).method === "POST" ? new Response("{}", { status: 200 }) : sse.response;
		state.deps.sleep = async () => {
			await bridge.stop(0);
		};
		bridge = new Bridge(CONFIG, state.handlers, state.deps);

		const serving = bridge.start();
		await new Promise((resolve) => setTimeout(resolve, 5));
		sse.push('data: {"type":"stop","sess');
		await new Promise((resolve) => setTimeout(resolve, 5));
		sse.push('ion_id":"ses_1"}\n\n');
		await new Promise((resolve) => setTimeout(resolve, 5));
		sse.close();
		await serving;

		expect(state.interrupts).toEqual(["stop"]);
		expect(state.logs.map((entry) => entry.code)).not.toContain("bridge.frame_unparseable");
	});

	it("runs a redelivered prompt once, not twice", async () => {
		// Commands are derived from persisted state so that a bridge reconnecting to a
		// different replica still gets its prompt. The price is redelivery, and
		// without dedupe a flaky connection pays for the same turn several times over
		// against the same workspace.
		const state = recorder();
		let bridge!: Bridge;
		const sse = sseResponse();
		state.deps.fetch = async (_url, init) =>
			(init as RequestInit).method === "POST" ? new Response("{}", { status: 200 }) : sse.response;
		state.deps.sleep = async () => {
			await bridge.stop(0);
		};
		bridge = new Bridge(CONFIG, state.handlers, state.deps);

		const serving = bridge.start();
		await new Promise((resolve) => setTimeout(resolve, 5));
		const frame = `data: ${JSON.stringify({
			type: "prompt",
			session_id: "ses_1",
			prompt: { id: "p_1", seq: 1, body: "go", author: "Ada", author_email: "ada@x.test" },
		})}\n\n`;
		sse.push(frame);
		sse.push(frame);
		sse.push(frame);
		await new Promise((resolve) => setTimeout(resolve, 10));
		sse.close();
		await serving;
		await bridge.settled();

		expect(state.turns.map((turn) => turn.promptId)).toEqual(["p_1"]);
		expect(state.logs.filter((entry) => entry.code === "bridge.prompt_redelivered")).toHaveLength(2);
	});

	it("treats a refused fence as final and shuts down instead of retrying", async () => {
		// A 409 means this box is superseded. Retrying is what keeps a zombie
		// connected long enough to be handed a prompt, and two agents then interleave
		// sentences into one transcript.
		const state = recorder();
		let bridge!: Bridge;
		state.deps.fetch = async () => new Response("{}", { status: 409 });
		state.deps.sleep = async (ms) => {
			state.sleeps.push(ms);
			await bridge.stop(0);
		};
		bridge = new Bridge(CONFIG, state.handlers, state.deps);

		await bridge.start();

		expect(state.interrupts).toContain("shutdown:fence_superseded");
		expect(state.logs.map((entry) => entry.code)).toContain("bridge.fence_refused");
	});

	it("does not treat the ready handshake or a keep-alive as an unrecognised frame", async () => {
		// A log that fires on every healthy connect is a log nobody reads when it
		// fires for a real reason. The control plane sends `event: ready` on connect
		// and `: keep-alive` every heartbeat interval.
		const state = recorder();
		let bridge!: Bridge;
		const sse = sseResponse();
		state.deps.fetch = async (_url, init) =>
			(init as RequestInit).method === "POST" ? new Response("{}", { status: 200 }) : sse.response;
		state.deps.sleep = async () => {
			await bridge.stop(0);
		};
		bridge = new Bridge(CONFIG, state.handlers, state.deps);

		const serving = bridge.start();
		await new Promise((resolve) => setTimeout(resolve, 5));
		sse.push('event: ready\ndata: {"sandbox_id":"sbx_1","session_id":"ses_1","fencing_token":7}\n\n');
		sse.push(": keep-alive\n\n");
		await new Promise((resolve) => setTimeout(resolve, 5));
		sse.close();
		await serving;

		const codes = state.logs.map((entry) => entry.code);
		expect(codes).toContain("bridge.stream_ready");
		expect(codes).not.toContain("bridge.frame_not_a_command");
		expect(codes).not.toContain("bridge.frame_unparseable");
	});

	it("validates a command rather than casting one", () => {
		expect(asCommand({ type: "stop", session_id: "ses_1" })).toEqual({
			type: "stop",
			session_id: "ses_1",
		});
		expect(asCommand({ type: "stop" })).toBeNull();
		expect(asCommand({ type: "reboot", session_id: "ses_1" })).toBeNull();
		expect(asCommand("stop")).toBeNull();
		// A prompt with no body would reach the adapter as `undefined`, and the agent
		// would be handed nothing to do with no error anywhere.
		expect(asCommand({ type: "prompt", session_id: "ses_1", prompt: { id: "p1" } })).toBeNull();
		expect(
			asCommand({
				type: "prompt",
				session_id: "ses_1",
				prompt: { id: "p1", body: "hi", author: "ada", author_email: "ada@x.test", seq: 3 },
			}),
		).toMatchObject({ prompt: { id: "p1", seq: 3, author_email: "ada@x.test" } });
	});
});

describe("git identity", () => {
	it("refuses rather than guessing when the author cannot be attributed", () => {
		// Commit attribution is the trust anchor of the whole PR model: the human
		// authors, the bot commits, therefore the human cannot approve their own
		// agent's work. Any fallback — the bot, the session creator, the last person
		// who spoke — makes the repository history lie, silently, forever.
		expect(() => identityForPrompt({ author: "Ada", author_email: null })).toThrow(GitIdentityError);
		expect(() => identityForPrompt({})).toThrow(GitIdentityError);
		expect(() => identityForPrompt({ author: "   ", author_email: "  " })).toThrow(GitIdentityError);
	});

	it("honours an explicit agent-only prompt, which is a choice and not a fallback", () => {
		expect(identityForPrompt({ mode: "agent-only" })).toEqual({ mode: "agent-only" });
		// Even with an author present: the mode is the explicit statement.
		expect(identityForPrompt({ mode: "agent-only", author: "Ada", author_email: "ada@x.test" })).toEqual(
			{ mode: "agent-only" },
		);
	});

	it("refuses an identity mode it does not recognise", () => {
		// A mode this image has never heard of is version skew between the control
		// plane and the sandbox. Treating an unknown word as "do whatever" is the
		// same guess wearing a hat.
		expect(() => identityForPrompt({ mode: "auto", author: "Ada", author_email: "ada@x.test" })).toThrow(
			GitIdentityError,
		);
	});

	it("attributes a complete identity", () => {
		expect(identityForPrompt({ author: "Ada Lovelace", author_email: "ada@x.test" })).toEqual({
			mode: "attributed-user",
			name: "Ada Lovelace",
			email: "ada@x.test",
		});
	});

	it("sets git identity before the turn, and does not run the turn when it cannot", async () => {
		const state = recorder();
		let bridge!: Bridge;
		const sse = sseResponse();
		const posted: SandboxEvent[] = [];
		state.deps.fetch = async (_url, init) => {
			if ((init as RequestInit).method !== "POST") return sse.response;
			posted.push(...(JSON.parse(String((init as RequestInit).body)) as { events: SandboxEvent[] }).events);
			return new Response("{}", { status: 200 });
		};
		state.deps.sleep = async () => {
			await bridge.stop(0);
		};
		bridge = new Bridge(CONFIG, state.handlers, state.deps);

		const serving = bridge.start();
		await new Promise((resolve) => setTimeout(resolve, 5));
		sse.push(
			`data: ${JSON.stringify({
				type: "prompt",
				session_id: "ses_1",
				prompt: { id: "p_ok", seq: 1, body: "fix it", author: "Ada", author_email: "ada@x.test" },
			})}\n\n`,
		);
		sse.push(
			`data: ${JSON.stringify({
				type: "prompt",
				session_id: "ses_1",
				prompt: { id: "p_bad", seq: 2, body: "fix it", author: "Ada", author_email: null },
			})}\n\n`,
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		sse.close();
		await serving;
		await bridge.settled();

		expect(state.identities).toEqual([
			{ workspace: "/workspace/app", identity: { mode: "attributed-user", name: "Ada", email: "ada@x.test" } },
		]);
		expect(state.turns.map((turn) => turn.promptId)).toEqual(["p_ok"]);

		// The refusal is on the timeline, not only in the log: the fix belongs to the
		// person who sent the prompt, and they are not reading the sandbox's stderr.
		const failures = posted
			.concat(bridge.bufferSnapshot().flatMap((entry) => (entry.kind === "event" ? [entry.event] : [])))
			.filter((event) => event.type === "agent_failed");
		expect(failures).toHaveLength(1);
		expect(failures[0]?.payload?.reason).toBe("git_identity_unavailable");
		expect(String(failures[0]?.payload?.message)).toContain("agent-only");
	});
});
