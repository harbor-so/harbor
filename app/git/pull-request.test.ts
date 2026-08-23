// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The edge that was missing, tested end to end against real Postgres.
 *
 * The claim this suite has to earn is not "openPullRequestForBranch calls a
 * provider" — that is trivially true and would pass with the branch pinned to the
 * wrong lease, the PR opened as the bot, or a second pull request opened on every
 * turn. What it asserts is the set of properties the feature is *for*:
 *
 *  - the branch is pinned to the SESSION, so a second lease does not fork it;
 *  - the bot is never the author, on any path, including the ones that fail;
 *  - a session that pushes six times has one pull request, not six;
 *  - `absent` identity is terminal and `indeterminate` is retried, because
 *    collapsing them turns a ten-second outage into a permanent downgrade;
 *  - and the whole chain moves the headline metric, which is the only number
 *    anybody outside this file cares about.
 *
 * The provider is a fake, because the alternative is a test that opens real pull
 * requests. Everything below the provider — the pinning, the artifacts, the
 * lease lookup, the webhook join, the metric — is real code against real tables.
 */

import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, sql } from "@core/schema/index.js";
import { artifacts, orgs, repos, sessionRepos, sessions, users } from "@core/schema/schema.js";
import { markPullRequestMerged } from "../lib/artifacts.js";
import { createSession } from "../lib/sessions.js";
import { enqueueSessionPrompt } from "../lib/session-runner.js";
import { claim, createTask } from "@core/kernel/work.js";
import { harborBranchName } from "./provider.js";
import type { CreatePullRequestInput, PullRequestOutcome, ScmProvider } from "./provider.js";
import { openPullRequestForBranch, sweepDeferredPullRequests } from "./pull-request.js";
import { pinWorkingBranch, resolvePushBranch } from "./working-branch.js";
import * as githubModule from "./github.js";
import * as credentialsModule from "./credentials.js";

let orgId: string;
let userId: string;

/** Records what it was asked to open, and by whom. */
function fakeProvider(outcome?: (input: CreatePullRequestInput) => PullRequestOutcome) {
	const calls: CreatePullRequestInput[] = [];
	let counter = 0;

	const provider = {
		id: "github" as const,
		host: "github.com",
		async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestOutcome> {
			calls.push(input);
			counter += 1;
			return (
				outcome?.(input) ?? {
					kind: "created",
					url: `https://github.com/acme/api/pull/${counter}`,
					number: counter,
					author_login: input.expected_author_login,
					attribution: "prompting_user",
				}
			);
		},
		compareUrl: (_repo: unknown, base: string, head: string) =>
			`https://github.com/acme/api/compare/${base}...${head}`,
	} as unknown as ScmProvider;

	return { provider, calls };
}

function useProvider(provider: ScmProvider) {
	vi.spyOn(githubModule, "createScmProvider").mockReturnValue({ ok: true, provider });
}

/** A session with a task, a repo and one human prompt from a real user row. */
async function seededSession(options: { withUser?: boolean } = {}) {
	const withUser = options.withUser ?? true;
	const task = await createTask(orgId, { title: "Fix the retry cap" });
	const session = await createSession({
		orgId,
		title: "Fix the retry cap",
		createdBy: "rin",
		taskId: task.id,
	});
	const [repo] = await db
		.insert(repos)
		.values({ orgId, provider: "github", owner: "acme", name: "api", defaultBranch: "main" })
		.returning();
	await db.insert(sessionRepos).values({
		orgId,
		sessionId: session.id,
		repoId: repo!.id,
		position: 0,
		baseBranch: "main",
	});
	await enqueueSessionPrompt({
		orgId,
		sessionId: session.id,
		author: "rin",
		authorKind: "human",
		authorEmail: "rin@acme.test",
		authorUserId: withUser ? userId : null,
		body: "Start with a failing test that reproduces the drop.",
	});
	const claimed = await claim(orgId, task.id, "runner:tick", { intent: "Driving the session." });
	if (!claimed.ok) throw new Error("expected the claim to land");

	return { session, taskId: task.id, repoId: repo!.id, claimId: claimed.claimId };
}

beforeEach(async () => {
	vi.restoreAllMocks();
	await sql`truncate table cost_events, circuit_breakers, automation_runs, automations, artifacts, session_events, sandboxes, session_repos, secrets, user_scm_tokens, environment_repos, environments, repos, activity, session_prompts, session_participants, sessions, runs, agent_presence, events, claims, tasks, projects, api_keys, digests, connectors, users, orgs cascade`;
	const [org] = await db.insert(orgs).values({ name: "PR Org" }).returning();
	orgId = org!.id;
	const [user] = await db
		.insert(users)
		.values({ orgId, name: "rin", email: "rin@acme.test", githubId: "gh-rin" })
		.returning();
	userId = user!.id;
	process.env.HARBOR_PUBLIC_URL = "http://localhost:3000";
});

afterAll(async () => {
	await sql.end();
});

// ---------------------------------------------------------------------------
// The branch is pinned to the session, not to the lease
// ---------------------------------------------------------------------------

describe("the branch survives the lease being released", () => {
	it("derives from the active lease on the first turn", async () => {
		const seeded = await seededSession();
		const target = await resolvePushBranch(orgId, seeded.session.id);
		expect(target.branch).toBe(harborBranchName(seeded.claimId));
		expect(target.base).toBe("main");
	});

	it("reuses the pinned branch under a SECOND lease rather than forking a new one", async () => {
		// The trap this whole design exists to avoid. `completeTurn` releases the
		// lease whenever the queue drains, so an hour-later follow-up runs under a
		// different claim id. Re-deriving would cut a second branch from base
		// carrying none of the first turn's commits.
		const seeded = await seededSession();
		const first = await resolvePushBranch(orgId, seeded.session.id);
		await pinWorkingBranch({
			sessionId: seeded.session.id,
			repoId: seeded.repoId,
			branch: first.branch!,
		});

		await sql`update claims set released_at = now() where org_id = ${orgId}`;
		const second = await claim(orgId, seeded.taskId, "runner:tick", { intent: "The follow-up." });
		if (!second.ok) throw new Error("expected a second claim");
		expect(second.claimId).not.toBe(seeded.claimId);

		const after = await resolvePushBranch(orgId, seeded.session.id);
		expect(after.branch).toBe(first.branch);
		expect(after.branch).not.toBe(harborBranchName(second.claimId));
	});

	it("pins once — a concurrent second push reads back the winner's branch", async () => {
		const seeded = await seededSession();
		const [a, b] = await Promise.all([
			pinWorkingBranch({ sessionId: seeded.session.id, repoId: seeded.repoId, branch: "harbor/lse_aaaa1111" }),
			pinWorkingBranch({ sessionId: seeded.session.id, repoId: seeded.repoId, branch: "harbor/lse_bbbb2222" }),
		]);
		// Whoever lost gets the winner's name back, so both callers open a pull
		// request for the same branch rather than for the one they proposed.
		expect(a).toBe(b);
	});

	it("offers no branch when the session has no lease to name one after", async () => {
		const session = await createSession({ orgId, title: "Scratch", createdBy: "rin" });
		const [repo] = await db
			.insert(repos)
			.values({ orgId, provider: "github", owner: "acme", name: "web" })
			.returning();
		await db
			.insert(sessionRepos)
			.values({ orgId, sessionId: session.id, repoId: repo!.id, position: 0, baseBranch: "main" });

		const target = await resolvePushBranch(orgId, session.id);
		expect(target.branch).toBeNull();
		expect(target.reason).toBe("no_lease");
	});
});

// ---------------------------------------------------------------------------
// Opening it
// ---------------------------------------------------------------------------

describe("openPullRequestForBranch", () => {
	it("opens with the prompting human's token and records the artifact the metric reads", async () => {
		const seeded = await seededSession();
		const fake = fakeProvider();
		useProvider(fake.provider);
		vi.spyOn(credentialsModule, "prAuthorityForUser").mockResolvedValue({
			kind: "user",
			token: "gho_the_humans_token",
			login: "rin",
		});

		const branch = harborBranchName(seeded.claimId);
		const outcome = await openPullRequestForBranch({
			orgId,
			sessionId: seeded.session.id,
			repoId: seeded.repoId,
			branch,
			base: "main",
		});

		expect(outcome.kind).toBe("opened");
		// The token is the human's, and the expected author is checked against what
		// the API returns — the bot is not an option on this path.
		expect(fake.calls[0]!.author_token).toBe("gho_the_humans_token");
		expect(fake.calls[0]!.expected_author_login).toBe("rin");
		expect(fake.calls[0]!.head).toBe(branch);
		expect(fake.calls[0]!.base).toBe("main");

		const [row] = await db
			.select()
			.from(artifacts)
			.where(and(eq(artifacts.sessionId, seeded.session.id), eq(artifacts.kind, "pull_request")));
		expect(row!.url).toBe("https://github.com/acme/api/pull/1");
		expect((row!.payload as { branch: string }).branch).toBe(branch);
	});

	it("carries the lease's intent into the pull request body, verbatim", async () => {
		// The reason the branch names a claim at all: six months later, "why does
		// this change exist" is answerable from the PR without reading a transcript.
		const seeded = await seededSession();
		const fake = fakeProvider();
		useProvider(fake.provider);
		vi.spyOn(credentialsModule, "prAuthorityForUser").mockResolvedValue({
			kind: "user",
			token: "gho_x",
			login: "rin",
		});

		await openPullRequestForBranch({
			orgId,
			sessionId: seeded.session.id,
			repoId: seeded.repoId,
			branch: harborBranchName(seeded.claimId),
			base: "main",
		});

		expect(fake.calls[0]!.body).toContain("Driving the session.");
		expect(fake.calls[0]!.body).toContain(seeded.claimId);
	});

	it("opens ONE pull request no matter how many times the branch is pushed", async () => {
		const seeded = await seededSession();
		const fake = fakeProvider();
		useProvider(fake.provider);
		vi.spyOn(credentialsModule, "prAuthorityForUser").mockResolvedValue({
			kind: "user",
			token: "gho_x",
			login: "rin",
		});

		const branch = harborBranchName(seeded.claimId);
		const args = { orgId, sessionId: seeded.session.id, repoId: seeded.repoId, branch, base: "main" };

		const first = await openPullRequestForBranch(args);
		const second = await openPullRequestForBranch(args);
		const third = await openPullRequestForBranch(args);

		expect(first.kind).toBe("opened");
		expect(second.kind).toBe("noop");
		expect(third.kind).toBe("noop");
		expect(fake.calls).toHaveLength(1);

		const rows = await db
			.select()
			.from(artifacts)
			.where(and(eq(artifacts.sessionId, seeded.session.id), eq(artifacts.kind, "pull_request")));
		expect(rows).toHaveLength(1);
	});

	it("degrades loudly and does NOT open as the bot when the human has no identity", async () => {
		const seeded = await seededSession();
		const fake = fakeProvider();
		useProvider(fake.provider);
		vi.spyOn(credentialsModule, "prAuthorityForUser").mockResolvedValue({
			kind: "absent",
			reason: "no_scm_identity",
			detail: "signed in through SSO, never connected GitHub",
		});

		const outcome = await openPullRequestForBranch({
			orgId,
			sessionId: seeded.session.id,
			repoId: seeded.repoId,
			branch: harborBranchName(seeded.claimId),
			base: "main",
		});

		expect(outcome.kind).toBe("degraded");
		// The critical assertion: nothing was opened at all. A bot-authored PR would
		// let the requester approve their own agent's work.
		expect(fake.calls).toHaveLength(0);
		if (outcome.kind !== "degraded") throw new Error("unreachable");
		expect(outcome.warning).toContain("compare");
		expect(
			await db
				.select()
				.from(artifacts)
				.where(and(eq(artifacts.sessionId, seeded.session.id), eq(artifacts.kind, "pull_request"))),
		).toHaveLength(0);
	});

	it("degrades rather than guessing when no prompt has a user behind it", async () => {
		// An automation-created session. It must push and hand back a compare URL,
		// not open a pull request in the name of whoever happens to be nearby.
		const seeded = await seededSession({ withUser: false });
		const fake = fakeProvider();
		useProvider(fake.provider);
		const authority = vi.spyOn(credentialsModule, "prAuthorityForUser");

		const outcome = await openPullRequestForBranch({
			orgId,
			sessionId: seeded.session.id,
			repoId: seeded.repoId,
			branch: harborBranchName(seeded.claimId),
			base: "main",
		});

		expect(outcome.kind).toBe("degraded");
		expect(fake.calls).toHaveLength(0);
		// Not even looked up: there is no user id to look up.
		expect(authority).not.toHaveBeenCalled();
	});

	it("defers — retryable, no denial recorded — when the host cannot be reached", async () => {
		const seeded = await seededSession();
		const fake = fakeProvider();
		useProvider(fake.provider);
		vi.spyOn(credentialsModule, "prAuthorityForUser").mockResolvedValue({
			kind: "indeterminate",
			reason: "refresh_upstream_unavailable",
			detail: "github.com timed out",
		});

		const outcome = await openPullRequestForBranch({
			orgId,
			sessionId: seeded.session.id,
			repoId: seeded.repoId,
			branch: harborBranchName(seeded.claimId),
			base: "main",
		});

		// Deferred, NOT degraded. Collapsing these is what turns a blip into a
		// permanent loss of attribution for whichever PRs were open at the time.
		expect(outcome.kind).toBe("deferred");
		expect(fake.calls).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// The retry
// ---------------------------------------------------------------------------

describe("sweepDeferredPullRequests", () => {
	async function pushedButNotOpened() {
		const seeded = await seededSession();
		const branch = harborBranchName(seeded.claimId);
		await db.insert(artifacts).values({
			orgId,
			sessionId: seeded.session.id,
			repoId: seeded.repoId,
			kind: "branch",
			title: branch,
			payload: { branch, base: "main" },
		});
		return { ...seeded, branch };
	}

	it("opens the pull request on a later tick once the host answers again", async () => {
		const pushed = await pushedButNotOpened();
		const fake = fakeProvider();
		useProvider(fake.provider);

		const authority = vi
			.spyOn(credentialsModule, "prAuthorityForUser")
			.mockResolvedValueOnce({
				kind: "indeterminate",
				reason: "refresh_upstream_timeout",
				detail: "timed out",
			})
			.mockResolvedValue({ kind: "user", token: "gho_x", login: "rin" });

		const first = await sweepDeferredPullRequests();
		expect(first.opened).toBe(0);

		const second = await sweepDeferredPullRequests();
		expect(second.opened).toBe(1);
		expect(authority).toHaveBeenCalledTimes(2);

		const rows = await db
			.select()
			.from(artifacts)
			.where(and(eq(artifacts.sessionId, pushed.session.id), eq(artifacts.kind, "pull_request")));
		expect(rows).toHaveLength(1);
	});

	it("stops retrying an identity that is genuinely absent", async () => {
		// A refusal is a fact about the deployment, not a transient failure. Retrying
		// it forever costs an OAuth lookup per tick, per session, indefinitely.
		await pushedButNotOpened();
		useProvider(fakeProvider().provider);
		const authority = vi.spyOn(credentialsModule, "prAuthorityForUser").mockResolvedValue({
			kind: "absent",
			reason: "no_scm_identity",
			detail: "no account connected",
		});

		await sweepDeferredPullRequests();
		expect(authority).toHaveBeenCalledTimes(1);

		const second = await sweepDeferredPullRequests();
		expect(second.attempted).toBe(0);
		expect(authority).toHaveBeenCalledTimes(1);
	});

	it("does not re-open a pull request that already exists", async () => {
		const pushed = await pushedButNotOpened();
		const fake = fakeProvider();
		useProvider(fake.provider);
		vi.spyOn(credentialsModule, "prAuthorityForUser").mockResolvedValue({
			kind: "user",
			token: "gho_x",
			login: "rin",
		});

		await openPullRequestForBranch({
			orgId,
			sessionId: pushed.session.id,
			repoId: pushed.repoId,
			branch: pushed.branch,
			base: "main",
		});
		const sweep = await sweepDeferredPullRequests();

		expect(sweep.attempted).toBe(0);
		expect(fake.calls).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// The metric, end to end
// ---------------------------------------------------------------------------

describe("the headline metric", () => {
	it("moves off zero once a pushed branch becomes a merged pull request", async () => {
		// This is the whole point of the change. Before it, `markPullRequestMerged`
		// could never match a row, because no `pull_request` artifact was ever
		// inserted — so the number read 0/n on every deployment regardless of how
		// well the agents did.
		const seeded = await seededSession();
		const fake = fakeProvider();
		useProvider(fake.provider);
		vi.spyOn(credentialsModule, "prAuthorityForUser").mockResolvedValue({
			kind: "user",
			token: "gho_x",
			login: "rin",
		});

		const opened = await openPullRequestForBranch({
			orgId,
			sessionId: seeded.session.id,
			repoId: seeded.repoId,
			branch: harborBranchName(seeded.claimId),
			base: "main",
		});
		if (opened.kind !== "opened") throw new Error("expected it to open");

		// The webhook's join key is the URL Harbor stored when it opened the PR.
		const stamped = await markPullRequestMerged({
			orgId,
			url: opened.url,
			mergedAt: new Date("2026-08-13T13:48:02Z"),
		});
		expect(stamped).toBe(1);

		const [row] = await db
			.select()
			.from(artifacts)
			.where(and(eq(artifacts.sessionId, seeded.session.id), eq(artifacts.kind, "pull_request")));
		expect(row!.mergedAt).not.toBeNull();

		// And a redelivered webhook — which GitHub does routinely — does not move it.
		const again = await markPullRequestMerged({
			orgId,
			url: opened.url,
			mergedAt: new Date("2026-08-14T09:00:00Z"),
		});
		expect(again).toBe(0);
	});
});
