// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * GitLab is an inbound-only task source, exactly like GitHub: an issue or merge
 * request becomes a task, and nothing is written back through the connector.
 * Keeping completion out of the repository keeps GitLab permissions read-only and
 * keeps this from turning into a second issue-writing integration.
 *
 * The one real difference from GitHub is authentication. GitLab does not HMAC the
 * body; it sends the literal secret you configured on the webhook in an
 * `X-Gitlab-Token` header. So verification is a constant-time comparison of that
 * header against the stored secret, not a signature over the bytes — and the
 * stored `webhookSecret` IS that token rather than an HMAC key. A plain `===`
 * here would leak the token one byte at a time under a timing attack, which is why
 * this reuses `secretEquals`.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@core/schema/index.js";
import { tasks } from "@core/schema/schema.js";
import { secretEquals } from "../lib/crypto.js";
import { createTask } from "@core/kernel/work.js";
import type { Connector, ConnectorContext, WebhookResult } from "./types.js";

interface GitLabAttributes {
	/** Globally unique across the instance — used as the source ref so two projects' `#42`s don't collide. */
	id: number;
	title: string;
	description?: string | null;
	state?: string;
	action?: string;
}

interface GitLabPayload {
	object_kind: string;
	object_attributes?: GitLabAttributes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseAttributes(value: unknown): GitLabAttributes | null {
	if (!isRecord(value) || typeof value.id !== "number" || typeof value.title !== "string") {
		return null;
	}
	return {
		id: value.id,
		title: value.title,
		description:
			typeof value.description === "string" || value.description === null
				? value.description
				: undefined,
		state: typeof value.state === "string" ? value.state : undefined,
		action: typeof value.action === "string" ? value.action : undefined,
	};
}

function parsePayload(payload: unknown): GitLabPayload | null {
	if (!isRecord(payload) || typeof payload.object_kind !== "string") return null;
	return {
		object_kind: payload.object_kind,
		object_attributes: parseAttributes(payload.object_attributes) ?? undefined,
	};
}

export function verifyGitLabWebhook(
	_rawBody: string,
	headers: Record<string, string | undefined>,
	secret: string,
): boolean {
	const supplied = headers["x-gitlab-token"];
	// Constant-time even though this is a whole-token compare rather than an HMAC:
	// a length-then-`===` check leaks the token, and the token is the only thing
	// standing between an anonymous POST and a spawned sandbox.
	return typeof supplied === "string" && supplied.length > 0 && secretEquals(supplied, secret);
}

/**
 * The tenant key. GitLab has no per-installation id like GitHub's, so the
 * top-level namespace (the group the project lives under) is the stable boundary:
 * one connector row per group, and a deployment serving two GitLab groups keeps
 * them apart. Read from the verified payload, never from a header.
 */
export function resolveGitLabAccount(payload: unknown): string | null {
	if (!isRecord(payload)) return null;
	const project = isRecord(payload.project) ? payload.project : null;
	if (!project) return null;
	if (typeof project.namespace === "string" && project.namespace) return project.namespace;
	// `path_with_namespace` is `group/subgroup/repo`; its first segment is the group.
	if (typeof project.path_with_namespace === "string" && project.path_with_namespace) {
		return project.path_with_namespace.split("/")[0] ?? null;
	}
	return null;
}

export async function handleGitLabWebhook(
	payload: unknown,
	ctx: ConnectorContext,
): Promise<WebhookResult> {
	const parsed = parsePayload(payload);
	if (!parsed) return { action: "ignored", reason: "Unrecognised GitLab webhook payload." };

	const isIssue = parsed.object_kind === "issue";
	const isMergeRequest = parsed.object_kind === "merge_request";
	if (!isIssue && !isMergeRequest) {
		return { action: "ignored", reason: `GitLab ${parsed.object_kind} events are not synced.` };
	}

	const item = parsed.object_attributes;
	if (!item) {
		return { action: "ignored", reason: "GitLab webhook has no object_attributes." };
	}

	// GitLab's `action`: open | reopen | update | close | merge. Only these five
	// exist on issues and merge requests; anything else (an `approved`, a label
	// change GitLab may add later) is ignored rather than treated as a state change.
	const allowed = ["open", "reopen", "update", "close", "merge"];
	if (item.action && !allowed.includes(item.action)) {
		return { action: "ignored", reason: `GitLab action ${item.action} is not synced.` };
	}

	const sourceRef = String(item.id);
	const completed =
		item.action === "close" ||
		item.action === "merge" ||
		item.state === "closed" ||
		item.state === "merged";

	const existing = await db.query.tasks.findFirst({
		where: and(eq(tasks.orgId, ctx.orgId), eq(tasks.source, "gitlab"), eq(tasks.sourceRef, sourceRef)),
	});

	if (!existing) {
		const created = await createTask(ctx.orgId, {
			title: item.title,
			description: item.description ?? undefined,
			source: "gitlab",
			sourceRef,
		});
		if (completed) {
			await db
				.update(tasks)
				.set({ status: "completed", updatedAt: new Date() })
				.where(eq(tasks.id, created.id));
		}
		return { action: "created", taskId: created.id };
	}

	await db
		.update(tasks)
		.set({
			title: item.title,
			description: item.description ?? null,
			status: completed ? "completed" : "open",
			updatedAt: new Date(),
		})
		.where(eq(tasks.id, existing.id));
	return { action: "updated", taskId: existing.id };
}

export const gitlabConnector: Connector = {
	type: "gitlab",
	verifyWebhook: verifyGitLabWebhook,
	resolveAccount: resolveGitLabAccount,
	handleWebhook: handleGitLabWebhook,
	// Inbound only, exactly like GitHub. The writes Harbor makes to a GitLab repo —
	// pushing a branch, opening a merge request — belong in `src/git/` under the
	// prompting user's own token, declared there rather than duplicated here where
	// the two declarations could drift.
	outboundWrites: [],
};
