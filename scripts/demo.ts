// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * A believable Tuesday afternoon for a team running six agents.
 *
 * Distinct from `seed.ts`, which is the minimum needed to exercise every code
 * path. This one is for looking at: enough tasks that the table has to be
 * scanned rather than read, several agents mid-flight with staggered leases, a
 * lapsed lease waiting for the sweeper, and a week of history behind it so the
 * digest and the collisions-prevented counter have real material.
 *
 *   npm run demo
 */

import { eq } from "drizzle-orm";
import { db, sql } from "@core/schema/index.js";
import { apiKeys, claims, connectors, digests, events, orgs, projects, tasks } from "@core/schema/schema.js";
import { hashApiKey, mintApiKey } from "@core/kernel/keys.js";
import { scopeForTask } from "@core/kernel/work.js";

const now = Date.now();
const ago = (ms: number) => new Date(now - ms);
const ahead = (ms: number) => new Date(now + ms);
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

await sql`truncate table session_prompts, session_participants, sessions, runs, agent_presence, events, claims, tasks, projects, api_keys, digests, connectors, users, orgs cascade`;

const [org] = await db.insert(orgs).values({ name: "Acme Corp" }).returning();
const orgId = org!.id;

const projectRows = await db
	.insert(projects)
	.values([
		{ orgId, name: "backend", description: "API, workers, data" },
		{ orgId, name: "frontend", description: "Web app" },
		{ orgId, name: "infra", description: "Deploys and observability" },
	])
	.returning();
const [backend, frontend, infra] = projectRows;

const key = mintApiKey();
await db.insert(apiKeys).values({ orgId, keyHash: hashApiKey(key), label: "demo" });
await db.insert(connectors).values([
	{
		orgId,
		type: "github",
		status: "active",
		config: { webhookSecret: "demo-secret", repo: "acme/api" },
		lastSyncedAt: ago(4 * MIN),
	},
	{
		orgId,
		type: "linear",
		status: "active",
		config: { webhookSecret: "demo-secret", team: "ACM" },
		lastSyncedAt: ago(11 * MIN),
	},
]);

const seeded = await db
	.insert(tasks)
	.values([
		{ orgId, projectId: backend!.id, title: "Fix auth token refresh race on concurrent requests", scope: "src/auth/**", status: "open" },
		{ orgId, projectId: backend!.id, title: "Add rate limiting to /api/search", scope: "src/api/search.ts", status: "open" },
		{ orgId, projectId: backend!.id, title: "Webhook handler acks before commit, drops events", scope: "src/webhooks/**", status: "open", source: "linear", sourceRef: "ACM-482" },
		{ orgId, projectId: backend!.id, title: "Backfill created_at on legacy invoice rows", scope: "migrations/**", status: "open", source: "linear", sourceRef: "ACM-491" },
		{ orgId, projectId: frontend!.id, title: "Virtualise the task table past 500 rows", scope: "app/components/task-table.tsx", status: "open" },
		{ orgId, projectId: frontend!.id, title: "Dark mode flashes white on first paint", scope: "app/layout.tsx", status: "open", source: "github", sourceRef: "311" },
		{ orgId, projectId: frontend!.id, title: "Keyboard focus lost after closing the command palette", scope: "app/components/command-palette.tsx", status: "open", source: "github", sourceRef: "318" },
		{ orgId, projectId: infra!.id, title: "Staging deploys time out waiting on migrations", scope: "infra/deploy/**", status: "open" },
		{ orgId, projectId: infra!.id, title: "Alert on p99 latency, not just error rate", scope: "infra/monitoring/**", status: "open" },
		{ orgId, projectId: backend!.id, title: "Idempotency keys on the payments endpoint", scope: "src/api/payments/**", status: "open" },
	])
	.returning();

/** Four agents mid-flight, with staggered leases so the countdowns differ. */
const live: Array<[number, string, number]> = [
	[0, "claude-code:wt-1", 24 * MIN],
	[2, "codex:worktree-a", 11 * MIN],
	[4, "claude-code:wt-3", 38 * MIN],
	[7, "conductor:infra-2", 6 * MIN],
];
for (const [index, agentId, remaining] of live) {
	await db.insert(claims).values({
		orgId,
		scope: scopeForTask(seeded[index]!),
		taskId: seeded[index]!.id,
		agentId,
		intent: `Working ${seeded[index]!.title.toLowerCase()} for this demo fleet.`,
		claimedAt: ago(30 * MIN - remaining),
		expiresAt: ahead(remaining),
	});
	await db.update(tasks).set({ status: "claimed" }).where(eq(tasks.id, seeded[index]!.id));
}

// One agent died holding a lease. The sweeper picks this up within a minute of
// the server starting, which is the behaviour worth watching in a demo.
await db.insert(claims).values({
	orgId,
	scope: scopeForTask(seeded[8]!),
	taskId: seeded[8]!.id,
	agentId: "codex:worktree-c",
	intent: "Take the flaky integration test green before the release cut.",
	claimedAt: ago(52 * MIN),
	expiresAt: ago(7 * MIN),
});
await db.update(tasks).set({ status: "claimed" }).where(eq(tasks.id, seeded[8]!.id));

/** A week of history: eleven completions and four prevented collisions. */
/** [taskIndex, summary, agent, ageMs] — the index ties each completion to a real
 *  row so the feed reads as history rather than eleven events on one task. */
const completions: Array<[number, string, string, number]> = [
	[0, "Serialised token refresh behind a mutex; added a regression test.", "claude-code:wt-1", 2 * DAY],
	[3, "Backfilled 41k invoice rows in batches; verified no nulls remain.", "codex:worktree-b", 2 * DAY],
	[2, "Moved the ack after the commit; replayed 3 dropped events.", "claude-code:wt-2", 1 * DAY],
	[1, "Added windowed rate limiting at 100 req/min per key.", "codex:worktree-a", 1 * DAY],
	[4, "Virtualised rows with an intersection observer; 500 → 50k smooth.", "claude-code:wt-3", 20 * HOUR],
	[5, "Set the theme class before paint from a blocking inline script.", "conductor:fe-1", 18 * HOUR],
	[6, "Restored focus to the trigger element on palette close.", "claude-code:wt-1", 9 * HOUR],
	[7, "Raised the migration timeout and made deploys wait properly.", "conductor:infra-2", 7 * HOUR],
	[8, "Added p99 latency alerting at 800ms over 5 minutes.", "codex:worktree-a", 5 * HOUR],
	[9, "Idempotency keys stored for 24h; duplicate charges now impossible.", "claude-code:wt-2", 3 * HOUR],
	[2, "Cached the org lookup; webhook p50 down from 340ms to 22ms.", "codex:worktree-b", 2 * HOUR],
];
for (const [index, summary, agentId, age] of completions) {
	await db.insert(events).values({
		orgId,
		taskId: seeded[index]!.id,
		agentId,
		type: "completed",
		payload: { summary },
		createdAt: ago(age),
	});
}

const conflicts: Array<[number, string, string, number]> = [
	[0, "codex:worktree-c", "claude-code:wt-1", 3 * HOUR],
	[2, "claude-code:wt-2", "codex:worktree-a", 6 * HOUR],
	[4, "conductor:fe-1", "claude-code:wt-3", 19 * HOUR],
	[7, "codex:worktree-b", "conductor:infra-2", 2 * DAY],
];
for (const [index, blocked, holder, age] of conflicts) {
	await db.insert(events).values({
		orgId,
		taskId: seeded[index]!.id,
		agentId: blocked,
		type: "claim_conflict",
		payload: { heldBy: holder },
		createdAt: ago(age),
	});
}

await db.insert(digests).values({
	orgId,
	periodStart: ago(14 * DAY),
	periodEnd: ago(7 * DAY),
	body:
		"Backend shipped the auth refresh fix and the invoice backfill — the refresh race "
		+ "had been the top source of 401s and is now covered by a regression test. Frontend "
		+ "landed the virtualised task table, which took the 500-row stutter off the board. "
		+ "Infra spent most of the week on deploy reliability.\n\n"
		+ "Two collisions were caught before any work was duplicated: codex:worktree-c and "
		+ "claude-code:wt-2 both went for the webhook ack bug within the same hour, and "
		+ "conductor:fe-1 tried to take the table virtualisation while claude-code:wt-3 was "
		+ "already 20 minutes into it.",
	createdAt: ago(7 * DAY),
});

console.log("demo data loaded");
console.log(`  org       Acme Corp`);
console.log(`  projects  backend, frontend, infra`);
console.log(`  tasks     ${seeded.length} (4 in flight, 1 lease lapsed, 5 open)`);
console.log(`  history   ${completions.length} completions, ${conflicts.length} collisions prevented`);
console.log(`  API KEY   ${key}`);
await sql.end();
