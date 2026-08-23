// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Connector tests use the real database because idempotency depends on the
 * same partial unique index that protects production from webhook retries.
 */

import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, sql } from "@core/schema/index.js";
import { artifacts, orgs, tasks } from "@core/schema/schema.js";
import { createSession } from "../lib/sessions.js";
import { claim } from "@core/kernel/work.js";
import {
	handleGitHubWebhook,
	verifyGitHubWebhook,
} from "./github.js";
import {
	handleGitLabWebhook,
	resolveGitLabAccount,
	verifyGitLabWebhook,
} from "./gitlab.js";
import {
	handleLinearWebhook,
	verifyLinearWebhook,
} from "./linear.js";
import type { ConnectorContext } from "./types.js";

let orgId: string;

/**
 * The context a handler now receives instead of a bare org id.
 *
 * Built here rather than inline at each call site so that adding a field to
 * `ConnectorContext` is one edit in the tests rather than seven — the same
 * reason the production signature stopped being positional parameters.
 */
const ctx = (config: Record<string, unknown> = {}): ConnectorContext => ({
	orgId,
	connectorId: "00000000-0000-0000-0000-000000000000",
	externalAccountId: "test-account",
	config,
	traceId: "test-trace",
});

beforeEach(async () => {
	await sql`truncate table cost_events, circuit_breakers, automation_runs, automations, artifacts, session_events, sandboxes, session_repos, secrets, user_scm_tokens, environment_repos, environments, repos, activity, session_prompts, session_participants, sessions, runs, agent_presence, events, claims, tasks, projects, api_keys, digests, connectors, users, orgs cascade`;
	const [org] = await db.insert(orgs).values({ name: "Connector Test Org" }).returning();
	if (!org) throw new Error("Test org was not created.");
	orgId = org.id;
});

afterAll(async () => {
	await sql.end();
});

describe("webhook signatures", () => {
	const body = JSON.stringify({ action: "opened" });
	const secret = "webhook-secret";

	it("verifies GitHub signatures and rejects invalid inputs", () => {
		const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
		expect(verifyGitHubWebhook(body, { "x-hub-signature-256": signature }, secret)).toBe(true);
		expect(verifyGitHubWebhook(`${body} `, { "x-hub-signature-256": signature }, secret)).toBe(false);
		expect(verifyGitHubWebhook(body, { "x-hub-signature-256": signature }, "wrong")).toBe(false);
		expect(verifyGitHubWebhook(body, {}, secret)).toBe(false);
		expect(verifyGitHubWebhook(body, { "x-hub-signature-256": "sha256=nope" }, secret)).toBe(false);
	});

	it("verifies Linear signatures and rejects invalid inputs", () => {
		const signature = createHmac("sha256", secret).update(body).digest("hex");
		expect(verifyLinearWebhook(body, { "linear-signature": signature }, secret)).toBe(true);
		expect(verifyLinearWebhook(`${body} `, { "linear-signature": signature }, secret)).toBe(false);
		expect(verifyLinearWebhook(body, { "linear-signature": signature }, "wrong")).toBe(false);
		expect(verifyLinearWebhook(body, {}, secret)).toBe(false);
		expect(verifyLinearWebhook(body, { "linear-signature": "not-hex" }, secret)).toBe(false);
	});

	it("verifies GitLab tokens constant-time and rejects a wrong or missing one", () => {
		// GitLab sends the literal token, not an HMAC — the body is irrelevant.
		expect(verifyGitLabWebhook(body, { "x-gitlab-token": secret }, secret)).toBe(true);
		expect(verifyGitLabWebhook(body, { "x-gitlab-token": "wrong" }, secret)).toBe(false);
		expect(verifyGitLabWebhook(body, {}, secret)).toBe(false);
		expect(verifyGitLabWebhook(body, { "x-gitlab-token": "" }, secret)).toBe(false);
	});
});

describe("GitHub webhooks", () => {
	const opened = {
		action: "opened",
		issue: { number: 42, title: "Fix retry storm", body: "Bound webhook retries." },
	};

	it("creates one sourced task when an issue is opened", async () => {
		const result = await handleGitHubWebhook(opened, ctx());
		expect(result.action).toBe("created");
		const rows = await db.query.tasks.findMany({ where: eq(tasks.orgId, orgId) });
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			title: "Fix retry storm",
			source: "github",
			sourceRef: "42",
		});
	});

	it("updates rather than duplicates a redelivered issue", async () => {
		await handleGitHubWebhook(opened, ctx());
		const second = await handleGitHubWebhook(opened, ctx());
		expect(second.action).toBe("updated");
		expect(await db.query.tasks.findMany({ where: eq(tasks.orgId, orgId) })).toHaveLength(1);
	});

	it("marks a closed issue completed", async () => {
		await handleGitHubWebhook(opened, ctx());
		await handleGitHubWebhook({ ...opened, action: "closed" }, ctx());
		const [task] = await db.query.tasks.findMany({ where: eq(tasks.orgId, orgId) });
		expect(task?.status).toBe("completed");
	});
});

/**
 * The merged-PR metric's only writer.
 *
 * `/usage` reports *sessions that resulted in a merged pull request* — the metric
 * the README leads with. It was computed from
 * `kind = 'pull_request'`, which counts pull requests **opened**, so an agent that
 * opened forty nobody merged scored forty. `merged_at` is what makes the number
 * mean what the label says, and this webhook is the only thing that writes it.
 */
describe("pull request merges", () => {
	const PR_URL = "https://github.com/acme/web/pull/7";

	async function seedPullRequestArtifact(url = PR_URL) {
		const session = await createSession({ orgId, title: "Raise the retry cap", createdBy: "rin" });
		const [row] = await db
			.insert(artifacts)
			.values({
				orgId,
				sessionId: session.id,
				kind: "pull_request",
				title: "Raise the retry cap to five",
				url,
			})
			.returning();
		return row!;
	}

	/** A merge, in the shape GitHub actually sends it: `closed` plus `merged: true`. */
	const mergedPayload = (overrides: Record<string, unknown> = {}) => ({
		action: "closed",
		pull_request: {
			number: 7,
			title: "Raise the retry cap to five",
			merged: true,
			merged_at: "2026-08-12T10:00:00.000Z",
			html_url: PR_URL,
			...overrides,
		},
	});

	it("stamps merged_at when a pull request Harbor opened is merged", async () => {
		const artifact = await seedPullRequestArtifact();

		await handleGitHubWebhook(mergedPayload(), ctx());

		const [row] = await db.query.artifacts.findMany({ where: eq(artifacts.id, artifact.id) });
		expect(row!.mergedAt).toEqual(new Date("2026-08-12T10:00:00.000Z"));
	});

	it("does NOT stamp a pull request that was closed without merging", async () => {
		const artifact = await seedPullRequestArtifact();

		// GitHub sends the same `action: "closed"` either way; only `merged`
		// distinguishes them. Treating the action alone as a merge would count every
		// abandoned pull request as a delivered one.
		await handleGitHubWebhook(mergedPayload({ merged: false, merged_at: undefined }), ctx());

		const [row] = await db.query.artifacts.findMany({ where: eq(artifacts.id, artifact.id) });
		expect(row!.mergedAt).toBeNull();
	});

	it("keeps the first merge time when the webhook is redelivered", async () => {
		const artifact = await seedPullRequestArtifact();

		await handleGitHubWebhook(mergedPayload(), ctx());
		await handleGitHubWebhook(mergedPayload({ merged_at: "2026-08-12T18:00:00.000Z" }), ctx());

		// GitHub redelivers routinely. The second value would move the row out of
		// whatever reporting window somebody was looking at, for a merge that
		// happened once.
		const [row] = await db.query.artifacts.findMany({ where: eq(artifacts.id, artifact.id) });
		expect(row!.mergedAt).toEqual(new Date("2026-08-12T10:00:00.000Z"));
	});

	it("ignores a merge of a pull request Harbor did not open", async () => {
		await seedPullRequestArtifact("https://github.com/acme/web/pull/999");

		// The common case on any repository where humans also work. Not an error,
		// and it must not stamp somebody else's row.
		await handleGitHubWebhook(mergedPayload(), ctx());

		const rows = await db.query.artifacts.findMany({ where: eq(artifacts.orgId, orgId) });
		expect(rows.every((row) => row.mergedAt === null)).toBe(true);
	});

	it("does not stamp an artifact belonging to another org", async () => {
		const [other] = await db.insert(orgs).values({ name: "Other Org" }).returning();
		const session = await createSession({
			orgId: other!.id,
			title: "Their work",
			createdBy: "maya",
		});
		const [theirs] = await db
			.insert(artifacts)
			.values({
				orgId: other!.id,
				sessionId: session.id,
				kind: "pull_request",
				title: "Their PR",
				url: PR_URL,
			})
			.returning();

		await handleGitHubWebhook(mergedPayload(), ctx());

		// The org is established by webhook verification. A connector one org
		// configured must not reach across into another's rows, even on a URL that
		// is globally unique.
		const [row] = await db.query.artifacts.findMany({ where: eq(artifacts.id, theirs!.id) });
		expect(row!.mergedAt).toBeNull();
	});

	it("leaves a non-pull-request artifact on the same URL alone", async () => {
		const session = await createSession({ orgId, title: "Session", createdBy: "rin" });
		const [log] = await db
			.insert(artifacts)
			.values({ orgId, sessionId: session.id, kind: "log", title: "build log", url: PR_URL })
			.returning();

		await handleGitHubWebhook(mergedPayload(), ctx());

		const [row] = await db.query.artifacts.findMany({ where: eq(artifacts.id, log!.id) });
		expect(row!.mergedAt).toBeNull();
	});
});

describe("GitLab webhooks", () => {
	const opened = {
		object_kind: "issue",
		project: { id: 7, namespace: "acme", path_with_namespace: "acme/web" },
		object_attributes: { id: 900, iid: 42, title: "Fix retry storm", description: "Bound it.", action: "open", state: "opened" },
	};

	it("resolves the group namespace as the tenant, from the payload", () => {
		expect(resolveGitLabAccount(opened)).toBe("acme");
	});

	it("creates one task keyed on the global id (so two projects' #42 do not collide)", async () => {
		const result = await handleGitLabWebhook(opened, ctx());
		expect(result.action).toBe("created");
		const rows = await db.query.tasks.findMany({ where: eq(tasks.orgId, orgId) });
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ title: "Fix retry storm", source: "gitlab", sourceRef: "900" });
	});

	it("updates rather than duplicates a redelivered issue", async () => {
		await handleGitLabWebhook(opened, ctx());
		const second = await handleGitLabWebhook(opened, ctx());
		expect(second.action).toBe("updated");
		expect(await db.query.tasks.findMany({ where: eq(tasks.orgId, orgId) })).toHaveLength(1);
	});

	it("marks a merged merge request completed", async () => {
		const mr = {
			object_kind: "merge_request",
			project: { id: 7, namespace: "acme" },
			object_attributes: { id: 901, iid: 5, title: "Ship it", action: "merge", state: "merged" },
		};
		await handleGitLabWebhook(mr, ctx());
		const [task] = await db.query.tasks.findMany({ where: eq(tasks.orgId, orgId) });
		expect(task?.status).toBe("completed");
	});
});

describe("Linear webhooks", () => {
	it("does not change the status of a task that is claimed", async () => {
		const base = {
			type: "Issue",
			action: "create",
			data: {
				id: "linear-uuid",
				identifier: "ACM-482",
				title: "Keep the lease",
				state: { type: "started" },
			},
		};
		const created = await handleLinearWebhook(base, ctx());
		if (!created.taskId) throw new Error("Linear task was not created.");
		await claim(orgId, created.taskId, "codex:connector-test", {
			intent: "Working this synced Linear issue already.",
		});

		await handleLinearWebhook({
			...base,
			action: "update",
			data: { ...base.data, state: { type: "completed" } },
		}, ctx());
		const task = await db.query.tasks.findFirst({ where: eq(tasks.id, created.taskId) });
		expect(task?.status).toBe("claimed");
	});
});
