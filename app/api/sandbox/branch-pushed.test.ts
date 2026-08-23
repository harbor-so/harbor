// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * `branch_pushed`, driven through the real ingest route.
 *
 * The event type has existed in `SANDBOX_EVENT_TYPES` since the contracts were
 * written, and the route has always mapped it to an `artifact_created` timeline
 * row — and then stopped. Nothing pinned the branch, nothing inserted an
 * artifact, and nothing called `openPullRequest`, so the entire pull-request half
 * of the product was unreachable and the headline metric read `0/n` for reasons
 * unrelated to how well any agent performed.
 *
 * These tests drive the route rather than the helper, because the properties that
 * matter are properties of the *edge*: that a superseded box cannot report a
 * push at all, that the branch is pinned exactly once, and that a repeated push
 * does not produce a second pull request.
 */

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as postSandboxEvents } from "./[id]/events/route.js";
import { db, sql } from "@core/schema/index.js";
import {
	artifacts,
	orgs,
	repos,
	sandboxes,
	sessionEvents,
	sessionRepos,
	sessions,
	users,
} from "@core/schema/schema.js";
import { createSession } from "../../lib/sessions.js";
import { enqueueSessionPrompt } from "../../lib/session-runner.js";
import { claim, createTask } from "@core/kernel/work.js";
import { harborBranchName } from "../../git/provider.js";
import type { CreatePullRequestInput, PullRequestOutcome, ScmProvider } from "../../git/provider.js";
import * as githubModule from "../../git/github.js";
import * as credentialsModule from "../../git/credentials.js";

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

let orgId: string;
let sessionId: string;
let repoId: string;
let claimId: string;
let prCalls: CreatePullRequestInput[];

async function makeSandbox(token: string) {
	const [box] = await db
		.insert(sandboxes)
		.values({
			orgId,
			sessionId,
			provider: "test",
			status: "ready",
			externalId: `ext-${Math.random().toString(16).slice(2)}`,
			authTokenHash: sha256Hex(token),
		})
		.returning();
	return box!;
}

const post = (box: { id: string }, events: unknown[], fence = "1") =>
	postSandboxEvents(
		new Request(`http://harbor.test/api/sandbox/${box.id}/events`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer tok-push",
				"x-harbor-fencing-token": fence,
			},
			body: JSON.stringify({ events }),
		}),
		{ params: Promise.resolve({ id: box.id }) },
	);

const pushEvent = (branch: string, extra: Record<string, unknown> = {}) => ({
	type: "branch_pushed",
	sandbox_id: "ignored",
	session_id: sessionId,
	payload: { branch, commit_sha: "3ac91d", commits: 2, ...extra },
});

beforeEach(async () => {
	vi.restoreAllMocks();
	prCalls = [];
	await sql`truncate table cost_events, circuit_breakers, automation_runs, automations, artifacts, session_events, sandboxes, session_repos, secrets, user_scm_tokens, environment_repos, environments, repos, activity, session_prompts, session_participants, sessions, runs, agent_presence, events, claims, tasks, projects, api_keys, digests, connectors, users, orgs cascade`;

	const [org] = await db.insert(orgs).values({ name: "Push Org" }).returning();
	orgId = org!.id;
	const [user] = await db
		.insert(users)
		.values({ orgId, name: "rin", email: "rin@acme.test", githubId: "gh-rin" })
		.returning();

	const task = await createTask(orgId, { title: "Push me" });
	const session = await createSession({ orgId, title: "Push me", createdBy: "rin", taskId: task.id });
	sessionId = session.id;

	const [repo] = await db
		.insert(repos)
		.values({ orgId, provider: "github", owner: "acme", name: "api", defaultBranch: "main" })
		.returning();
	repoId = repo!.id;
	await db
		.insert(sessionRepos)
		.values({ orgId, sessionId, repoId, position: 0, baseBranch: "main" });

	await enqueueSessionPrompt({
		orgId,
		sessionId,
		author: "rin",
		authorKind: "human",
		authorEmail: "rin@acme.test",
		authorUserId: user!.id,
		body: "Fix the retry cap.",
	});

	const claimed = await claim(orgId, task.id, "runner:tick", { intent: "Driving the session." });
	if (!claimed.ok) throw new Error("expected the claim to land");
	claimId = claimed.claimId;

	const provider = {
		id: "github" as const,
		host: "github.com",
		async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestOutcome> {
			prCalls.push(input);
			return {
				kind: "created",
				url: `https://github.com/acme/api/pull/${prCalls.length}`,
				number: prCalls.length,
				author_login: input.expected_author_login,
				attribution: "prompting_user",
			};
		},
		compareUrl: (_r: unknown, base: string, head: string) =>
			`https://github.com/acme/api/compare/${base}...${head}`,
	} as unknown as ScmProvider;
	vi.spyOn(githubModule, "createScmProvider").mockReturnValue({ ok: true, provider });
	vi.spyOn(credentialsModule, "prAuthorityForUser").mockResolvedValue({
		kind: "user",
		token: "gho_the_humans_token",
		login: "rin",
	});
});

afterAll(async () => {
	await sql.end();
});

const artifactsOf = (kind: string) =>
	db
		.select()
		.from(artifacts)
		.where(and(eq(artifacts.sessionId, sessionId), eq(artifacts.kind, kind)));

describe("a reported push", () => {
	it("pins the branch, records it, and opens the pull request", async () => {
		const box = await makeSandbox("tok-push");
		const branch = harborBranchName(claimId);

		const response = await post(box, [pushEvent(branch)]);
		expect(response.status).toBe(200);

		const [repoRow] = await db
			.select({ workingBranch: sessionRepos.workingBranch })
			.from(sessionRepos)
			.where(eq(sessionRepos.sessionId, sessionId));
		expect(repoRow!.workingBranch).toBe(branch);

		expect(await artifactsOf("branch")).toHaveLength(1);
		const pulls = await artifactsOf("pull_request");
		expect(pulls).toHaveLength(1);
		expect(pulls[0]!.url).toBe("https://github.com/acme/api/pull/1");
		expect(prCalls[0]!.author_token).toBe("gho_the_humans_token");
	});

	it("puts the pull request on the timeline so the room shows the link", async () => {
		const box = await makeSandbox("tok-push");
		await post(box, [pushEvent(harborBranchName(claimId))]);

		const timeline = await db
			.select()
			.from(sessionEvents)
			.where(and(eq(sessionEvents.sessionId, sessionId), eq(sessionEvents.type, "artifact_created")));
		const payloads = timeline.map((row) => row.payload as Record<string, unknown>);
		expect(payloads.some((p) => p.artifact === "pull_request" && typeof p.url === "string")).toBe(true);
	});

	it("opens ONE pull request across repeated pushes to the same branch", async () => {
		// The ordinary multi-turn session. GitHub updates the open PR from the branch;
		// Harbor must not open a second one, and must not double-count the metric.
		const box = await makeSandbox("tok-push");
		const branch = harborBranchName(claimId);

		await post(box, [pushEvent(branch)]);
		await post(box, [pushEvent(branch, { commits: 5 })]);
		await post(box, [pushEvent(branch, { commits: 9 })]);

		expect(await artifactsOf("pull_request")).toHaveLength(1);
		expect(await artifactsOf("branch")).toHaveLength(1);
		expect(prCalls).toHaveLength(1);
	});

	it("refuses a branch the box was never told to push", async () => {
		// The box is told where to push on the prompt command; what it reports is an
		// acknowledgement, not an instruction. A compromised bridge reporting `main`
		// would otherwise pin `main` as the session's working branch — and every
		// later boot would check it out and every later push would target it. The
		// credential broker cannot catch this: pushing to `main` is inside the scope
		// of a legitimately minted write token.
		const box = await makeSandbox("tok-push");
		const response = await post(box, [pushEvent("main")]);

		expect(response.status).toBe(200);
		const [repoRow] = await db
			.select({ workingBranch: sessionRepos.workingBranch })
			.from(sessionRepos)
			.where(eq(sessionRepos.sessionId, sessionId));
		expect(repoRow!.workingBranch).toBeNull();
		expect(await artifactsOf("branch")).toHaveLength(0);
		expect(await artifactsOf("pull_request")).toHaveLength(0);
		expect(prCalls).toHaveLength(0);
	});

	it("refuses a second push that names a different branch than the pinned one", async () => {
		const box = await makeSandbox("tok-push");
		const branch = harborBranchName(claimId);
		await post(box, [pushEvent(branch)]);
		await post(box, [pushEvent("harbor/lse_deadbeef")]);

		const [repoRow] = await db
			.select({ workingBranch: sessionRepos.workingBranch })
			.from(sessionRepos)
			.where(eq(sessionRepos.sessionId, sessionId));
		expect(repoRow!.workingBranch).toBe(branch);
		expect(await artifactsOf("branch")).toHaveLength(1);
		expect(prCalls).toHaveLength(1);
	});

	it("takes the repository from the session, never from the payload", async () => {
		// A box that could name its own repo could have Harbor open a pull request
		// against any repository the installation can reach.
		const [other] = await db
			.insert(repos)
			.values({ orgId, provider: "github", owner: "someone-else", name: "private" })
			.returning();
		const box = await makeSandbox("tok-push");

		await post(box, [
			pushEvent(harborBranchName(claimId), { repo_id: other!.id, repo: "someone-else/private" }),
		]);

		const [pull] = await artifactsOf("pull_request");
		expect(pull!.repoId).toBe(repoId);
		expect(prCalls[0]!.repo.owner).toBe("acme");
	});

	it("records the agent's uncommitted leftovers rather than committing them", async () => {
		const box = await makeSandbox("tok-push");
		await post(box, [pushEvent(harborBranchName(claimId), { uncommitted_changes: true })]);

		const [branchArtifact] = await artifactsOf("branch");
		expect((branchArtifact!.payload as { uncommitted_changes: boolean }).uncommitted_changes).toBe(true);
	});

	it("ignores a push that names no branch instead of inventing one", async () => {
		const box = await makeSandbox("tok-push");
		const response = await post(box, [
			{ type: "branch_pushed", sandbox_id: "x", session_id: sessionId, payload: { commits: 1 } },
		]);

		expect(response.status).toBe(200);
		expect(await artifactsOf("branch")).toHaveLength(0);
		expect(await artifactsOf("pull_request")).toHaveLength(0);
	});
});

describe("the fence", () => {
	it("refuses a push from a box whose lease has been superseded", async () => {
		// The guarantee stated in `SpawnIntent`'s contract note: a box whose token is
		// stale "cannot push a branch, open a PR or write to the transcript, even if
		// it is still running and still believes it holds the work".
		const box = await makeSandbox("tok-push");
		const response = await post(box, [pushEvent(harborBranchName(claimId))], "0");

		expect(response.status).toBe(409);
		expect(await artifactsOf("branch")).toHaveLength(0);
		expect(await artifactsOf("pull_request")).toHaveLength(0);
		expect(prCalls).toHaveLength(0);

		const [repoRow] = await db
			.select({ workingBranch: sessionRepos.workingBranch })
			.from(sessionRepos)
			.where(eq(sessionRepos.sessionId, sessionId));
		expect(repoRow!.workingBranch).toBeNull();
	});
});

describe("the resume token", () => {
	const finished = (resumeToken: unknown) => ({
		type: "agent_finished",
		sandbox_id: "x",
		session_id: sessionId,
		payload: {
			resume_token: resumeToken,
			usage: { source: "unavailable", input_tokens: 0, output_tokens: 0, model: null },
		},
	});

	it("is persisted from a finished turn so a replacement box can continue", async () => {
		const box = await makeSandbox("tok-push");
		await post(box, [finished("sess_a91")]);

		const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
		expect(row!.agentResumeToken).toBe("sess_a91");
		// Stored with the runtime that minted it, so it is never handed to a
		// different agent after somebody changes the session's runtime.
		expect(row!.agentResumeRuntime).toBe(row!.runtime);
	});

	it("is not overwritten with null by a turn that reported no id", async () => {
		// An adapter that announces its session id only on the first line legitimately
		// reports nothing on a later turn. Clearing the column there would lose the
		// conversation at the next reboot.
		const box = await makeSandbox("tok-push");
		await post(box, [finished("sess_a91")]);
		await post(box, [finished(null)]);
		await post(box, [finished("")]);

		const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
		expect(row!.agentResumeToken).toBe("sess_a91");
	});
});
