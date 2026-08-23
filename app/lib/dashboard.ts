// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Reads for the dashboard.
 *
 * Separate from src/lib/work.ts on purpose: work.ts is the agent-facing surface
 * and its shapes are tuned for token cost, while these are tuned for a human
 * reading a table. Sharing one function would mean every field a human wants
 * becomes a field an agent pays for.
 */

import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "@core/schema/index.js";
import { apiKeys, connectors, digests, events, projects, repoImages, repos, tasks } from "@core/schema/schema.js";

export async function recentEvents(orgId: string, limit = 40) {
	return db
		.select({
			id: events.id,
			type: events.type,
			agentId: events.agentId,
			payload: events.payload,
			createdAt: events.createdAt,
			taskTitle: tasks.title,
			project: projects.name,
		})
		.from(events)
		.leftJoin(tasks, eq(events.taskId, tasks.id))
		.leftJoin(projects, eq(tasks.projectId, projects.id))
		.where(eq(events.orgId, orgId))
		.orderBy(desc(events.createdAt))
		.limit(limit);
}

/** Conflicts prevented in the last seven days — the number the product is judged by. */
export async function conflictsPrevented(orgId: string): Promise<number> {
	const since = new Date(Date.now() - 7 * 86_400_000);
	const rows = await db
		.select({ id: events.id })
		.from(events)
		.where(
			and(
				eq(events.orgId, orgId),
				eq(events.type, "claim_conflict"),
				gte(events.createdAt, since),
			),
		);
	return rows.length;
}

export async function listDigests(orgId: string) {
	return db
		.select()
		.from(digests)
		.where(eq(digests.orgId, orgId))
		.orderBy(desc(digests.createdAt))
		.limit(20);
}

export async function listConnectors(orgId: string) {
	return db
		.select({
			id: connectors.id,
			type: connectors.type,
			status: connectors.status,
			// The tenant key, and safe to show: it is an id the workspace already knows
			// about itself. `config` is deliberately NOT selected — it holds bot tokens
			// and webhook secrets, and a column that never leaves this query cannot be
			// leaked by a page that forgets to omit it.
			externalAccountId: connectors.externalAccountId,
			lastSyncedAt: connectors.lastSyncedAt,
			createdAt: connectors.createdAt,
		})
		.from(connectors)
		.where(eq(connectors.orgId, orgId));
}

/** Never returns key material — only the hash exists, and not even that leaves here. */
export async function listApiKeys(orgId: string) {
	return db
		.select({
			id: apiKeys.id,
			label: apiKeys.label,
			createdAt: apiKeys.createdAt,
			revokedAt: apiKeys.revokedAt,
		})
		.from(apiKeys)
		.where(eq(apiKeys.orgId, orgId))
		.orderBy(desc(apiKeys.createdAt));
}

export async function listProjects(orgId: string) {
	return db.select().from(projects).where(eq(projects.orgId, orgId)).orderBy(projects.name);
}

/**
 * Prebuilt-image status per repo — the "last built" surface, the image analogue of a
 * connector's `lastSyncedAt`.
 *
 * `imageRef` is null until the first success and `pausedReason` non-null when the repo
 * auto-paused, so a page can derive a status pill without a separate query: paused if
 * `pausedReason`, healthy if `imageRef`, otherwise pending its first build.
 */
export async function listRepoImages(orgId: string) {
	return db
		.select({
			repoId: repoImages.repoId,
			owner: repos.owner,
			name: repos.name,
			imageRef: repoImages.imageRef,
			builtFromSha: repoImages.builtFromSha,
			builtAt: repoImages.builtAt,
			builtByProvider: repoImages.builtByProvider,
			nextBuildAt: repoImages.nextBuildAt,
			consecutiveFailures: repoImages.consecutiveFailures,
			pausedReason: repoImages.pausedReason,
		})
		.from(repoImages)
		.innerJoin(repos, eq(repoImages.repoId, repos.id))
		.where(eq(repoImages.orgId, orgId))
		.orderBy(desc(repoImages.builtAt));
}
