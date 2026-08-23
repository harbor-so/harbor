// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Weekly activity is reduced before it reaches Claude.
 *
 * Sending raw events would make the model rediscover joins and payload semantics
 * on every run, while also paying for unrelated coordination noise. This module
 * keeps that interpretation deterministic and leaves the model only the prose
 * job; the client construction stays at the final boundary so an empty week is
 * free and the provider can be swapped without changing collection.
 */

import Anthropic from "@anthropic-ai/sdk";
import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import { db } from "@core/schema/index.js";
import { digests, events, projects, tasks } from "@core/schema/schema.js";
import { recordTokenUsage } from "./cost.js";

const DIGEST_INSTRUCTION =
	"Summarize this week's agent activity for a team standup. Group by project. " +
	"Call out any claim conflicts that were prevented. Keep it under 200 words, " +
	"plain prose, no fluff.";
const EMPTY_DIGEST = "No agent activity this week.";
const UNASSIGNED_PROJECT = "No project";

export interface CompletedActivity {
	task: string;
	agent: string;
	summary: string;
}

export interface ConflictActivity {
	task: string;
	heldBy: string;
	blocked: string;
}

export interface ProjectActivity {
	project: string;
	completed: CompletedActivity[];
	conflicts: ConflictActivity[];
}

export interface Activity {
	projects: ProjectActivity[];
}

export class MissingAnthropicApiKeyError extends Error {
	constructor() {
		super("ANTHROPIC_API_KEY is required to generate a weekly digest. Set it in the environment and retry.");
		this.name = "MissingAnthropicApiKeyError";
	}
}

function payloadText(payload: unknown, key: string): string | null {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
	const value = Reflect.get(payload, key);
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function hasActivity(activity: Activity): boolean {
	return activity.projects.some(
		(project) => project.completed.length > 0 || project.conflicts.length > 0,
	);
}

export async function collectActivity(
	orgId: string,
	since: Date,
	until: Date,
): Promise<Activity> {
	const rows = await db
		.select({
			type: events.type,
			agent: events.agentId,
			payload: events.payload,
			task: tasks.title,
			project: projects.name,
		})
		.from(events)
		.leftJoin(tasks, eq(events.taskId, tasks.id))
		.leftJoin(projects, eq(tasks.projectId, projects.id))
		.where(
			and(
				eq(events.orgId, orgId),
				gte(events.createdAt, since),
				lt(events.createdAt, until),
				inArray(events.type, ["completed", "claim_conflict"]),
			),
		)
		.orderBy(asc(events.createdAt), asc(events.id));

	const grouped = new Map<string, ProjectActivity>();
	for (const row of rows) {
		if (!row.task || !row.agent) continue;
		const summary = row.type === "completed" ? payloadText(row.payload, "summary") : null;
		const heldBy = row.type === "claim_conflict" ? payloadText(row.payload, "heldBy") : null;
		if (!summary && !heldBy) continue;

		const project = row.project ?? UNASSIGNED_PROJECT;
		let group = grouped.get(project);
		if (!group) {
			group = { project, completed: [], conflicts: [] };
			grouped.set(project, group);
		}

		if (row.type === "completed") {
			if (summary) group.completed.push({ task: row.task, agent: row.agent, summary });
		} else {
			if (heldBy) group.conflicts.push({ task: row.task, heldBy, blocked: row.agent });
		}
	}

	return { projects: [...grouped.values()] };
}

export function renderActivityPrompt(activity: Activity): string {
	if (!hasActivity(activity)) return EMPTY_DIGEST;

	const lines: string[] = [];
	for (const project of activity.projects) {
		lines.push(project.project);
		for (const item of project.completed) {
			lines.push(`done: ${item.task} | ${item.agent} | ${item.summary}`);
		}
		for (const item of project.conflicts) {
			lines.push(`conflict: ${item.task} | held ${item.heldBy} | blocked ${item.blocked}`);
		}
	}
	return lines.join("\n");
}

/** Prefix on every mocked digest. Load-bearing — see `mockDigest`. */
export const MOCK_PREFIX = "[mock digest — no model was called]";

/**
 * A digest assembled by string concatenation, for demo mode.
 *
 * This exists because the whole product should be explorable without an
 * Anthropic key, and the digest was the one thing that could not run.
 *
 * The prefix is not decoration and must not be removed. The original design
 * refused to produce anything at all without a key, on the grounds that a
 * plausible-looking summary nobody re-reads is worse than a visible failure —
 * and that reasoning still holds. Labelling is what makes a fake summary safe:
 * it can be shown, screenshotted and demoed, and no one can mistake it for the
 * model's work. Demo mode is opt-in via HARBOR_DEMO_MODE precisely so this can
 * never engage by accident on a deployment where somebody forgot the key.
 */
export function mockDigest(activity: Activity): string {
	const lines: string[] = [MOCK_PREFIX, ""];

	let completed = 0;
	let conflicts = 0;
	for (const project of activity.projects) {
		completed += project.completed.length;
		conflicts += project.conflicts.length;
	}

	lines.push(
		`${completed} ${completed === 1 ? "task" : "tasks"} shipped across `
			+ `${activity.projects.length} ${activity.projects.length === 1 ? "project" : "projects"}.`,
		"",
	);

	for (const project of activity.projects) {
		if (project.completed.length === 0 && project.conflicts.length === 0) continue;
		lines.push(`${project.project}`);
		for (const item of project.completed) {
			lines.push(`  · ${item.task} — ${item.summary} (${item.agent})`);
		}
		for (const item of project.conflicts) {
			lines.push(
				`  · collision avoided on ${item.task}: ${item.blocked} was blocked, `
					+ `${item.heldBy} already held it`,
			);
		}
		lines.push("");
	}

	if (conflicts > 0) {
		lines.push(
			`${conflicts} ${conflicts === 1 ? "collision" : "collisions"} prevented — that is `
				+ `${conflicts} ${conflicts === 1 ? "piece" : "pieces"} of duplicated work that did not happen.`,
		);
	}

	return lines.join("\n").trim();
}

export function demoMode(): boolean {
	return process.env.HARBOR_DEMO_MODE === "1";
}

/**
 * What one digest generation produced — the prose, and what it cost.
 *
 * `usage` is null exactly when no model was called (empty activity, demo mode):
 * a digest that cost nothing reports nothing, and a digest that called the API
 * reports the real token counts so `generateAndStoreDigest` can write the cost
 * row. This was the one model call in the product with no accounting at all.
 */
export interface DigestGeneration {
	body: string;
	model: string | null;
	usage: { inputTokens: number; outputTokens: number } | null;
}

export async function generateDigest(activity: Activity): Promise<DigestGeneration> {
	if (!hasActivity(activity)) return { body: EMPTY_DIGEST, model: null, usage: null };

	const apiKey = process.env.ANTHROPIC_API_KEY;
	// A real key always wins, even in demo mode: if one is present there is no
	// reason to show a fake.
	if (!apiKey) {
		if (demoMode()) return { body: mockDigest(activity), model: null, usage: null };
		throw new MissingAnthropicApiKeyError();
	}

	const client = new Anthropic({ apiKey });
	const model = "claude-sonnet-4-5";
	const response = await client.messages.create({
		model,
		max_tokens: 300,
		system: DIGEST_INSTRUCTION,
		messages: [{ role: "user", content: renderActivityPrompt(activity) }],
	});
	const body = response.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
	return {
		body,
		model,
		usage: {
			inputTokens: response.usage.input_tokens,
			outputTokens: response.usage.output_tokens,
		},
	};
}

export async function generateAndStoreDigest(orgId: string, since: Date, until: Date) {
	const activity = await collectActivity(orgId, since, until);
	const generation = await generateDigest(activity);
	const [digest] = await db
		.insert(digests)
		.values({ orgId, periodStart: since, periodEnd: until, body: generation.body })
		.returning();
	if (!digest) throw new Error("Digest insert did not return a row.");

	// The cost row, keyed on the digest row so a retry cannot double-count.
	// Recorded after the insert because the digest id IS the idempotency key;
	// a failure here loses accounting, not the digest, and is said so.
	if (generation.usage !== null) {
		try {
			await recordTokenUsage({
				orgId,
				key: `digest:${digest.id}`,
				model: generation.model,
				usage: {
					inputTokens: generation.usage.inputTokens,
					outputTokens: generation.usage.outputTokens,
				},
			});
		} catch (error) {
			console.error(`[digest] cost row for digest ${digest.id} failed:`, error);
		}
	}
	return digest;
}
