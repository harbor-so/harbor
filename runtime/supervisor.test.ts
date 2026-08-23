// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The supervisor's effect layer, exercised with real processes and real files.
 *
 * `boot-decisions.test.ts` pins every *decision* the runtime makes; this file
 * pins the *effects* around them: reading the boot contract out of the
 * environment, spawning bounded child processes, running repository hooks,
 * waiting on the tunnel file, and pointing git at the credential helper. Nothing
 * is mocked in the sense of a mocking library — child processes are real
 * `node -e` invocations, hooks are real bash scripts in real temp directories,
 * and the only stand-ins are a recording `BridgeSink` (a plain object with an
 * `emit` that pushes to an array) and a fake adapter whose `resumeTokenFrom` is
 * three lines of string scanning. The bugs this file guards against — a SIGTERM
 * that never escalates, an output accumulator that grows with the turn, a stale
 * tunnel file that survives boot — only exist in the real effects.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_RUNTIMES, type AgentAdapter } from "../app/contracts/agent.js";
import { codexAdapter } from "./adapters/codex.js";
import { TUNNEL_SANDBOX_ID_KEY } from "./boot-decisions.js";
import type { OutboundEvent } from "./bridge.js";
import {
	configureGit,
	createResumeTokenAccumulator,
	parseRepos,
	pushWorkingBranch,
	readSupervisorConfig,
	runAutoSetup,
	runCommand,
	runHook,
	waitForTunnels,
	type BridgeSink,
	type SupervisorConfig,
} from "./supervisor.js";

// Settings are resolved from process.env at call time, so tests that tune a cap
// or a timeout mutate process.env and this restores it. Same pattern as
// bridge.test.ts, for the same reason: a leaked HARBOR_MAX_RUN_OUTPUT_CHARS=256
// would silently truncate every later test's output and nothing would say why.
const originalEnv = { ...process.env };
const tempDirs: string[] = [];
afterEach(() => {
	process.env = { ...originalEnv };
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** A bridge that records instead of posting. `BridgeSink` is exactly `emit`. */
function sink(): BridgeSink & { events: OutboundEvent[] } {
	const events: OutboundEvent[] = [];
	return {
		events,
		emit(event: OutboundEvent) {
			events.push(event);
		},
	};
}

function supervisorConfig(overrides: Partial<SupervisorConfig> = {}): SupervisorConfig {
	return {
		controlUrl: "https://control.test",
		sandboxId: "sbx_1",
		sessionId: "ses_1",
		token: "tok",
		fencingToken: 7,
		runtime: "claude-code",
		workspaceRoot: "/workspace",
		repos: [{ name: "app", url: "https://github.com/acme/app.git" }],
		requestedBootMode: null,
		...overrides,
	};
}

/** A complete, valid boot environment. Tests remove or corrupt one key at a time. */
// NODE_ENV appears because Next's global.d.ts makes it a required ProcessEnv
// member; it is irrelevant to the supervisor, which only reads HARBOR_* keys.
function validEnv(): NodeJS.ProcessEnv {
	return {
		NODE_ENV: "test",
		HARBOR_CONTROL_URL: "https://control.test",
		HARBOR_SANDBOX_ID: "sbx_1",
		HARBOR_SESSION_ID: "ses_1",
		HARBOR_SANDBOX_TOKEN: "tok",
		HARBOR_FENCING_TOKEN: "7",
		HARBOR_AGENT_RUNTIME: "claude-code",
		HARBOR_REPOS: JSON.stringify([{ name: "app", url: "https://github.com/acme/app.git" }]),
	};
}

// ---------------------------------------------------------------------------
// readSupervisorConfig
// ---------------------------------------------------------------------------

describe("readSupervisorConfig", () => {
	it("reports every missing variable at once, not just the first", () => {
		// The feedback loop for a bad boot environment is a container rebuild.
		// One-problem-per-boot turns a five-variable misconfiguration into five
		// builds, so the contract is: everything wrong, in one pass.
		const result = readSupervisorConfig({ NODE_ENV: "test" });
		expect(result.kind).toBe("invalid");
		if (result.kind !== "invalid") return;
		for (const name of [
			"HARBOR_CONTROL_URL",
			"HARBOR_SANDBOX_ID",
			"HARBOR_SESSION_ID",
			"HARBOR_SANDBOX_TOKEN",
			"HARBOR_FENCING_TOKEN",
			"HARBOR_AGENT_RUNTIME",
		]) {
			expect(result.problems.join("\n")).toContain(name);
		}
	});

	it("refuses a fencing token that is not a plain positive integer", () => {
		// A box that boots with a garbage fence comes up cleanly and is then
		// rejected by every privileged call it makes — the worst failure shape,
		// because nothing points back at the one bad variable.
		for (const bad of ["12.5", "abc", "-3", "", " ", "0x10"]) {
			const result = readSupervisorConfig({ ...validEnv(), HARBOR_FENCING_TOKEN: bad });
			expect(result.kind, `fence ${JSON.stringify(bad)}`).toBe("invalid");
			if (result.kind === "invalid") {
				expect(result.problems.join("\n")).toContain("HARBOR_FENCING_TOKEN");
			}
		}
	});

	it("refuses an oversized fencing token but accepts the nine-digit maximum", () => {
		// The regex bounds the fence at nine digits so `Number()` can never lose
		// precision on it. Ten digits must be refused, nine must not: an
		// off-by-one here would reject every fence a busy installation mints.
		const tooBig = readSupervisorConfig({ ...validEnv(), HARBOR_FENCING_TOKEN: "1234567890" });
		expect(tooBig.kind).toBe("invalid");

		const maximal = readSupervisorConfig({ ...validEnv(), HARBOR_FENCING_TOKEN: "999999999" });
		expect(maximal.kind).toBe("ok");
		if (maximal.kind === "ok") expect(maximal.config.fencingToken).toBe(999_999_999);
	});

	it("refuses an unknown runtime by name, listing the valid set, never defaulting", () => {
		// Defaulting would mean a session configured for one agent silently runs
		// another; the first symptom is a transcript in the wrong format, hours
		// later. The error must therefore name every runtime that would work.
		const result = readSupervisorConfig({ ...validEnv(), HARBOR_AGENT_RUNTIME: "gpt-engineer" });
		expect(result.kind).toBe("invalid");
		if (result.kind !== "invalid") return;
		const text = result.problems.join("\n");
		expect(text).toContain('"gpt-engineer"');
		for (const runtime of AGENT_RUNTIMES) expect(text).toContain(runtime);
	});

	it("propagates HARBOR_TRACE_ID when present and omits the property when not", () => {
		// `traceId` is optional propagation, not required config: its absence must
		// not fail the boot, and its presence must survive into every downstream
		// correlation header.
		const without = readSupervisorConfig(validEnv());
		expect(without.kind).toBe("ok");
		if (without.kind === "ok") expect("traceId" in without.config).toBe(false);

		const withTrace = readSupervisorConfig({ ...validEnv(), HARBOR_TRACE_ID: "trace-42" });
		expect(withTrace.kind).toBe("ok");
		if (withTrace.kind === "ok") expect(withTrace.config.traceId).toBe("trace-42");
	});

	it("strips trailing slashes from HARBOR_CONTROL_URL", () => {
		// Every caller appends `/api/...`; a trailing slash left in place produces
		// `//api` paths that some proxies 404 on, intermittently, per-deployment.
		const result = readSupervisorConfig({
			...validEnv(),
			HARBOR_CONTROL_URL: "https://control.test///",
		});
		expect(result.kind).toBe("ok");
		if (result.kind === "ok") expect(result.config.controlUrl).toBe("https://control.test");
	});

	it("reports malformed HARBOR_REPOS JSON as a HARBOR_REPOS problem", () => {
		// The parse error must be attributed to the variable, or the operator is
		// left grepping for a bare "Unexpected token" with no owner.
		const result = readSupervisorConfig({ ...validEnv(), HARBOR_REPOS: "{not json" });
		expect(result.kind).toBe("invalid");
		if (result.kind !== "invalid") return;
		expect(result.problems.some((problem) => problem.startsWith("HARBOR_REPOS:"))).toBe(true);
	});

	it("treats HARBOR_AGENT_MCP_URL as optional, and strips its trailing slashes", () => {
		// Optional on purpose. A deployment that runs only the dashboard has no MCP
		// server to point at, and failing the boot over it would make the agent tools
		// a hard dependency of running a sandbox at all. Absent simply means the agent
		// gets no Harbor tools.
		const without = readSupervisorConfig(validEnv());
		expect(without.kind).toBe("ok");
		if (without.kind === "ok") expect("agentMcpUrl" in without.config).toBe(false);

		// Empty is the same as absent: an operator who sets the variable to "" in a
		// compose file has not configured it, and a bare "" base would build the URL
		// `/agent/<id>/mcp`, which the agent would resolve against nothing.
		const blank = readSupervisorConfig({ ...validEnv(), HARBOR_AGENT_MCP_URL: "  " });
		expect(blank.kind).toBe("ok");
		if (blank.kind === "ok") expect("agentMcpUrl" in blank.config).toBe(false);

		const set = readSupervisorConfig({
			...validEnv(),
			HARBOR_AGENT_MCP_URL: "http://mcp.test:8788//",
		});
		expect(set.kind).toBe("ok");
		if (set.kind === "ok") expect(set.config.agentMcpUrl).toBe("http://mcp.test:8788");
	});
});

// ---------------------------------------------------------------------------
// parseRepos — the name becomes a path segment, so this is a security boundary
// ---------------------------------------------------------------------------

describe("parseRepos", () => {
	it("rejects names that could traverse or inject, naming the allowed charset", () => {
		// `name` is joined under the workspace root and used as a git remote. A
		// `..` or `/` is a path traversal that writes a clone outside the
		// workspace; `$(cmd)` is one lazy shell interpolation away from execution.
		// The error names the charset so the fix is obvious from the message.
		for (const name of ["../escape", "a/b", "", "$(cmd)", "a b", "a\nb"]) {
			expect(
				() => parseRepos(JSON.stringify([{ name, url: "https://github.com/acme/app.git" }])),
				`name ${JSON.stringify(name)}`,
			).toThrow(/A-Za-z0-9._-/);
		}
	});

	it("accepts a valid {name, url, ref} entry and drops an empty ref", () => {
		const repos = parseRepos(
			JSON.stringify([
				{ name: "app-1.core_x", url: "https://github.com/acme/app.git", ref: "main" },
				{ name: "lib", url: "https://github.com/acme/lib.git", ref: "" },
			]),
		);
		expect(repos[0]).toEqual({ name: "app-1.core_x", url: "https://github.com/acme/app.git", ref: "main" });
		// An empty ref means "the remote's default branch", so the property is
		// absent rather than an empty string that `--branch` would choke on.
		expect(repos[1]).toEqual({ name: "lib", url: "https://github.com/acme/lib.git" });
	});

	it("names the entry index when a url is missing", () => {
		// HARBOR_REPOS can carry several repositories; "has no url" without an
		// index makes the operator bisect the array by hand.
		expect(() =>
			parseRepos(JSON.stringify([{ name: "ok", url: "https://x.test/a.git" }, { name: "bad" }])),
		).toThrow(/entry 1 has no url/);
	});

	it("rejects non-array payloads and non-object entries", () => {
		expect(() => parseRepos('{"name":"app"}')).toThrow(/JSON array/);
		expect(() => parseRepos('["app"]')).toThrow(/entry 0 is not an object/);
	});
});

// ---------------------------------------------------------------------------
// runCommand — real child processes, bounded in time and output
// ---------------------------------------------------------------------------

// `node -e` rather than shell scripts: it is the one binary guaranteed present
// wherever this suite runs, and process.execPath dodges PATH entirely.
const node = process.execPath;

describe("runCommand", () => {
	it("captures the exit code and both output streams", async () => {
		const result = await runCommand(
			node,
			["-e", 'console.log("to stdout"); console.error("to stderr"); process.exit(3);'],
			{ cwd: tmpdir(), env: process.env, timeoutMs: 10_000 },
		);
		expect(result.code).toBe(3);
		expect(result.timedOut).toBe(false);
		expect(result.output).toContain("to stdout");
		expect(result.output).toContain("to stderr");
	});

	it("invokes onLine once per non-empty line", async () => {
		const lines: string[] = [];
		await runCommand(node, ["-e", 'console.log("one\\ntwo\\n\\nthree");'], {
			cwd: tmpdir(),
			env: process.env,
			timeoutMs: 10_000,
			onLine: (line) => lines.push(line),
		});
		expect(lines).toEqual(["one", "two", "three"]);
	});

	it("escalates SIGTERM to SIGKILL for a child that traps SIGTERM, within a bounded wall clock", async () => {
		// The child ignores SIGTERM and would run forever. If the SIGKILL
		// escalation regressed, this test would hang rather than fail — hence the
		// wall-clock assertion, which is the property the timeout exists to give.
		const started = Date.now();
		const result = await runCommand(
			node,
			["-e", 'process.on("SIGTERM", () => {}); console.log("up"); setInterval(() => {}, 1000);'],
			{ cwd: tmpdir(), env: process.env, timeoutMs: 400 },
		);
		const elapsed = Date.now() - started;
		expect(result.timedOut).toBe(true);
		// Killed by signal, so no exit code — the caller distinguishes "timed out"
		// from "exited non-zero" by the flag, not by guessing at codes.
		expect(result.code).toBe(null);
		expect(elapsed).toBeLessThan(5_000);
	});

	it("caps captured output at HARBOR_MAX_RUN_OUTPUT_CHARS and keeps the TAIL", async () => {
		// The tail, not the head: for a build log the useful line is the error at
		// the end, and a head-slice keeps ten thousand lines of dependency
		// download progress instead.
		process.env.HARBOR_MAX_RUN_OUTPUT_CHARS = "256";
		const script =
			'process.stdout.write("HEAD_MARKER" + "x".repeat(5000) + "FINAL_MARKER\\n");';
		const result = await runCommand(node, ["-e", script], {
			cwd: tmpdir(),
			env: process.env,
			timeoutMs: 10_000,
		});
		expect(result.output.length).toBeLessThanOrEqual(256);
		expect(result.output).toContain("FINAL_MARKER");
		expect(result.output).not.toContain("HEAD_MARKER");
	});

	it("resolves with code null and a message for a nonexistent binary", async () => {
		// A missing binary must resolve, not reject: the callers treat every
		// failure as data (a hook result, a clone message), and an exception here
		// would crash the supervisor over a repo hook naming the wrong tool.
		const result = await runCommand("/definitely/not/a/binary-xyz", [], {
			cwd: tmpdir(),
			env: process.env,
			timeoutMs: 1_000,
		});
		expect(result.code).toBe(null);
		expect(result.output.trim()).not.toBe("");
	});
});

// ---------------------------------------------------------------------------
// createResumeTokenAccumulator — the fix for the unbounded turn-stdout defect
// ---------------------------------------------------------------------------

/**
 * A minimal adapter speaking a made-up `SESSION:<id>` protocol, plus a spy on
 * every string handed to `resumeTokenFrom` so the tests can assert the memory
 * bound directly: no input to the final scan may exceed the configured cap.
 * Last id wins within one input, matching how the real adapters scan backwards.
 */
function fakeAdapter(): { adapter: Pick<AgentAdapter, "resumeTokenFrom">; inputs: string[] } {
	const inputs: string[] = [];
	return {
		inputs,
		adapter: {
			resumeTokenFrom(stdout: string): string | null {
				inputs.push(stdout);
				let id: string | null = null;
				for (const line of stdout.split("\n")) {
					const match = /^SESSION:(\S+)$/.exec(line);
					if (match) id = match[1] ?? null;
				}
				return id;
			},
		},
	};
}

describe("createResumeTokenAccumulator", () => {
	it("recovers a resume id announced on line 1 and then buried under more than a cap of output", () => {
		// This is the exact Codex shape: `session_configured` is the FIRST line of
		// the turn and is never repeated. A plain tail-slice evicts it on any long
		// turn, and the next turn silently starts a fresh thread — context lost,
		// no error anywhere. The incremental capture is what closes that.
		process.env.HARBOR_MAX_RUN_OUTPUT_CHARS = "200";
		const { adapter, inputs } = fakeAdapter();
		const acc = createResumeTokenAccumulator(adapter, "/workspace/app");

		acc.absorb("SESSION:early-bird");
		for (let i = 0; i < 50; i += 1) acc.absorb(`noise line ${i} ${"x".repeat(20)}`);
		expect(acc.finish(null)).toBe("early-bird");

		// Prove the recovery came from incremental capture, not from a tail that
		// happened to still hold the id: the final tail scan must not contain it.
		expect(inputs.at(-1)).not.toContain("early-bird");
	});

	it("lets a later announcement win when the adapter re-announces the id", () => {
		// Claude Code stamps `session_id` on every event; the resume token must be
		// the LAST one seen, or a turn that forked its session resumes the fork's
		// parent. Both the tail scan and the incremental capture are last-wins.
		process.env.HARBOR_MAX_RUN_OUTPUT_CHARS = "200";
		const { adapter } = fakeAdapter();
		const acc = createResumeTokenAccumulator(adapter, "/workspace/app");

		acc.absorb("SESSION:first");
		for (let i = 0; i < 50; i += 1) acc.absorb(`noise ${"x".repeat(20)}`);
		acc.absorb("SESSION:second");
		expect(acc.finish(null)).toBe("second");
	});

	it("never hands the final scan more than the configured cap", () => {
		// The memory bound itself, asserted via the spy: the whole point of the
		// fix is that the string built across a thirty-minute turn is bounded, so
		// the final `resumeTokenFrom` input is the observable proof.
		process.env.HARBOR_MAX_RUN_OUTPUT_CHARS = "200";
		const { adapter, inputs } = fakeAdapter();
		const acc = createResumeTokenAccumulator(adapter, "/workspace/app");

		for (let i = 0; i < 200; i += 1) acc.absorb(`line ${i} ${"y".repeat(40)}`);
		acc.finish(null);

		const finalScan = inputs.at(-1);
		expect(finalScan).toBeDefined();
		expect(finalScan!.length).toBeLessThanOrEqual(200);
	});

	it("respects HARBOR_MAX_RUN_OUTPUT_CHARS as the cap", () => {
		// The cap is the shared tunable, resolved when the accumulator is created
		// (once per turn) — not a new module constant, and not a second knob.
		for (const cap of [64, 4096]) {
			process.env.HARBOR_MAX_RUN_OUTPUT_CHARS = String(cap);
			const { adapter, inputs } = fakeAdapter();
			const acc = createResumeTokenAccumulator(adapter, "/workspace/app");
			for (let i = 0; i < 300; i += 1) acc.absorb(`filler ${"z".repeat(30)}`);
			acc.finish(null);
			expect(inputs.at(-1)!.length).toBeLessThanOrEqual(cap);
			// With a roomy cap the tail is genuinely bigger — the small number is a
			// cap, not a fixed buffer size.
			if (cap === 4096) expect(inputs.at(-1)!.length).toBeGreaterThan(64);
		}
	});

	it("falls back to the previous turn's token when this turn names none", () => {
		// A turn that announces no id must not forget the thread: resume tokens
		// persist across turns and only a new announcement replaces one.
		process.env.HARBOR_MAX_RUN_OUTPUT_CHARS = "200";
		const { adapter } = fakeAdapter();
		const acc = createResumeTokenAccumulator(adapter, "/workspace/app");
		acc.absorb("nothing interesting here");
		expect(acc.finish("token-from-last-turn")).toBe("token-from-last-turn");
		expect(createResumeTokenAccumulator(fakeAdapter().adapter, "/w").finish(null)).toBe(null);
	});

	it("works against the real codex adapter: early announce survives, later re-announce wins", () => {
		// Codex is the adapter this design exists for, so pin it with the real
		// parser rather than only the fake: the old dialect announces
		// `session_configured.session_id` once, up front, before the flood.
		process.env.HARBOR_MAX_RUN_OUTPUT_CHARS = "300";
		const early = createResumeTokenAccumulator(codexAdapter, "/workspace/app");
		early.absorb('{"id":"0","msg":{"type":"session_configured","session_id":"ses-original"}}');
		for (let i = 0; i < 100; i += 1) {
			early.absorb(`{"type":"item.updated","item":{"type":"reasoning","text":"${"r".repeat(40)}"}}`);
		}
		expect(early.finish(null)).toBe("ses-original");

		// And when a later line names a thread, last-id-wins still holds because
		// the final tail scan outranks the incremental capture.
		const rethreaded = createResumeTokenAccumulator(codexAdapter, "/workspace/app");
		rethreaded.absorb('{"id":"0","msg":{"type":"session_configured","session_id":"ses-original"}}');
		rethreaded.absorb('{"type":"thread.started","thread_id":"thr-newer"}');
		expect(rethreaded.finish(null)).toBe("thr-newer");
	});
});

// ---------------------------------------------------------------------------
// runHook — real bash scripts in a real temp workspace
// ---------------------------------------------------------------------------

/** A workspace with a `.harbor/<hook>.sh` containing `body`, or no script at all. */
function hookWorkspace(hook: "setup" | "start" | null, body = "exit 0"): string {
	const workspace = tempDir("harbor-hook-");
	mkdirSync(join(workspace, ".harbor"), { recursive: true });
	if (hook !== null) {
		writeFileSync(join(workspace, ".harbor", `${hook}.sh`), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
	}
	return workspace;
}

describe("runHook", () => {
	it("returns ok for a hook that exits 0", async () => {
		const workspace = hookWorkspace("start", 'echo "services up"');
		const result = await runHook("start", supervisorConfig(), "fresh", sink(), process.env, workspace);
		expect(result).toEqual({ kind: "ok" });
	});

	it("skips silently when the repository ships no script", async () => {
		// Most repositories have no hooks at all; their boots must not warn.
		const workspace = hookWorkspace(null);
		const result = await runHook("start", supervisorConfig(), "fresh", sink(), process.env, workspace);
		// `absent` rather than a bare skip: auto-setup keys off exactly this, so
		// that a repository with no hook still gets its dependencies installed
		// while a policy skip stays a policy skip.
		expect(result).toEqual({ kind: "skipped", reason: "absent" });
	});

	it("obeys the policy skip: setup does not run on a snapshot_restore boot", async () => {
		// The script EXISTS and would exit 0, but policy says a restored
		// filesystem already contains setup's output — running it again is the
		// "setup.sh ran twice" bug the decision layer exists to prevent. The skip
		// is announced on the bridge so it is visible, not silent.
		const workspace = hookWorkspace("setup");
		const bridge = sink();
		const result = await runHook("setup", supervisorConfig(), "snapshot_restore", bridge, process.env, workspace);
		expect(result).toEqual({ kind: "skipped", reason: "policy" });
		const stages = bridge.events.map((event) => event.payload?.stage);
		expect(stages).toContain("setup.skipped");
	});

	it("fails the boot for a failing start.sh, surfacing the confidently-wrong-work reasoning", async () => {
		// start.sh starts the services the agent is TOLD exist. Tolerating its
		// failure produces an agent that "fixes" working code against a dead
		// database — the documented reasoning must reach the person reading the
		// failure, along with the script's own output.
		const workspace = hookWorkspace("start", 'echo "db refused to start"; exit 7');
		const result = await runHook("start", supervisorConfig(), "fresh", sink(), process.env, workspace);
		expect(result.kind).toBe("failed");
		if (result.kind !== "failed") return;
		expect(result.message).toContain("exited 7");
		expect(result.message).toContain("confidently wrong work");
		expect(result.message).toContain("db refused to start");
	});

	it("degrades, not fails, for a failing setup.sh on a fresh boot", async () => {
		// The asymmetry under test: a broken provisioning step leaves a usable
		// box, and converting "degraded, here is the warning" into "session
		// failed" is strictly less useful. The warning must carry the output.
		const workspace = hookWorkspace("setup", 'echo "npm install exploded"; exit 1');
		const result = await runHook("setup", supervisorConfig(), "fresh", sink(), process.env, workspace);
		expect(result.kind).toBe("degraded");
		if (result.kind !== "degraded") return;
		expect(result.warning.code).toBe("hook.setup_failed");
		expect(result.warning.message).toContain("exited 1");
		expect(result.warning.message).toContain("npm install exploded");
	});

	it("names the configured budget in the timeout message", async () => {
		// "timed out" without the number sends the operator hunting for which of
		// the many timeouts fired; the message must say 300ms so the fix — raise
		// HARBOR_START_TIMEOUT_MS — is one grep away.
		//
		// `exec sleep`, not plain `sleep`: a plain sleep is a CHILD of bash that
		// inherits the stdout pipe, and runCommand resolves on `close` — which
		// waits for every pipe holder, so killing bash alone would leave this
		// test (and a real boot) waiting out the grandchild's full 30 seconds.
		// That behaviour is real and worth knowing about; this test pins the
		// timeout message, so it uses the single-process shape.
		process.env.HARBOR_START_TIMEOUT_MS = "300";
		const workspace = hookWorkspace("start", "exec sleep 30");
		const started = Date.now();
		const result = await runHook("start", supervisorConfig(), "fresh", sink(), process.env, workspace);
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(result.kind).toBe("failed");
		if (result.kind !== "failed") return;
		expect(result.message).toContain("timed out after 300ms");
	});

	it("streams hook output to the bridge line by line", async () => {
		// A hook's progress is visible on the timeline while it runs, not only in
		// its post-mortem. This is what lets a user watch a five-minute install.
		const workspace = hookWorkspace("start", 'echo "line one"; echo "line two"');
		const bridge = sink();
		await runHook("start", supervisorConfig(), "fresh", bridge, process.env, workspace);
		const logged = bridge.events
			.filter((event) => event.type === "log")
			.map((event) => event.payload?.line);
		expect(logged).toContain("line one");
		expect(logged).toContain("line two");
	});
});

// ---------------------------------------------------------------------------
// waitForTunnels — a real file at an injectable temp path
// ---------------------------------------------------------------------------

describe("waitForTunnels", () => {
	it("deletes a stale file inherited from another sandbox before anything reads it", async () => {
		// The snapshot-restore hazard: the previous box's tunnel URLs are on disk
		// when this box boots. If they survive, start.sh binds a service to a
		// hostname that resolves at somebody else's container.
		process.env.HARBOR_TUNNEL_WAIT_MS = "80";
		const path = join(tempDir("harbor-tunnel-"), ".tunnels.env");
		writeFileSync(path, `${TUNNEL_SANDBOX_ID_KEY}=sbx_SOMEONE_ELSE\nTUNNEL_URL_3000=https://stale.test\n`);

		const env: NodeJS.ProcessEnv = { NODE_ENV: "test" };
		const bridge = sink();
		const warning = await waitForTunnels(supervisorConfig(), bridge, env, path);

		expect(existsSync(path)).toBe(false);
		expect(env.TUNNEL_URL_3000).toBeUndefined();
		// The deletion is announced, and the wait then times out (nothing else
		// appeared), which is the correct degraded outcome — never the stale vars.
		expect(bridge.events.some((event) => event.payload?.code === "tunnel.env_file_cleared")).toBe(true);
		expect(warning?.code).toBe("tunnel.env_file_wait_timeout");
	});

	it("picks up a file that appears mid-wait and exports its variables", async () => {
		process.env.HARBOR_TUNNEL_WAIT_MS = "5000";
		const path = join(tempDir("harbor-tunnel-"), ".tunnels.env");
		const env: NodeJS.ProcessEnv = { NODE_ENV: "test" };

		const started = Date.now();
		const pending = waitForTunnels(supervisorConfig({ sandboxId: "sbx_1" }), sink(), env, path);
		setTimeout(() => {
			writeFileSync(path, `${TUNNEL_SANDBOX_ID_KEY}=sbx_1\nTUNNEL_URL_3000=https://fwd.test\n`);
		}, 150);

		const warning = await pending;
		expect(warning).toBe(null);
		expect(env.TUNNEL_URL_3000).toBe("https://fwd.test");
		// It returned when the file landed, not after the full window.
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	it("uses a file that is already present and owned by this sandbox without waiting", async () => {
		// The fast-boot case: the control plane's write can legitimately land
		// before Node finishes starting. Waiting anyway would add the full window
		// to every fast boot — the best case turned into the worst one.
		process.env.HARBOR_TUNNEL_WAIT_MS = "5000";
		const path = join(tempDir("harbor-tunnel-"), ".tunnels.env");
		writeFileSync(path, `${TUNNEL_SANDBOX_ID_KEY}=sbx_1\nTUNNEL_URL_8080=https://early.test\n`);

		const env: NodeJS.ProcessEnv = { NODE_ENV: "test" };
		const started = Date.now();
		const warning = await waitForTunnels(supervisorConfig({ sandboxId: "sbx_1" }), sink(), env, path);
		expect(warning).toBe(null);
		expect(env.TUNNEL_URL_8080).toBe("https://early.test");
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it("times out with a warning and proceeds when nothing is published", async () => {
		// Timing out must degrade, never fail: a slow port forward is a local
		// problem, and failing the whole boot over it would be a total one.
		process.env.HARBOR_TUNNEL_WAIT_MS = "60";
		const path = join(tempDir("harbor-tunnel-"), ".tunnels.env");
		const started = Date.now();
		const warning = await waitForTunnels(supervisorConfig(), sink(), { NODE_ENV: "test" }, path);
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(warning?.code).toBe("tunnel.env_file_wait_timeout");
		expect(warning?.message).toContain("60ms");
	});
});

// ---------------------------------------------------------------------------
// configureGit — a real `git config --global` against a temp file
// ---------------------------------------------------------------------------

// git is safely invocable here: GIT_CONFIG_GLOBAL points every write at a temp
// file, so nothing touches the developer's real ~/.gitconfig. The reads below go
// through `git config --get` with the same environment, which also proves the
// file git wrote is one git can read back — not just that some file appeared.
describe("configureGit", () => {
	function gitEnv(): NodeJS.ProcessEnv {
		const home = tempDir("harbor-git-");
		return {
			NODE_ENV: "test",
			PATH: process.env.PATH,
			HOME: home,
			GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
			GIT_CONFIG_SYSTEM: "/dev/null",
		};
	}

	async function gitGet(env: NodeJS.ProcessEnv, key: string): Promise<{ code: number | null; value: string }> {
		const result = await runCommand("git", ["config", "--global", "--get", key], {
			cwd: env.HOME!,
			env,
			timeoutMs: 10_000,
		});
		return { code: result.code, value: result.output.trim() };
	}

	it("installs the harbor credential helper with useHttpPath and no terminal prompting", async () => {
		const env = gitEnv();
		await configureGit(supervisorConfig(), env);

		// The helper is the security boundary; useHttpPath is what gives the
		// broker a repository to scope the token to; the empty askPass and
		// GIT_TERMINAL_PROMPT=0 are what make a decline fail in milliseconds with
		// a real message instead of hanging on a terminal that does not exist.
		expect(await gitGet(env, "credential.helper")).toEqual({ code: 0, value: "harbor" });
		expect(await gitGet(env, "credential.useHttpPath")).toEqual({ code: 0, value: "true" });
		expect(await gitGet(env, "core.askPass")).toEqual({ code: 0, value: "" });
		expect(await gitGet(env, "safe.directory")).toEqual({ code: 0, value: "*" });
		expect(await gitGet(env, "advice.detachedHead")).toEqual({ code: 0, value: "false" });
		expect(env.GIT_TERMINAL_PROMPT).toBe("0");
	});

	it("exports the identifiers the helper process will inherit, including the fence", async () => {
		// The helper is a separate process spawned by git; everything it needs
		// arrives via inherited environment. A missing fence here is every git
		// operation in the box failing with a 409.
		const env = gitEnv();
		await configureGit(supervisorConfig({ sandboxId: "sbx_9", sessionId: "ses_9", fencingToken: 41 }), env);
		expect(env.HARBOR_SANDBOX_ID).toBe("sbx_9");
		expect(env.HARBOR_SESSION_ID).toBe("ses_9");
		expect(env.HARBOR_FENCING_TOKEN).toBe("41");
	});

	it("derives HARBOR_SCM_HOST from the primary repo URL, lowercased, when unset", async () => {
		const env = gitEnv();
		await configureGit(
			supervisorConfig({ repos: [{ name: "app", url: "https://GitHub.COM/acme/app.git" }] }),
			env,
		);
		expect(env.HARBOR_SCM_HOST).toBe("github.com");
	});

	it("never overwrites an explicitly configured HARBOR_SCM_HOST", async () => {
		// The control plane's statement outranks the derivation; deriving over it
		// would let a repo URL widen the helper's one-host allow-list.
		const env = { ...gitEnv(), HARBOR_SCM_HOST: "git.corp.example" };
		await configureGit(supervisorConfig(), env);
		expect(env.HARBOR_SCM_HOST).toBe("git.corp.example");
	});

	it("leaves the SCM host unset when the primary URL is unparseable — fail closed", async () => {
		// No authorised host means the helper declines everything, which is the
		// correct direction: no credential is issued to anyone.
		const env = gitEnv();
		await configureGit(supervisorConfig({ repos: [{ name: "app", url: "not a url" }] }), env);
		expect(env.HARBOR_SCM_HOST).toBeUndefined();
	});
});

/**
 * The push, against real git repositories on disk.
 *
 * A fake here would prove nothing: the properties worth asserting are that the
 * commits actually arrive on the named branch of the actual remote, that the
 * remote's other branches are untouched, and that a rejected push is reported
 * rather than forced through. All three are properties of git, so git runs.
 *
 * No network and no credential helper: the "remote" is a bare repository in a
 * temp directory, reached over a filesystem path.
 */
describe("pushWorkingBranch", () => {
	function gitEnv(home: string): NodeJS.ProcessEnv {
		return {
			NODE_ENV: "test",
			PATH: process.env.PATH,
			HOME: home,
			GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_AUTHOR_NAME: "Rin",
			GIT_AUTHOR_EMAIL: "rin@acme.test",
			GIT_COMMITTER_NAME: "Harbor",
			GIT_COMMITTER_EMAIL: "bot@harbor.test",
		};
	}

	const run = (cwd: string, env: NodeJS.ProcessEnv, args: string[]) =>
		runCommand("git", args, { cwd, env, timeoutMs: 20_000 });

	/** A bare remote with one commit on `main`, and a clone of it with the agent's work. */
	async function workspace(options: { commits?: number } = {}) {
		const home = tempDir("harbor-push-home-");
		const env = gitEnv(home);
		const remote = tempDir("harbor-push-remote-");
		const seed = tempDir("harbor-push-seed-");
		const clone = tempDir("harbor-push-clone-");

		await run(remote, env, ["init", "--bare", "--initial-branch=main", "."]);

		await run(seed, env, ["init", "--initial-branch=main", "."]);
		writeFileSync(join(seed, "README.md"), "base\n");
		await run(seed, env, ["add", "."]);
		await run(seed, env, ["commit", "-m", "base"]);
		await run(seed, env, ["remote", "add", "origin", remote]);
		await run(seed, env, ["push", "origin", "main"]);

		await run(clone, env, ["clone", remote, "."]);
		for (let index = 0; index < (options.commits ?? 1); index += 1) {
			writeFileSync(join(clone, `fix-${index}.txt`), `work ${index}\n`);
			await run(clone, env, ["add", "."]);
			await run(clone, env, ["commit", "-m", `agent commit ${index}`]);
		}

		return { env, remote, clone };
	}

	const invocation = (pushBranch: string | null) => ({
		promptId: "11111111-1111-4111-8111-111111111111",
		seq: 1,
		body: "do the thing",
		identity: { mode: "agent-only" } as const,
		timeoutMs: 10_000,
		pushBranch,
		baseBranch: "main",
	});

	const remoteBranches = async (remote: string, env: NodeJS.ProcessEnv) =>
		(await run(remote, env, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])).output
			.trim()
			.split("\n")
			.filter(Boolean);

	it("pushes the agent's commits to the named branch and reports the sha", async () => {
		const { env, remote, clone } = await workspace({ commits: 2 });
		const bridge = sink();

		await pushWorkingBranch(invocation("harbor/lse_7f3a"), clone, env, bridge);

		expect(await remoteBranches(remote, env)).toEqual(
			expect.arrayContaining(["main", "harbor/lse_7f3a"]),
		);

		const pushed = bridge.events.find((event) => event.type === "branch_pushed");
		expect(pushed).toBeDefined();
		const payload = pushed!.payload as Record<string, unknown>;
		expect(payload.branch).toBe("harbor/lse_7f3a");
		expect(payload.commits).toBe(2);
		expect(payload.uncommitted_changes).toBe(false);
		expect(String(payload.commit_sha)).toMatch(/^[0-9a-f]{40}$/);

		// The base is untouched. A push that moved `main` would be the worst
		// possible outcome of a background agent.
		const mainTip = await run(remote, env, ["rev-parse", "main"]);
		const seedTip = await run(clone, env, ["rev-parse", "origin/main"]);
		expect(mainTip.output.trim()).toBe(seedTip.output.trim());
	});

	it("emits nothing when the agent committed nothing", async () => {
		const { env, remote, clone } = await workspace({ commits: 0 });
		const bridge = sink();

		await pushWorkingBranch(invocation("harbor/lse_7f3a"), clone, env, bridge);

		expect(bridge.events.some((event) => event.type === "branch_pushed")).toBe(false);
		expect(await remoteBranches(remote, env)).toEqual(["main"]);
	});

	it("pushes committed work and flags the edits the agent left behind", async () => {
		const { env, clone } = await workspace({ commits: 1 });
		writeFileSync(join(clone, "half-done.txt"), "not committed\n");
		const bridge = sink();

		await pushWorkingBranch(invocation("harbor/lse_7f3a"), clone, env, bridge);

		const pushed = bridge.events.find((event) => event.type === "branch_pushed");
		expect((pushed!.payload as Record<string, unknown>).uncommitted_changes).toBe(true);
	});

	it("does nothing at all when no branch was sent with the prompt", async () => {
		const { env, remote, clone } = await workspace({ commits: 1 });
		const bridge = sink();

		await pushWorkingBranch(invocation(null), clone, env, bridge);

		expect(bridge.events.some((event) => event.type === "branch_pushed")).toBe(false);
		expect(await remoteBranches(remote, env)).toEqual(["main"]);
	});

	it("reports a rejected push instead of forcing it", async () => {
		// A non-fast-forward means something else wrote to this branch, which the
		// fencing token is supposed to have made impossible. Overwriting somebody's
		// commits is not an acceptable response to a violated guarantee.
		const { env, remote, clone } = await workspace({ commits: 1 });
		const other = tempDir("harbor-push-other-");
		await run(other, env, ["clone", remote, "."]);
		writeFileSync(join(other, "theirs.txt"), "someone else\n");
		await run(other, env, ["add", "."]);
		await run(other, env, ["commit", "-m", "theirs"]);
		await run(other, env, ["push", "origin", "HEAD:refs/heads/harbor/lse_7f3a"]);
		const theirTip = (await run(remote, env, ["rev-parse", "harbor/lse_7f3a"])).output.trim();

		const bridge = sink();
		await pushWorkingBranch(invocation("harbor/lse_7f3a"), clone, env, bridge);

		expect(bridge.events.some((event) => event.type === "branch_pushed")).toBe(false);
		const failure = bridge.events.find(
			(event) => (event.payload as { code?: string } | undefined)?.code === "push.failed",
		);
		expect(failure).toBeDefined();
		// Their commit is still the tip.
		expect((await run(remote, env, ["rev-parse", "harbor/lse_7f3a"])).output.trim()).toBe(theirTip);
	});

	it("does not push twice when nothing new was committed between turns", async () => {
		const { env, clone } = await workspace({ commits: 1 });
		const first = sink();
		await pushWorkingBranch(invocation("harbor/lse_7f3a"), clone, env, first);
		expect(first.events.some((event) => event.type === "branch_pushed")).toBe(true);

		// `HEAD --not --remotes` returns to zero once the branch exists on the
		// remote, so an idle second turn is silent rather than re-reporting a push.
		const second = sink();
		await pushWorkingBranch(invocation("harbor/lse_7f3a"), clone, env, second);
		expect(second.events.some((event) => event.type === "branch_pushed")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// runAutoSetup — the stand-in for a setup.sh nobody wrote
// ---------------------------------------------------------------------------

/**
 * The reason this exists: `.harbor/setup.sh` is optional and a missing one is
 * silently skipped, so every repository needed a hook written, committed and
 * reviewed before an agent could run its tests — and for a JavaScript monorepo
 * that hook is one line. These tests pin the two properties that make
 * auto-detection safe rather than merely convenient: **a hook always wins**, and
 * **a failure degrades exactly the way a failed hook would**.
 */
describe("runAutoSetup", () => {
	/** A workspace containing the named files, each empty. */
	function repoWorkspace(files: string[]): string {
		const workspace = tempDir("harbor-auto-");
		for (const file of files) writeFileSync(join(workspace, file), "");
		return workspace;
	}

	it("does nothing at all when there is nothing to install", async () => {
		const bridge = sink();
		const result = await runAutoSetup(
			supervisorConfig(),
			"fresh",
			bridge,
			process.env,
			repoWorkspace(["README.md"]),
		);
		// Not a warning: a documentation repository is not degraded.
		expect(result).toEqual({ kind: "skipped", reason: "absent" });
		expect(bridge.events.map((event) => event.payload?.stage)).toContain("auto_setup.skipped");
	});

	it("runs the detected install and announces what it detected and why", async () => {
		// `go.sum` maps to `go mod download`, which is not installed here — so the
		// assertion is on the announcement, which is what makes an auto-install
		// visible rather than magic. The exit path is covered below.
		const bridge = sink();
		const workspace = repoWorkspace(["package.json"]);
		process.env.HARBOR_SETUP_TIMEOUT_MS = "20000";
		await runAutoSetup(supervisorConfig(), "fresh", bridge, process.env, workspace);

		const announced = bridge.events.find((event) => event.payload?.stage === "auto_setup");
		expect(announced?.payload).toMatchObject({
			manager: "npm",
			evidence: "package.json",
			command: "npm install",
		});
	});

	it("refuses to guess between two lockfiles, and says which disagree", async () => {
		const result = await runAutoSetup(
			supervisorConfig(),
			"fresh",
			sink(),
			process.env,
			repoWorkspace(["pnpm-lock.yaml", "package-lock.json"]),
		);
		expect(result.kind).toBe("degraded");
		if (result.kind !== "degraded") return;
		expect(result.warning.code).toBe("auto_setup.ambiguous");
		expect(result.warning.message).toContain("pnpm-lock.yaml");
		expect(result.warning.message).toContain("package-lock.json");
	});

	it("degrades on a failed install, and names the escape hatch", async () => {
		// A command that does not exist stands in for an install that fails. The
		// asymmetry is inherited from hookPolicy rather than restated: a broken
		// provisioning step on a fresh boot degrades.
		const workspace = repoWorkspace(["package.json"]);
		process.env.PATH = "/nonexistent";
		const result = await runAutoSetup(supervisorConfig(), "fresh", sink(), process.env, workspace);
		expect(result.kind).toBe("degraded");
		if (result.kind !== "degraded") return;
		expect(result.warning.code).toBe("auto_setup.failed");
		expect(result.warning.message).toContain(".harbor/setup.sh");
	});

	it("is fatal at image-build time, where a bad install bakes in permanently", async () => {
		const workspace = repoWorkspace(["package.json"]);
		process.env.PATH = "/nonexistent";
		const result = await runAutoSetup(supervisorConfig(), "build", sink(), process.env, workspace);
		expect(result.kind).toBe("failed");
	});

	it("does not run on a boot mode whose setup is already applied", async () => {
		// A `repo_image` boot has dependencies baked in. Reinstalling is the one
		// case where doing the work again is pure cost.
		const result = await runAutoSetup(
			supervisorConfig(),
			"repo_image",
			sink(),
			process.env,
			repoWorkspace(["package.json"]),
		);
		expect(result).toEqual({ kind: "skipped", reason: "policy" });
	});

	it("is switched off entirely by HARBOR_AUTO_SETUP=0", async () => {
		process.env.HARBOR_AUTO_SETUP = "0";
		const result = await runAutoSetup(
			supervisorConfig(),
			"fresh",
			sink(),
			process.env,
			repoWorkspace(["package.json"]),
		);
		expect(result).toEqual({ kind: "skipped", reason: "policy" });
	});
});
