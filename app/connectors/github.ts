// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * GitHub is an inbound-only task source. Keeping completion summaries out of
 * repositories avoids turning a coordination tool into another issue-writing
 * integration and keeps repository permissions read-only.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@core/schema/index.js";
import { tasks } from "@core/schema/schema.js";
import { markPullRequestMerged } from "../lib/artifacts.js";
import { createTask } from "@core/kernel/work.js";
import type { Connector, ConnectorContext, WebhookResult } from "./types.js";

interface GitHubItem {
	number: number;
	title: string;
	body?: string | null;
	merged?: boolean;
	state?: string;
	/** The canonical URL. What a `pull_request` artifact stores, and the join key. */
	html_url?: string;
	/** ISO 8601, present on a merged pull request. */
	merged_at?: string;
}

interface GitHubPayload {
	action: string;
	issue?: GitHubItem;
	pull_request?: GitHubItem;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseItem(value: unknown): GitHubItem | null {
	if (!isRecord(value) || typeof value.number !== "number" || typeof value.title !== "string") {
		return null;
	}
	return {
		number: value.number,
		title: value.title,
		body: typeof value.body === "string" || value.body === null ? value.body : undefined,
		merged: typeof value.merged === "boolean" ? value.merged : undefined,
		state: typeof value.state === "string" ? value.state : undefined,
		html_url: typeof value.html_url === "string" ? value.html_url : undefined,
		merged_at: typeof value.merged_at === "string" ? value.merged_at : undefined,
	};
}

/**
 * When this pull request merged, or null if it did not.
 *
 * GitHub does not send `action: "merged"` — a merge arrives as `action: "closed"`
 * with `pull_request.merged: true`, and a PR closed without merging arrives as
 * the same action with `merged: false`. Treating "closed" as merged would count
 * every abandoned pull request as a delivered one, which on the headline metric
 * is the difference between a real number and a flattering one.
 *
 * `merged_at` is preferred over the receipt time because a redelivered webhook
 * hours later must record when the merge happened, not when Harbor heard about
 * it. It falls back to `now` only when the payload omits it while still claiming
 * `merged: true` — a shape the API does not currently produce, and one where
 * refusing to record the merge at all would be the worse answer.
 */
function mergedAtOf(item: GitHubItem, now: Date): Date | null {
	if (item.merged !== true) return null;
	if (!item.merged_at) return now;
	const parsed = new Date(item.merged_at);
	return Number.isNaN(parsed.getTime()) ? now : parsed;
}

function parsePayload(payload: unknown): GitHubPayload | null {
	if (!isRecord(payload) || typeof payload.action !== "string") return null;
	const issue = parseItem(payload.issue);
	const pullRequest = parseItem(payload.pull_request);
	if (!issue && !pullRequest) return null;
	return { action: payload.action, issue: issue ?? undefined, pull_request: pullRequest ?? undefined };
}

export function verifyGitHubWebhook(
	rawBody: string,
	headers: Record<string, string | undefined>,
	secret: string,
): boolean {
	const supplied = headers["x-hub-signature-256"];
	if (!supplied?.startsWith("sha256=")) return false;
	const hex = supplied.slice("sha256=".length);
	if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
	const expected = createHmac("sha256", secret).update(rawBody).digest();
	const actual = Buffer.from(hex, "hex");
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * The installation id, from the verified payload.
 *
 * GitHub scopes every App webhook to an installation, and that is exactly the
 * tenant boundary Harbor needs. Reading `repository.owner.id` instead would look
 * equivalent and would break the moment one organisation installs the App on two
 * accounts, because two installations would collapse to one Harbor org.
 */
export function resolveGitHubAccount(payload: unknown): string | null {
	if (!isRecord(payload)) return null;
	if (isRecord(payload.installation) && payload.installation.id !== undefined) {
		return String(payload.installation.id);
	}
	return null;
}

export async function handleGitHubWebhook(
	payload: unknown,
	ctx: ConnectorContext,
): Promise<WebhookResult> {
	const orgId = ctx.orgId;
	const parsed = parsePayload(payload);
	if (!parsed) return { action: "ignored", reason: "Unrecognised GitHub webhook payload." };

	const item = parsed.issue ?? parsed.pull_request;
	if (!item) return { action: "ignored", reason: "GitHub webhook has no issue or pull request." };
	const isIssue = Boolean(parsed.issue);
	const allowed = isIssue
		? ["opened", "closed", "reopened", "edited"]
		: ["opened", "closed", "merged"];
	if (!allowed.includes(parsed.action)) {
		return {
			action: "ignored",
			reason: `GitHub ${isIssue ? "issue" : "pull request"} action ${parsed.action} is not synced.`,
		};
	}

	// Before the task bookkeeping, and independent of it. A pull request Harbor
	// opened frequently has no task behind it — a session started from Slack or the
	// dashboard produces one — and the merged-PR metric must count it either way.
	// Reading it off the task's status instead would only ever measure the subset
	// of work that arrived as a GitHub issue.
	if (parsed.pull_request && item.html_url) {
		const mergedAt = mergedAtOf(item, new Date());
		if (mergedAt) {
			await markPullRequestMerged({ orgId, url: item.html_url, mergedAt });
		}
	}

	const sourceRef = String(item.number);
	const existing = await db.query.tasks.findFirst({
		where: and(eq(tasks.orgId, orgId), eq(tasks.source, "github"), eq(tasks.sourceRef, sourceRef)),
	});
	const completed =
		parsed.action === "closed" ||
		parsed.action === "merged" ||
		item.merged === true ||
		item.state === "closed";
	if (!existing) {
		const created = await createTask(orgId, {
			title: item.title,
			description: item.body ?? undefined,
			source: "github",
			sourceRef,
		});
		if (completed) {
			await db.update(tasks).set({ status: "completed", updatedAt: new Date() }).where(eq(tasks.id, created.id));
		}
		return { action: "created", taskId: created.id };
	}

	await db
		.update(tasks)
		.set({
			title: item.title,
			description: item.body ?? null,
			status: completed ? "completed" : "open",
			updatedAt: new Date(),
		})
		.where(eq(tasks.id, existing.id));
	return { action: "updated", taskId: existing.id };
}

export const githubConnector: Connector = {
	type: "github",
	verifyWebhook: verifyGitHubWebhook,
	resolveAccount: resolveGitHubAccount,
	handleWebhook: handleGitHubWebhook,
	// Deliberately empty. Issue and pull-request sync is inbound only; the writes
	// Harbor makes to GitHub — pushing a branch, opening a pull request — go
	// through `src/git/`, under the prompting user's own token, and are declared
	// there rather than here. Listing them in both places would let the two
	// declarations disagree, and this one is what a security reviewer reads.
	outboundWrites: [],
};
