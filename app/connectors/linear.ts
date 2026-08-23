// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Linear contributes issue metadata to Harbor and receives only completion
 * comments. Full two-way state sync is intentionally excluded: competing state
 * machines would make webhook ordering determine which system wins.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@core/schema/index.js";
import { tasks } from "@core/schema/schema.js";
import { createTask } from "@core/kernel/work.js";
import type { Connector, ConnectorActivity, ConnectorContext, WebhookResult } from "./types.js";

interface LinearIssue {
	id: string;
	identifier: string;
	title: string;
	description?: string | null;
	state?: { type?: string };
}

interface LinearPayload {
	action: "create" | "update";
	type: "Issue";
	data: LinearIssue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parsePayload(payload: unknown): LinearPayload | null {
	if (!isRecord(payload) || payload.type !== "Issue") return null;
	if (payload.action !== "create" && payload.action !== "update") return null;
	if (!isRecord(payload.data)) return null;
	const data = payload.data;
	if (
		typeof data.id !== "string" ||
		typeof data.identifier !== "string" ||
		typeof data.title !== "string"
	) return null;
	const state = isRecord(data.state) && typeof data.state.type === "string"
		? { type: data.state.type }
		: undefined;
	return {
		action: payload.action,
		type: "Issue",
		data: {
			id: data.id,
			identifier: data.identifier,
			title: data.title,
			description:
				typeof data.description === "string" || data.description === null
					? data.description
					: undefined,
			state,
		},
	};
}

export function verifyLinearWebhook(
	rawBody: string,
	headers: Record<string, string | undefined>,
	secret: string,
): boolean {
	const supplied = headers["linear-signature"];
	if (!supplied || !/^[0-9a-f]{64}$/i.test(supplied)) return false;
	const expected = createHmac("sha256", secret).update(rawBody).digest();
	const actual = Buffer.from(supplied, "hex");
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function resolveLinearAccount(payload: unknown): string | null {
	if (!isRecord(payload)) return null;
	if (typeof payload.organizationId === "string") return payload.organizationId;
	if (isRecord(payload.organization) && typeof payload.organization.id === "string") {
		return payload.organization.id;
	}
	return null;
}

/**
 * `sourceRef` holds the issue **UUID**, not the `ACM-482` identifier.
 *
 * This was a real bug and it is worth naming because the wrong choice looks
 * obviously right. The identifier is what a person types and what Harbor should
 * display, so storing it reads as the friendly option. But Linear's API takes the
 * UUID everywhere, and the identifier is not stable: moving an issue between
 * teams renumbers it. So the outbound comment path — implemented, but calling
 * `commentCreate` with `ACM-482` where a UUID belongs — failed for every issue,
 * and moving an issue silently orphaned its Harbor task and created a duplicate
 * on the next webhook.
 *
 * The identifier still travels, in the task title, where a human wants it.
 */
export async function handleLinearWebhook(
	payload: unknown,
	ctx: ConnectorContext,
): Promise<WebhookResult> {
	const orgId = ctx.orgId;
	const parsed = parsePayload(payload);
	if (!parsed) return { action: "ignored", reason: "Only Linear Issue create and update events are synced." };
	const issue = parsed.data;
	const existing = await db.query.tasks.findFirst({
		where: and(
			eq(tasks.orgId, orgId),
			eq(tasks.source, "linear"),
			eq(tasks.sourceRef, issue.id),
		),
	});
	const completed = issue.state?.type === "completed" || issue.state?.type === "canceled";
	if (!existing) {
		const created = await createTask(orgId, {
			title: `${issue.identifier} ${issue.title}`,
			description: issue.description ?? undefined,
			source: "linear",
			sourceRef: issue.id,
		});
		if (completed) {
			await db.update(tasks).set({ status: "completed", updatedAt: new Date() }).where(eq(tasks.id, created.id));
		}
		return { action: "created", taskId: created.id };
	}

	// A live lease outranks upstream state: changing `claimed` here could make
	// another agent take work that is still actively held.
	await db
		.update(tasks)
		.set({
			title: `${issue.identifier} ${issue.title}`,
			description: issue.description ?? null,
			status: existing.status === "claimed" ? "claimed" : completed ? "completed" : "open",
			updatedAt: new Date(),
		})
		.where(eq(tasks.id, existing.id));
	return { action: "updated", taskId: existing.id };
}

/**
 * One place that talks to Linear, so the token handling and the error shape
 * cannot diverge between the two callers.
 *
 * The token is read from the connector row first and only falls back to the
 * environment variable, because an environment variable is per-deployment and a
 * connector row is per-organisation — a deployment serving two orgs would
 * otherwise comment on both of their issues with one org's credentials.
 */
async function linearGraphql(
	ctx: Pick<ConnectorContext, "config">,
	query: string,
	variables: Record<string, unknown>,
): Promise<void> {
	const token =
		(typeof ctx.config.accessToken === "string" ? ctx.config.accessToken : null)
		?? process.env.LINEAR_API_KEY;
	if (!token) {
		throw new Error(
			"No Linear credential: this connector row has no accessToken and LINEAR_API_KEY "
				+ "is unset. Re-run the Linear install, or set the variable.",
		);
	}

	const response = await fetch("https://api.linear.app/graphql", {
		method: "POST",
		headers: { Authorization: token, "Content-Type": "application/json" },
		body: JSON.stringify({ query, variables }),
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) throw new Error(`Linear call failed with HTTP ${response.status}.`);
	const result: unknown = await response.json();
	if (!isRecord(result) || "errors" in result) {
		throw new Error("Linear rejected the request.");
	}
}

const COMMENT_MUTATION =
	"mutation Comment($issueId: String!, $body: String!) "
	+ "{ commentCreate(input: { issueId: $issueId, body: $body }) { success } }";

export async function syncLinearOutbound(
	taskId: string,
	orgId: string,
	summary: string,
): Promise<void> {
	const task = await db.query.tasks.findFirst({
		where: and(eq(tasks.id, taskId), eq(tasks.orgId, orgId), eq(tasks.source, "linear")),
	});
	if (!task?.sourceRef) throw new Error("Linear task not found for outbound comment.");
	await linearGraphql({ config: {} }, COMMENT_MUTATION, {
		issueId: task.sourceRef,
		body: summary,
	});
}

/**
 * Progress back onto the issue.
 *
 * `threadRef` is the issue UUID — the same value `sourceRef` now holds, which is
 * the point of that fix. Failures are logged rather than thrown: Linear retries a
 * non-2xx webhook delivery, and a retry re-runs the inbound handler, so letting
 * an outbound comment failure escape would create a duplicate task every time
 * Linear had a bad minute.
 */
export async function postLinearActivity(
	ctx: ConnectorContext,
	activity: ConnectorActivity,
): Promise<void> {
	const marker = {
		started: "▶️",
		progress: "⚙️",
		needs_input: "🙋",
		finished: "✅",
		failed: "❌",
	}[activity.kind];

	try {
		await linearGraphql(ctx, COMMENT_MUTATION, {
			issueId: activity.threadRef,
			body: `${marker} ${activity.text}`,
		});
	} catch (error) {
		console.error("[linear] activity comment failed:", error);
	}
}

export const linearConnector: Connector = {
	type: "linear",
	verifyWebhook: verifyLinearWebhook,
	resolveAccount: resolveLinearAccount,
	handleWebhook: handleLinearWebhook,
	postActivity: postLinearActivity,
	linkArtifact: async (ctx, artifact) => {
		if (!artifact.url) return;
		try {
			await linearGraphql(ctx, COMMENT_MUTATION, {
				issueId: artifact.threadRef,
				body: `🔗 [${artifact.title}](${artifact.url})`,
			});
		} catch (error) {
			console.error("[linear] artifact comment failed:", error);
		}
	},
	syncOutbound: syncLinearOutbound,
	outboundWrites: [
		{
			action: "commentCreate",
			scope: "write (comments)",
			description:
				"Adds a comment to the issue a session came from. Harbor never changes issue "
				+ "state, assignee, labels or estimates — full two-way state sync is an explicit "
				+ "non-goal, because two state machines mean webhook ordering decides which "
				+ "system wins.",
			triggeredBy:
				"A session starting, reaching a progress inflection point, producing an "
				+ "artifact, or a task being completed with a summary.",
		},
	],
};
