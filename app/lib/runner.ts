// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Launching an agent from Harbor, rather than waiting for one to connect.
 *
 * What this is: Harbor spawns a headless coding agent as a child process on the
 * host running the server, with its own MCP endpoint injected, pointed at a task
 * it has already claimed. Output streams into `runs` and onto the dashboard.
 *
 * What this is emphatically NOT: an execution sandbox. There is no isolation
 * boundary here — the child gets the server process's user, filesystem and
 * network. That is a reasonable thing to run on your own laptop or a single
 * dedicated box against your own repository, and a completely unreasonable thing
 * to expose to another tenant. Multi-tenant execution needs a real isolation
 * boundary — a container or a VM, which is what the sandbox providers are for.
 * Shipping `spawn()` and calling it a platform is how you ship a remote code
 * execution vulnerability with a dashboard on top.
 *
 * The guards below reflect that: launching is off unless explicitly enabled, the
 * runtime must be one of two known binaries, the working directory must be
 * configured by the operator rather than supplied by the caller, and the prompt
 * is passed as an argv element — never through a shell.
 */

import { spawn } from "node:child_process";
import { eq, sql as raw } from "drizzle-orm";
import { setting } from "@core/kernel/config.js";
import { db } from "@core/schema/index.js";
import { runs } from "@core/schema/schema.js";
import { mcpUrl } from "@core/kernel/urls.js";
import { notifyChange, touchPresence } from "@core/kernel/work.js";

/** Only these two. An arbitrary command from a request body is a shell. */
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

export type Runtime = keyof typeof RUNTIMES;
export const RUNTIME_IDS = Object.keys(RUNTIMES) as Runtime[];



export class RunnerDisabledError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RunnerDisabledError";
	}
}

export function runnerEnabled(): boolean {
	return process.env.HARBOR_ENABLE_RUNNER === "1" && Boolean(process.env.HARBOR_WORKSPACE_DIR);
}

/**
 * Why this is opt-in rather than on by default.
 *
 * Every other endpoint in Harbor reads and writes rows. This one executes a
 * program. A deployment that turns it on without meaning to has handed anyone who
 * can reach the dashboard the ability to run code as the server user — so the
 * default is off, and the error says exactly what to set rather than failing
 * mysteriously.
 */
function requireRunner(): string {
	if (process.env.HARBOR_ENABLE_RUNNER !== "1") {
		throw new RunnerDisabledError(
			"Launching agents is disabled. Set HARBOR_ENABLE_RUNNER=1 to enable it — "
				+ "only on a host where running arbitrary code as the server user is acceptable.",
		);
	}
	const workspace = process.env.HARBOR_WORKSPACE_DIR;
	if (!workspace) {
		throw new RunnerDisabledError(
			"HARBOR_WORKSPACE_DIR must point at the repository the agent should work in.",
		);
	}
	return workspace;
}

export interface LaunchInput {
	orgId: string;
	runtime: Runtime;
	prompt: string;
	agentId: string;
	taskId?: string;
	apiKey: string;
}

/**
 * Start an agent and return immediately with a run id.
 *
 * The child outlives the request on purpose — an HTTP handler that waited for a
 * coding agent would hit every proxy timeout there is. Progress is observable
 * through `runs.output` and the SSE stream instead.
 */
export async function launchRun(input: LaunchInput): Promise<{ runId: string }> {
	const workspace = requireRunner();
	const runtime = RUNTIMES[input.runtime];
	if (!runtime) throw new RunnerDisabledError(`Unknown runtime "${input.runtime}".`);

	const [run] = await db
		.insert(runs)
		.values({
			orgId: input.orgId,
			taskId: input.taskId ?? null,
			agentId: input.agentId,
			runtime: input.runtime,
			prompt: input.prompt,
			status: "starting",
		})
		.returning({ id: runs.id });
	const runId = run!.id;

	// The agent is given Harbor's own MCP endpoint, so the process Harbor launched
	// coordinates through Harbor like any other agent — it claims, it releases, it
	// appears in presence. Anything else would make launched agents the one class
	// of agent the product cannot see.
	const mcpConfig = JSON.stringify({
		mcpServers: {
			harbor: {
				type: "http",
				url: mcpUrl(),
				headers: { Authorization: `Bearer ${input.apiKey}` },
			},
		},
	});

	const child = spawn(runtime.bin, runtime.args(input.prompt), {
		cwd: workspace,
		// No shell. The prompt is attacker-influenced text and an argv element is
		// the only form that cannot be reinterpreted as command syntax.
		shell: false,
		env: {
			...process.env,
			HARBOR_API_KEY: input.apiKey,
			HARBOR_AGENT_ID: input.agentId,
			HARBOR_MCP_CONFIG: mcpConfig,
		},
		stdio: ["ignore", "pipe", "pipe"],
		detached: false,
	});

	await db
		.update(runs)
		.set({ status: "running", pid: String(child.pid ?? "") })
		.where(eq(runs.id, runId));
	await touchPresence(input.orgId, input.agentId, `run:${input.runtime}`, input.taskId);

	// Buffer and flush on a timer rather than writing per chunk: a build log
	// arrives in hundreds of small writes and one UPDATE each would swamp the
	// database and the notify channel with nothing new to say.
	let buffer = "";
	let total = 0;
	let truncated = false;

	const append = (chunk: Buffer) => {
		if (truncated) return;
		const text = chunk.toString();
		total += text.length;
		if (total > setting("maxRunOutputChars")) {
			buffer += `\n… output truncated at ${setting("maxRunOutputChars")} characters …`;
			truncated = true;
			return;
		}
		buffer += text;
	};

	child.stdout.on("data", append);
	child.stderr.on("data", append);

	const flush = async () => {
		if (!buffer) return;
		const pending = buffer;
		buffer = "";
		await db
			.update(runs)
			// Append in SQL so two flushes can never clobber one another.
			.set({ output: raw`${runs.output} || ${pending}` })
			.where(eq(runs.id, runId))
			.catch(() => {});
		await notifyChange(input.orgId, "run_output");
	};

	const timer = setInterval(() => void flush(), setting("runOutputFlushMs"));

	child.on("close", async (code) => {
		clearInterval(timer);
		await flush();
		await db
			.update(runs)
			.set({
				status: code === 0 ? "completed" : "failed",
				exitCode: String(code ?? ""),
				endedAt: new Date(),
			})
			.where(eq(runs.id, runId))
			.catch(() => {});
		await notifyChange(input.orgId, "run_finished");
	});

	child.on("error", async (error) => {
		clearInterval(timer);
		await db
			.update(runs)
			.set({
				status: "failed",
				output: `Failed to start ${runtime.bin}: ${error.message}`,
				endedAt: new Date(),
			})
			.where(eq(runs.id, runId))
			.catch(() => {});
		await notifyChange(input.orgId, "run_finished");
	});

	return { runId };
}

