// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * A demo org that exercises every state the product has, so `db:seed` followed
 * by the dashboard shows something real: open work, work in flight, finished
 * work, and — most importantly — a claim whose lease has already lapsed, so the
 * sweeper has something to do the moment it starts.
 */

import { eq } from "drizzle-orm";
import { db, sql } from "@core/schema/index.js";
import { apiKeys, claims, events, orgs, projects, tasks } from "@core/schema/schema.js";
import { hashApiKey, mintApiKey } from "@core/kernel/keys.js";
import { scopeForTask } from "@core/kernel/work.js";

const now = new Date();

// TRUNCATE CASCADE, matching every other reset in the repo. Ordered DELETEs
// missed `users`, `connectors` and `digests`, so re-seeding any database where
// somebody had signed in or run `npm run demo` failed with a foreign-key
// violation (23503) on the orgs delete.
await sql`truncate table session_prompts, session_participants, sessions, runs, agent_presence, events, claims, tasks, projects, api_keys, digests, connectors, users, orgs cascade`;

const [org] = await db.insert(orgs).values({ name: "Acme Corp" }).returning();
const orgId = org!.id;

const [backend] = await db
	.insert(projects)
	.values({ orgId, name: "backend", description: "API and services" })
	.returning();
const [frontend] = await db
	.insert(projects)
	.values({ orgId, name: "frontend", description: "Web app" })
	.returning();

const rawKey = mintApiKey();
await db.insert(apiKeys).values({ orgId, keyHash: hashApiKey(rawKey), label: "demo key" });

const seeded = await db
	.insert(tasks)
	.values([
		{
			orgId,
			projectId: backend!.id,
			title: "Fix auth token refresh bug",
			description: "Refresh races on concurrent requests and drops the new token.",
			scope: "src/auth/**",
			status: "open",
		},
		{
			orgId,
			projectId: backend!.id,
			title: "Add rate limiting to /api/search",
			description: "Search is unmetered and one client can saturate it.",
			scope: "src/api/search.ts",
			status: "open",
		},
		{
			orgId,
			projectId: frontend!.id,
			title: "Virtualise the task table",
			description: "The table renders every row; it stutters past ~500.",
			scope: "app/components/task-table.tsx",
			status: "open",
		},
		{
			orgId,
			projectId: backend!.id,
			title: "Backfill missing created_at on legacy rows",
			scope: "migrations/**",
			status: "open",
			source: "linear",
			sourceRef: "ACM-482",
		},
		{
			orgId,
			projectId: frontend!.id,
			title: "Dark mode flashes white on first paint",
			scope: "app/layout.tsx",
			status: "open",
			source: "github",
			sourceRef: "311",
		},
	])
	.returning();

// One task actively claimed, so the dashboard has something in flight.
await db.insert(claims).values({
	orgId,
	scope: scopeForTask(seeded[1]!),
	taskId: seeded[1]!.id,
	agentId: "claude-code:wt-2",
	intent: "Refactor the retry path so a failed webhook does not double-charge.",
	expiresAt: new Date(now.getTime() + 22 * 60_000),
});
await db.update(tasks).set({ status: "claimed" }).where(eq(tasks.id, seeded[1]!.id));

// One task whose lease lapsed 10 minutes ago — the sweeper's first job, and the
// fixture the definition-of-done checks.
await db.insert(claims).values({
	orgId,
	scope: scopeForTask(seeded[2]!),
	taskId: seeded[2]!.id,
	agentId: "codex:worktree-a",
	intent: "Investigate the intermittent 500s on the deploy webhook.",
	claimedAt: new Date(now.getTime() - 45 * 60_000),
	expiresAt: new Date(now.getTime() - 10 * 60_000),
});
await db.update(tasks).set({ status: "claimed" }).where(eq(tasks.id, seeded[2]!.id));

// Two finished pieces of work and a prevented collision, so the digest has real
// material the first time it is generated.
await db.insert(events).values([
	{
		orgId,
		taskId: seeded[0]!.id,
		agentId: "claude-code:wt-1",
		type: "completed",
		payload: { summary: "Serialised refresh behind a mutex; added a regression test." },
		createdAt: new Date(now.getTime() - 2 * 86_400_000),
	},
	{
		orgId,
		taskId: seeded[3]!.id,
		agentId: "codex:worktree-b",
		type: "completed",
		payload: { summary: "Backfilled 41k rows in batches; verified no nulls remain." },
		createdAt: new Date(now.getTime() - 86_400_000),
	},
	{
		orgId,
		taskId: seeded[1]!.id,
		agentId: "codex:worktree-c",
		type: "claim_conflict",
		payload: { heldBy: "claude-code:wt-2" },
		createdAt: new Date(now.getTime() - 3 * 3_600_000),
	},
]);

console.log("seeded org 'Acme Corp'");
console.log(`  projects: backend, frontend`);
console.log(`  tasks:    ${seeded.length}`);
console.log(`  API KEY:  ${rawKey}`);
console.log("\nSave that key — only its hash is stored.");
await sql.end();
