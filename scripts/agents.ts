// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * A fake fleet of agents, driving the real server.
 *
 * Nothing here is stubbed below the MCP boundary. Each simulated agent is a real
 * `@modelcontextprotocol/sdk` client speaking Streamable HTTP to the actual Harbor
 * server, calling the actual five tools, against the actual Postgres. The only
 * fiction is that a language model is choosing the work — a `setTimeout` does.
 *
 * That distinction is the point. A demo that fakes the coordination layer proves
 * nothing about the coordination layer; this one produces genuine claims,
 * genuine conflicts written by the partial unique index, and genuine expiries
 * swept by the sweeper. Watch the dashboard while it runs and every number
 * moving is real.
 *
 *   npm run demo            # load the dataset
 *   npm run mcp             # server on :8788
 *   npm run demo:agents     # this
 *
 * Agents deliberately contend. Six of them picking from a pool of ten tasks with
 * jittered timing collide within seconds, which is the behaviour worth watching
 * and the one a careful sequential script would never produce.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_URL = process.env.HARBOR_MCP_URL ?? "http://localhost:8788/mcp";
const API_KEY = process.env.HARBOR_API_KEY;
const ROUNDS = Number(process.env.HARBOR_DEMO_ROUNDS ?? 8);

const AGENTS = [
	"claude-code:wt-1",
	"claude-code:wt-2",
	"claude-code:wt-3",
	"codex:worktree-a",
	"codex:worktree-b",
	"conductor:infra-2",
];

/** Work an agent "discovers" mid-task. Keeps the pool from draining. */
const DISCOVERED_WORK = [
	{ title: "Retry the S3 upload on 503 instead of failing the job", project: "backend", scope: "src/workers/upload.ts" },
	{ title: "Timezone is dropped when parsing user-supplied dates", project: "backend", scope: "src/lib/dates.ts" },
	{ title: "Empty state renders before the query resolves", project: "frontend", scope: "app/components/empty.tsx" },
	{ title: "Sourcemaps are missing from the production bundle", project: "frontend", scope: "next.config.js" },
	{ title: "Health check passes while the DB pool is exhausted", project: "infra", scope: "infra/health/**" },
	{ title: "Log lines lose the request id inside worker threads", project: "infra", scope: "infra/logging/**" },
];

/** Why an agent says it is taking a task. Populates the intent field. */
const INTENTS = [
	"Blocking three support tickets; fix before the Friday release.",
	"Root cause of the p99 spike we saw in the incident on Tuesday.",
	"Prerequisite for the billing migration — has to land first.",
	"Reported twice this week; cheap to fix now, expensive later.",
	"Cleanup the auth refactor left behind; no behaviour change intended.",
	"Customer escalation from the enterprise pilot.",
];

const WORK_NOTES = [
	"Added a regression test and made the failure deterministic.",
	"Narrowed the lock to the critical section; contention gone.",
	"Replaced the polling loop with a subscription.",
	"Cached the lookup; p50 down by an order of magnitude.",
	"Split the migration so it can run without downtime.",
	"Handled the null case the original author documented but never wrote.",
];

if (!API_KEY) {
	console.error("HARBOR_API_KEY is required. Run `npm run demo` and export the key it prints.");
	process.exit(1);
}

function text(result: unknown): string {
	const content = (result as { content: Array<{ type: string; text?: string }> }).content;
	return content.map((block) => block.text ?? "").join("\n");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = (base: number) => base + Math.floor(Math.random() * base);
const pick = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)]!;

async function connect(): Promise<Client> {
	const client = new Client({ name: "harbor-demo-agent", version: "0.0.0" });
	await client.connect(
		new StreamableHTTPClientTransport(new URL(MCP_URL), {
			requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } },
		}),
	);
	return client;
}

/**
 * One agent's loop: look, claim, work, release.
 *
 * The interesting branch is the failed claim. A real agent that is told "held by
 * codex:worktree-a" should go and do something else, and that is exactly what
 * happens here — it drops back to the top of the loop and picks again. Retrying
 * the same task would busy-wait on a lease and is the behaviour the tool
 * description explicitly steers models away from.
 */
async function runAgent(agentId: string): Promise<{ claimed: number; blocked: number }> {
	const client = await connect();
	let claimed = 0;
	let blocked = 0;

	try {
		for (let round = 0; round < ROUNDS; round += 1) {
			await sleep(jitter(700));

			const listing = text(
				await client.callTool({ name: "list_work", arguments: { status: "open" } }),
			);
			const ids = [...listing.matchAll(/\[(\w{4})\]/g)].map((match) => match[1]!);
			if (ids.length === 0) {
				// An agent with nothing to claim files something instead, which is both
				// what a real one does when it trips over a bug mid-task and what keeps
				// this demo from draining its own pool after two rounds. It also means
				// all five tools get exercised rather than three.
				const found = pick(DISCOVERED_WORK);
				const created = text(
					await client.callTool({
						name: "create_task",
						arguments: { title: found.title, project: found.project, scope: found.scope },
					}),
				);
				console.log(`  + ${agentId} filed ${created.split(" — ")[0]}`);
				continue;
			}

			const target = pick(ids);
			const result = text(
				await client.callTool({
					name: "claim",
					arguments: {
						task_id: target,
						agent_id: agentId,
						lease_minutes: 2,
						intent: pick(INTENTS),
					},
				}),
			);

			if (result.startsWith("no ")) {
				blocked += 1;
				console.log(`  ✗ ${agentId} blocked on [${target}] — picking something else`);
				continue;
			}

			claimed += 1;
			console.log(`  ✓ ${agentId} claimed [${target}]`);

			// "Working". Long enough that other agents contend meanwhile.
			await sleep(jitter(1500));

			// One in six abandons instead of finishing, so the demo shows a task
			// returning to the pool rather than only ever completing.
			if (Math.random() < 1 / 6) {
				await client.callTool({
					name: "release",
					arguments: { task_id: target, agent_id: agentId },
				});
				console.log(`  ↩ ${agentId} gave [${target}] back`);
			} else {
				await client.callTool({
					name: "release",
					arguments: {
						task_id: target,
						agent_id: agentId,
						completion_summary: pick(WORK_NOTES),
					},
				});
				console.log(`  ● ${agentId} completed [${target}]`);
			}
		}
	} finally {
		await client.close();
	}

	return { claimed, blocked };
}

console.log(`Starting ${AGENTS.length} agents against ${MCP_URL}`);
console.log("Watch http://localhost:3000 while this runs.\n");

const results = await Promise.all(AGENTS.map((agent) => runAgent(agent)));

const claimed = results.reduce((total, r) => total + r.claimed, 0);
const blocked = results.reduce((total, r) => total + r.blocked, 0);

console.log(`\n${AGENTS.length} agents, ${ROUNDS} rounds each`);
console.log(`  ${claimed} tasks claimed`);
console.log(`  ${blocked} collisions prevented`);
console.log(
	blocked > 0
		? `\nThose ${blocked} are the product: each one is two agents that would have done the same work.`
		: "\nNo collisions this run — raise HARBOR_DEMO_ROUNDS or shrink the task pool to force contention.",
);
