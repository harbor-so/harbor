// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Agents as host processes. **This one provider is not a sandbox.**
 *
 * The honest warning, scoped to where it belongs. There is no isolation boundary
 * here: the child gets the server process's user, filesystem, network and
 * credentials. That is a perfectly reasonable thing to run on your own laptop or
 * a dedicated box against your own repository — it is how most people run a
 * coding agent already — and a completely unreasonable thing to expose to a
 * second tenant. Shipping `spawn()` and calling it a platform is how you ship a
 * remote code execution vulnerability with a dashboard on top.
 *
 * What is different from the note this was ported from (`src/lib/runner.ts`) is
 * the scope of the disclaimer. Harbor as a product has a real boundary: the
 * `docker` provider is the default, it is a container per session, and it is what
 * a multi-tenant deployment runs. This file is the escape hatch for the
 * single-operator case where a container is in the way — an agent that needs the
 * host's ssh agent, a repository whose toolchain is installed on the host, a
 * five-second edit loop. So the warning is "this provider gives you no
 * isolation", not "this product gives you no isolation".
 *
 * Every guard from `runner.ts` survives, and each closes a specific hole:
 *
 *   - `HARBOR_ENABLE_RUNNER=1`, or nothing runs. Every other endpoint in Harbor
 *     reads and writes rows; this one executes a program, and a deployment that
 *     turns it on without meaning to has handed anyone who can reach the
 *     dashboard the ability to run code as the server user.
 *   - `HARBOR_WORKSPACE_DIR` is set by the operator, never by the caller. A
 *     working directory from a request body is a directory traversal with a
 *     process on the end of it.
 *   - Known binaries only, by allow-list. An arbitrary command from a request
 *     body is a shell by another name.
 *   - The prompt is an argv element. Never a shell, never a command string.
 *
 * Two things are deliberately different from `runner.ts`, and both are
 * corrections rather than ports:
 *
 *   1. **The child is detached.** A box whose lifetime is tied to the terminal
 *      that started `next dev` is not a box; restarting the control plane would
 *      kill every running agent. Detaching is only safe because of (2).
 *   2. **A record on disk, keyed by attempt id.** It is this provider's answer to
 *      what labels are for docker: without it, `findByAttemptId` after a control-
 *      plane restart returns "no box" for a process that is still running, and the
 *      reconciler starts a second agent on the same checkout. Two agents editing
 *      one working tree is the worst outcome this system can produce, and it is
 *      silent.
 */

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { setting } from "@core/kernel/config.js";
import {
	SandboxProviderError,
	assertFeaturesSupported,
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

const execFileAsync = promisify(execFile);

const PROVIDER_NAME = "local";

/**
 * The allow-list, ported verbatim in spirit from `runner.ts`.
 *
 * Two binaries, and the flags belong to us rather than to the caller. This is the
 * whole isolation story of this provider: the only thing a request can influence
 * is the prompt, and the prompt is a single argv element that the binary reads as
 * text. Widening this map is a security decision, not a configuration one, which
 * is why it is code and not an environment variable.
 */
const RUNTIMES = {
	"claude-code": {
		bin: "claude",
		args: (prompt: string) => ["-p", prompt, "--permission-mode", "acceptEdits"],
	},
	codex: {
		bin: "codex",
		args: (prompt: string) => ["exec", "--sandbox", "workspace-write", prompt],
	},
} as const;

export type LocalRuntime = keyof typeof RUNTIMES;
export const LOCAL_RUNTIME_IDS = Object.keys(RUNTIMES) as LocalRuntime[];

function isLocalRuntime(value: string): value is LocalRuntime {
	return Object.hasOwn(RUNTIMES, value);
}

/**
 * What we persist about a running box, and why each field is here.
 *
 * `pid` alone is not an identity. Pids are recycled, and a recycled pid that we
 * believe is ours means `stop()` sends SIGTERM to a stranger's process and
 * `findByAttemptId` adopts it as a sandbox. `startedAtRaw` is the fix: the
 * process start time as `ps` prints it, captured at spawn and compared verbatim
 * later. Two processes cannot share a pid *and* a start time, and comparing the
 * strings byte-for-byte avoids inventing a tolerance threshold that would then
 * have to be configurable.
 */
export interface LocalSandboxRecord {
	attemptId: string;
	sandboxId: string;
	sessionId: string;
	runtime: LocalRuntime;
	bin: string;
	pid: number;
	/** `ps -o lstart=` output, verbatim. Null if ps was unavailable — see the probe. */
	startedAtRaw: string | null;
	startedAt: string;
	workspace: string;
	logPath: string;
	timeoutMs: number;
}

/**
 * Liveness and ownership in one answer, because they are one question.
 *
 * `not_ours` and `indeterminate` are separate members and that separation is the
 * point: "the pid belongs to something else" is knowledge, "ps did not answer" is
 * the absence of knowledge, and the two callers below treat them oppositely.
 */
type ProcessProbe =
	| { kind: "ours_alive" }
	| { kind: "gone" }
	| { kind: "not_ours"; detail: string }
	| { kind: "indeterminate"; detail: string };

export class LocalSandboxProvider implements EphemeralProvider {
	readonly name = PROVIDER_NAME;
	readonly kind = "ephemeral" as const;
	/**
	 * No optional features at all, so any entry in `config.features` is refused.
	 *
	 * That refusal is more important here than anywhere else. `network_disabled`
	 * on a host process is a lie we cannot implement, and an operator who believes
	 * they turned the network off for an agent running as their own user with their
	 * own credentials has a much worse mental model than one who got an error.
	 */
	readonly supportedFeatures = [] as const;
	readonly capabilities = {
		supportsSandboxTimeout: false,
		supportsSnapshots: false,
		supportsRestore: false,
		supportsPersistentResume: false,
		supportsExplicitStop: true,
		supportsTunnels: false,
	};

	// -- guards -------------------------------------------------------------

	/**
	 * Off unless explicitly enabled, and the error says exactly what to set.
	 *
	 * Kept as `HARBOR_ENABLE_RUNNER` rather than renamed to something
	 * provider-shaped: deployments already set it, and a rename that silently
	 * disables execution for them is a worse outcome than an inconsistent name.
	 */
	private requireEnabled(operation: SandboxOperation): string {
		if (process.env.HARBOR_ENABLE_RUNNER !== "1") {
			throw new SandboxProviderError({
				message:
					"The local provider is disabled. Set HARBOR_ENABLE_RUNNER=1 to enable it — only "
					+ "on a host where running arbitrary code as the server user is acceptable. It "
					+ "gives the agent your user, your filesystem and your credentials; use the "
					+ "docker provider for anything with a second tenant in it.",
				errorType: "invalid_config",
				provider: PROVIDER_NAME,
				operation,
			});
		}
		const workspace = process.env.HARBOR_WORKSPACE_DIR;
		if (!workspace) {
			throw new SandboxProviderError({
				message:
					"HARBOR_WORKSPACE_DIR must point at the repository the agent should work in. It "
					+ "is set by the operator and never by the caller: a working directory taken "
					+ "from a request is a directory traversal with a process on the end of it.",
				errorType: "invalid_config",
				provider: PROVIDER_NAME,
				operation,
			});
		}
		return path.resolve(workspace);
	}

	/**
	 * The caller may name a subdirectory of the operator's workspace, and nothing
	 * else.
	 *
	 * `runner.ts` ignored the caller's path entirely, which was safe but made
	 * per-repository checkouts impossible. Containment is checked after resolving
	 * both sides, with the separator appended, so `/srv/work-evil` does not pass as
	 * a child of `/srv/work` — the classic prefix-comparison bug, and the reason
	 * this is not a `startsWith` on the raw strings.
	 */
	private resolveWorkspace(root: string, requested: string, operation: SandboxOperation): string {
		const resolved = path.resolve(root, requested);
		if (resolved !== root && !resolved.startsWith(root + path.sep)) {
			throw new SandboxProviderError({
				message:
					`Workspace ${JSON.stringify(requested)} resolves outside HARBOR_WORKSPACE_DIR `
					+ `(${root}). The operator's directory is the boundary; a caller cannot move it.`,
				errorType: "invalid_config",
				provider: PROVIDER_NAME,
				operation,
			});
		}
		return resolved;
	}

	/**
	 * Where the attempt records live.
	 *
	 * Under the operator's workspace by default, because it has to survive a
	 * control-plane restart to be worth having — a record in `/tmp` that a reboot
	 * clears is a record that goes missing at exactly the moment reconciliation
	 * needs it. Overridable for operators who would rather Harbor did not write
	 * inside their checkout.
	 */
	private stateDir(root: string): string {
		return process.env.HARBOR_LOCAL_STATE_DIR
			? path.resolve(process.env.HARBOR_LOCAL_STATE_DIR)
			: path.join(root, ".harbor", "sandboxes");
	}

	// -- lifecycle ----------------------------------------------------------

	async create(config: CreateSandboxConfig): Promise<CreatedSandbox> {
		const root = this.requireEnabled("create");
		assertFeaturesSupported(this, config, "create");

		// `image` is the runtime id for this provider: there are no images on a host.
		// Anything outside the allow-list is refused here rather than resolved
		// against PATH, which is the difference between "two known agents" and
		// "whatever binary a caller can name".
		if (!isLocalRuntime(config.image)) {
			throw new SandboxProviderError({
				message:
					`Unknown local runtime ${JSON.stringify(config.image)}. The local provider runs `
					+ `only ${LOCAL_RUNTIME_IDS.join(" or ")}: an arbitrary command from a request `
					+ "body is a shell by another name.",
				errorType: "invalid_config",
				provider: PROVIDER_NAME,
				operation: "create",
			});
		}
		const runtime = RUNTIMES[config.image];

		// The one element is the prompt. The flags come from the allow-list above and
		// are not the caller's to choose: `--dangerously-skip-permissions` supplied
		// as an extra argv element would be honoured by the binary, and the allow-list
		// exists precisely to make that impossible.
		const prompt = config.command?.[0];
		if (!config.command || config.command.length !== 1 || typeof prompt !== "string") {
			throw new SandboxProviderError({
				message:
					"The local provider expects `command` to be exactly one element: the prompt. "
					+ "Flags are chosen by the runtime allow-list, not by the caller.",
				errorType: "invalid_config",
				provider: PROVIDER_NAME,
				operation: "create",
			});
		}

		const workspace = this.resolveWorkspace(root, config.workspace, "create");
		if (!existsSync(workspace)) {
			throw new SandboxProviderError({
				message: `Workspace ${workspace} does not exist on this host.`,
				errorType: "invalid_config",
				provider: PROVIDER_NAME,
				operation: "create",
			});
		}

		const dir = this.stateDir(root);
		await mkdir(dir, { recursive: true });
		const logPath = path.join(dir, `${config.attemptId}.log`);

		// stdout and stderr go to a file, not to a pipe. A detached child whose pipes
		// nobody drains blocks on a full buffer and hangs mid-turn, and the control
		// plane that would have drained them is the process that just restarted.
		//
		// Nothing here truncates. `runner.ts` capped output at 200k characters
		// because it appended into a single `runs.output` column; a file on disk has
		// no such constraint, and the cap belongs to whoever ingests the file — which
		// bounds it with `maxEventPayloadChars` per event rather than guessing a
		// total up front.
		const log = await open(logPath, "a");

		const startedAt = new Date();
		const child = spawn(runtime.bin, runtime.args(prompt), {
			cwd: workspace,
			// No shell. The prompt is attacker-influenced text and an argv element is
			// the only form that cannot be reinterpreted as command syntax.
			shell: false,
			env: { ...process.env, ...config.env },
			stdio: ["ignore", log.fd, log.fd],
			// Detached, so the agent survives a control-plane restart. Only safe
			// because the record written below makes it findable again.
			detached: true,
		});

		const pid = child.pid;
		child.unref();
		await log.close();

		if (!pid) {
			throw new SandboxProviderError({
				message: `Failed to start ${runtime.bin}: no pid. Is it installed and on PATH?`,
				errorType: "invalid_config",
				provider: PROVIDER_NAME,
				operation: "create",
			});
		}

		const record: LocalSandboxRecord = {
			attemptId: config.attemptId,
			sandboxId: config.sandboxId,
			sessionId: config.sessionId,
			runtime: config.image,
			bin: runtime.bin,
			pid,
			startedAtRaw: await readProcessStart(pid),
			startedAt: startedAt.toISOString(),
			workspace,
			logPath,
			timeoutMs: config.timeoutMs,
		};

		// Written after the spawn, which leaves a window: a crash between the two
		// leaves a process with no record, and that process is unreachable by
		// reconciliation. It cannot be closed on this backend — there is no
		// equivalent of a label applied atomically at creation — so the window is
		// made as small as possible and named here rather than pretended away. The
		// docker provider has no such window, which is one more reason it is the
		// default.
		await writeFile(recordPath(dir, config.attemptId), JSON.stringify(record, null, 2), "utf8");

		warnOnce();

		return {
			externalId: externalIdFor(record),
			provider: PROVIDER_NAME,
			attemptId: config.attemptId,
			state: "running",
			createdAt: startedAt.toISOString(),
		};
	}

	async inspect(externalId: string): Promise<SandboxInspection | null> {
		const root = this.requireEnabled("inspect");
		const parsed = parseExternalId(externalId, "inspect");
		const record = await readRecord(this.stateDir(root), parsed.attemptId);
		if (!record) return null;
		if (record.pid !== parsed.pid) return null;

		const probe = await probeProcess(record);
		return {
			externalId,
			provider: PROVIDER_NAME,
			// **Liveness fails OPEN**: an indeterminate probe reads as `unknown`, which
			// `isLive` treats as live. Being wrong here costs one more probe next
			// sweep; being wrong the other way reaps a box whose agent is mid-turn.
			state: stateFromProbe(probe),
			rawState: probe.kind,
			attemptId: record.attemptId,
			sessionId: record.sessionId,
			sandboxId: record.sandboxId,
			startedAt: record.startedAt,
			exitCode: null,
		};
	}

	/**
	 * Reconciliation, and the opposite rule.
	 *
	 * **Authority fails CLOSED.** `null` is returned only when we know there is no
	 * box: no record on disk, or a record whose process is definitively gone or
	 * definitively someone else's. When the probe cannot decide — `ps` failed, or
	 * the record predates a host where start times were unavailable — this throws
	 * `transient` instead, because the caller's response to `null` is to spawn a
	 * second agent into the same working tree, and two agents editing one checkout
	 * is silent, uncorrectable corruption.
	 *
	 * Note the asymmetry with `inspect` directly above: identical uncertainty,
	 * opposite conclusions. Liveness resolves uncertainty towards "still there";
	 * authority resolves it towards "I do not have the right to act". Both point
	 * away from the destructive action, which is why they look contradictory and
	 * are not.
	 */
	async findByAttemptId(attemptId: string): Promise<SandboxInspection | null> {
		const root = this.requireEnabled("find_by_attempt");
		const record = await readRecord(this.stateDir(root), attemptId);
		if (!record) return null;

		const probe = await probeProcess(record);
		switch (probe.kind) {
			case "ours_alive":
				return this.inspect(externalIdFor(record));
			case "gone":
				return null;
			case "not_ours":
				// The pid was recycled. Our box is definitively gone, and adopting the
				// stranger occupying its pid would be worse than reporting nothing.
				return null;
			case "indeterminate":
				throw new SandboxProviderError({
					message:
						`Cannot determine whether the local sandbox for attempt ${attemptId} is still `
						+ `running (${probe.detail}). Refusing to report it as absent: the caller would `
						+ "start a second agent in the same working tree.",
					errorType: "transient",
					provider: PROVIDER_NAME,
					operation: "find_by_attempt",
				});
		}
		return assertNeverProbe(probe);
	}

	/**
	 * Every record whose process the probe confirms as ours and alive.
	 *
	 * An `indeterminate` probe THROWS rather than skipping the record: skipping
	 * would report a population that silently omits exactly the processes nobody
	 * can account for, and the caller reads this list as complete. Same authority
	 * rule as `findByAttemptId`, one paragraph up.
	 */
	async listManaged(): Promise<SandboxInspection[]> {
		const root = this.requireEnabled("list_managed");
		const records = await listLocalRecords(this.stateDir(root));
		const found: SandboxInspection[] = [];
		for (const record of records) {
			const probe = await probeProcess(record);
			switch (probe.kind) {
				case "ours_alive": {
					const inspection = await this.inspect(externalIdFor(record));
					if (inspection) found.push(inspection);
					break;
				}
				case "gone":
				case "not_ours":
					break;
				case "indeterminate":
					throw new SandboxProviderError({
						message:
							`Cannot determine whether the local sandbox for attempt ${record.attemptId} `
							+ `is still running (${probe.detail}). Refusing to return a partial list: the `
							+ "caller treats it as the complete population of running boxes.",
						errorType: "transient",
						provider: PROVIDER_NAME,
						operation: "list_managed",
					});
				default:
					assertNeverProbe(probe);
			}
		}
		return found;
	}

	async stop(externalId: string, options?: StopOptions): Promise<StopOutcome> {
		const root = this.requireEnabled("stop");
		const parsed = parseExternalId(externalId, "stop");
		const dir = this.stateDir(root);
		const record = await readRecord(dir, parsed.attemptId);
		if (!record || record.pid !== parsed.pid) return "absent";

		const probe = await probeProcess(record);
		const disposition = stopDispositionFor(probe);
		if (disposition.action === "already_stopped") {
			await removeRecord(dir, record.attemptId);
			return "already_stopped";
		}
		if (disposition.action === "refuse_to_signal") {
			throw new SandboxProviderError({
				message:
					`Cannot confirm that pid ${record.pid} is still the agent we started `
					+ `(${disposition.detail}). Not signalling it: killing a process we cannot identify `
					+ "is worse than leaving one running.",
				errorType: "transient",
				provider: PROVIDER_NAME,
				operation: "stop",
			});
		}

		/**
		 * SIGTERM, then SIGKILL after the grace.
		 *
		 * The two signals are the `stop` versus `cancel` distinction from the agent
		 * contract made concrete: SIGTERM lets the agent finish writing the file it is
		 * mid-write on, and killing immediately is how you get a truncated source file
		 * in the working tree that the next turn then tries to compile.
		 */
		const graceMs = options?.graceMs ?? setting("sandboxHeartbeatIntervalMs");
		try {
			process.kill(record.pid, "SIGTERM");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") {
				await removeRecord(dir, record.attemptId);
				return "already_stopped";
			}
			throw new SandboxProviderError({
				message: `Failed to signal pid ${record.pid}: ${(error as Error).message}`,
				errorType: "unknown",
				provider: PROVIDER_NAME,
				operation: "stop",
				cause: error,
			});
		}

		// Poll rather than sleeping out the whole grace, so a well-behaved agent that
		// exits in 40ms does not hold the stop path open for fifteen seconds while a
		// sweep waits behind it. The interval is derived from the grace, not chosen:
		// twenty samples is enough resolution for any grace, and the floor keeps a
		// very short grace from becoming a spin loop.
		const pollMs = Math.max(25, Math.round(graceMs / 20));
		const deadline = Date.now() + graceMs;
		while (Date.now() < deadline) {
			if ((await probeProcess(record)).kind !== "ours_alive") {
				await removeRecord(dir, record.attemptId);
				return "stopped";
			}
			await delay(pollMs);
		}

		try {
			process.kill(record.pid, "SIGKILL");
		} catch {
			// It exited between the last poll and here. That is the outcome we wanted.
		}
		await removeRecord(dir, record.attemptId);
		return "stopped";
	}
}

// ---------------------------------------------------------------------------
// Process identity
// ---------------------------------------------------------------------------

/**
 * The process start time exactly as `ps` prints it.
 *
 * Captured at spawn and compared verbatim later. Comparing formatted strings
 * rather than parsed timestamps is deliberate: a parsed comparison needs a
 * tolerance, a tolerance is a threshold, and a threshold belongs in `src/config.ts`
 * — for a value that exists only to distinguish "same process" from "recycled
 * pid", where exact equality is both simpler and stricter.
 *
 * Null means `ps` could not tell us, which downgrades every later probe to
 * `indeterminate` rather than to a guess.
 */
async function readProcessStart(pid: number): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], {
			shell: false,
		});
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

async function probeProcess(record: LocalSandboxRecord): Promise<ProcessProbe> {
	try {
		// Signal 0 checks existence and permission without delivering anything.
		process.kill(record.pid, 0);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return { kind: "gone" };
		if (code === "EPERM") {
			// The pid exists but belongs to another user. We spawned ours as this
			// user, so it cannot be ours — knowledge, not uncertainty.
			return { kind: "not_ours", detail: `pid ${record.pid} belongs to another user` };
		}
		return { kind: "indeterminate", detail: `kill(0) failed with ${code ?? "an unknown error"}` };
	}

	if (!record.startedAtRaw) {
		return {
			kind: "indeterminate",
			detail: "no start-time baseline was captured for this attempt, so pid reuse cannot be ruled out",
		};
	}

	let current: string;
	try {
		const { stdout } = await execFileAsync("ps", ["-p", String(record.pid), "-o", "lstart="], {
			shell: false,
		});
		current = stdout.trim();
	} catch (error) {
		const failure = error as { stderr?: string; stdout?: string };
		// `ps` exits non-zero with no output for a pid that no longer exists, and
		// non-zero with a message for anything else. The first is an answer; the
		// second is a failure to get one, and they must not be collapsed.
		if (!failure.stderr?.trim() && !failure.stdout?.trim()) return { kind: "gone" };
		return { kind: "indeterminate", detail: `ps failed: ${failure.stderr?.trim() ?? "unknown"}` };
	}

	if (!current) return { kind: "gone" };
	if (current !== record.startedAtRaw) {
		return {
			kind: "not_ours",
			detail: `pid ${record.pid} started at ${current}, not ${record.startedAtRaw}`,
		};
	}
	return { kind: "ours_alive" };
}

function stateFromProbe(probe: ProcessProbe): ProviderSandboxState {
	switch (probe.kind) {
		case "ours_alive":
			return "running";
		case "gone":
			return "gone";
		case "not_ours":
			return "gone";
		case "indeterminate":
			return "unknown";
	}
	return assertNeverProbe(probe);
}

/**
 * What a probe means for `stop`, in a switch that RETURNS on every arm.
 *
 * The returns are the point. This replaces a `switch` written inline in `stop`
 * whose `ours_alive` arm was a bare `break` — which meant TypeScript re-unioned
 * the arms afterwards instead of narrowing to `never`, so a fifth `ProcessProbe`
 * member would compile with no case here and **fall straight through to the
 * SIGTERM below**. That is the one outcome this file argues at length must never
 * happen on an unidentified process: a pid we cannot prove is ours is, on a
 * developer's laptop, their editor. Adding a member is now a compile error at the
 * `assertNeverProbe` line rather than a signal sent to a stranger.
 */
type StopDisposition =
	| { action: "signal" }
	| { action: "already_stopped" }
	| { action: "refuse_to_signal"; detail: string };

function stopDispositionFor(probe: ProcessProbe): StopDisposition {
	switch (probe.kind) {
		case "ours_alive":
			return { action: "signal" };
		case "gone":
			return { action: "already_stopped" };
		case "not_ours":
			// Refusing to signal is the entire reason the start-time check exists.
			// SIGTERM to a recycled pid kills whatever now owns it. The record is
			// cleared by the caller because our box is definitively gone.
			return { action: "already_stopped" };
		case "indeterminate":
			// "ps did not answer" is the absence of knowledge, not knowledge that the
			// process is a stranger, and the two are deliberately not collapsed — see
			// `ProcessProbe`. Authority fails closed: no signal is sent.
			return { action: "refuse_to_signal", detail: probe.detail };
	}
	return assertNeverProbe(probe);
}

/** Local mirror of `assertNever`, typed to this file's closed set. */
function assertNeverProbe(probe: never): never {
	throw new Error(`Unhandled process probe ${JSON.stringify(probe)}.`);
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/**
 * `local:<attemptId>:<pid>`.
 *
 * The pid alone would be a smaller id and a worse one: it is not stable across a
 * reboot and it is not unique over time, and an external id that silently starts
 * referring to a different box is the same pid-reuse bug one layer up.
 */
function externalIdFor(record: LocalSandboxRecord): string {
	return `local:${record.attemptId}:${record.pid}`;
}

function parseExternalId(
	externalId: string,
	operation: SandboxOperation,
): { attemptId: string; pid: number } {
	const parts = externalId.split(":");
	const pid = Number(parts[2]);
	const attemptId = parts[1] ?? "";
	if (parts.length !== 3 || parts[0] !== "local" || !attemptId || !Number.isInteger(pid) || pid <= 0) {
		throw new SandboxProviderError({
			message: `${JSON.stringify(externalId)} is not a local sandbox id (local:<attempt>:<pid>).`,
			errorType: "invalid_config",
			provider: PROVIDER_NAME,
			operation,
		});
	}
	return { attemptId, pid };
}

/**
 * Attempt ids become filenames, so they are validated before they are joined.
 *
 * Without this, an attempt id of `../../etc/cron.d/harbor` is a file write
 * outside the state directory, performed by the server user. The ids come from
 * our own database today; the guard costs one regex and survives the day
 * something else supplies them.
 */
const ATTEMPT_ID_SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function recordPath(dir: string, attemptId: string): string {
	if (!ATTEMPT_ID_SAFE.test(attemptId)) {
		throw new SandboxProviderError({
			message:
				`Attempt id ${JSON.stringify(attemptId)} is not safe to use as a filename. It would `
				+ "let a caller write outside the state directory as the server user.",
			errorType: "invalid_config",
			provider: PROVIDER_NAME,
			operation: "create",
		});
	}
	return path.join(dir, `${attemptId}.json`);
}

async function readRecord(dir: string, attemptId: string): Promise<LocalSandboxRecord | null> {
	// Resolved outside the try. Inside it, the filename validation's
	// `invalid_config` would be caught by the handler below and rewritten as
	// `transient` — turning a refusal to touch `../../etc/cron.d/harbor` into a
	// failure the caller is expected to retry.
	const file = recordPath(dir, attemptId);
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new SandboxProviderError({
			message: `Could not read the local sandbox record for ${attemptId}: ${(error as Error).message}`,
			errorType: "transient",
			provider: PROVIDER_NAME,
			operation: "find_by_attempt",
			cause: error,
		});
	}
	try {
		return JSON.parse(text) as LocalSandboxRecord;
	} catch (error) {
		// A truncated record is not "no box" — a process it described may well be
		// running. Throwing keeps the caller from concluding absence.
		throw new SandboxProviderError({
			message: `The local sandbox record for ${attemptId} is corrupt and cannot be trusted.`,
			errorType: "unknown",
			provider: PROVIDER_NAME,
			operation: "find_by_attempt",
			cause: error,
		});
	}
}

async function removeRecord(dir: string, attemptId: string): Promise<void> {
	await unlink(recordPath(dir, attemptId)).catch(() => {});
}

/**
 * Every attempt this host still has a record for. Used by the reaper and by
 * operators asking "what did Harbor leave running on my machine".
 */
export async function listLocalRecords(dir: string): Promise<LocalSandboxRecord[]> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const records: LocalSandboxRecord[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const record = await readRecord(dir, name.slice(0, -".json".length)).catch(() => null);
		if (record) records.push(record);
	}
	return records;
}

// ---------------------------------------------------------------------------

let warned = false;

/**
 * Said once per process, on the first spawn.
 *
 * Once, not per create: a warning printed on every prompt is a warning people
 * filter out, and this is the one line an operator needs to have read before they
 * point this provider at a machine with anything else on it.
 */
function warnOnce(): void {
	if (warned) return;
	warned = true;
	console.warn(
		"[local] This provider gives the agent no isolation: your user, your filesystem, your "
			+ "credentials, your network. It is for a single-operator host. Use the docker provider "
			+ "for anything with a second tenant in it.",
	);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The one instance. Stateless — all of its state is on disk, on purpose. */
export function localProvider(): EphemeralProvider {
	return new LocalSandboxProvider();
}
