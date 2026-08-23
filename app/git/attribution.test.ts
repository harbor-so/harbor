// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Attribution: the property the product is actually selling.
 *
 * The claim is that a human cannot approve their own agent's changes, and it
 * rests on **two independent facts** that come from two unrelated places:
 *
 *   1. The pull request's author comes from the **token** used to create it.
 *   2. The commit's author and committer come from **git commit metadata**, which
 *      has nothing to do with the credential used to push.
 *
 * Every assertion below tests exactly one of those. That is not stylistic
 * fussiness: a test that checks "the human's name appears somewhere" passes when
 * the commit is correct and the PR is bot-authored, which is precisely the bug
 * this file exists to catch, and it is the bug the naive implementation ships
 * with. So the token is varied while the commit identity is held fixed, and the
 * commit identity is varied while the token is held fixed, and each is asserted
 * on its own.
 *
 * Pure functions, no database, no network — the boundaries here are string
 * boundaries and they are exercised at their exact values.
 */

import { describe, expect, it, vi } from "vitest";
import { attributedIdentity } from "../contracts/agent.js";
import {
	type CreatePullRequestInput,
	type PullRequestOutcome,
	type RepoRef,
	type ScmProvider,
	HARBOR_BRANCH_PREFIX,
	SELF_APPROVAL_LOST_SENTENCE,
	commitEnv,
	commitIdentity,
	harborBotIdentity,
	harborBranchName,
	openPullRequest,
	parseHarborBranch,
	pullRequestBody,
} from "./provider.js";

const CLAIM_ID = "9f1c2b84-1d7a-4f6e-9c3d-5a2b7e0f1234";
const REPO: RepoRef = { provider: "github", owner: "acme", name: "api" };
const BOT = { name: "Harbor", email: "harbor[bot]@users.noreply.github.com" };

/**
 * A provider that records what it was asked to do and answers as GitHub would.
 * `createPullRequest` echoes the author back from a lookup keyed on the token,
 * which is exactly the relationship the real API has: the author IS the token.
 */
function recordingProvider(tokenOwners: Record<string, string>) {
	const calls: CreatePullRequestInput[] = [];
	const provider: ScmProvider = {
		id: "github",
		host: "github.com",
		createPullRequest: async (input): Promise<PullRequestOutcome> => {
			calls.push(input);
			const login = tokenOwners[input.author_token] ?? "harbor[bot]";
			if (login.toLowerCase() !== input.expected_author_login.toLowerCase()) {
				return {
					kind: "attribution_mismatch",
					url: "https://github.com/acme/api/pull/7",
					number: 7,
					expected_login: input.expected_author_login,
					actual_login: login,
					message: "author mismatch",
				};
			}
			return {
				kind: "created",
				url: "https://github.com/acme/api/pull/7",
				number: 7,
				author_login: login,
				attribution: "prompting_user",
			};
		},
		pushUrl: (repo) => `https://github.com/${repo.owner}/${repo.name}.git`,
		compareUrl: (repo, base, head) =>
			`https://github.com/${repo.owner}/${repo.name}/compare/${base}...${head}?expand=1`,
		verifyRepoAccess: async () => ({
			decision: "allowed",
			permission: "write",
			checked_at: new Date().toISOString(),
		}),
		installationToken: async () => ({
			kind: "minted",
			token: "ghs_installation",
			expires_at: new Date().toISOString(),
		}),
	};
	return { provider, calls };
}

function openInput(overrides: Partial<Parameters<typeof openPullRequest>[2]> = {}) {
	return {
		repo: REPO,
		base: "main",
		title: "Fix the retry cap",
		claim: { id: CLAIM_ID, intent: "The retry cap was wrong.", intent_ref: null },
		session: { key: "sk_abc", url: "https://harbor.example/s/sk_abc" },
		agent_id: "claude-code:wt-1",
		requested_by: "@rin",
		commit_identity: commitIdentity(attributedIdentity("Rin Ito", "rin@example.com"), BOT),
		...overrides,
	} satisfies Parameters<typeof openPullRequest>[2];
}

// ---------------------------------------------------------------------------

describe("branch naming", () => {
	it("derives harbor/lse_<claim_id> from the claim, and nothing else", () => {
		expect(harborBranchName(CLAIM_ID)).toBe(`${HARBOR_BRANCH_PREFIX}${CLAIM_ID}`);
		expect(harborBranchName(CLAIM_ID)).toBe(
			"harbor/lse_9f1c2b84-1d7a-4f6e-9c3d-5a2b7e0f1234",
		);
	});

	it("normalises case so one lease cannot produce two branches", () => {
		expect(harborBranchName(CLAIM_ID.toUpperCase())).toBe(harborBranchName(CLAIM_ID));
	});

	it("round-trips: any Harbor branch names the ledger row that authorised it", () => {
		// This is the whole point of the naming scheme. Given a branch in a
		// repository months later, the claim — its intent, its holder, its lease
		// window, its cost rows — is reachable with zero inference.
		expect(parseHarborBranch(harborBranchName(CLAIM_ID))).toEqual({ claim_id: CLAIM_ID });
		expect(parseHarborBranch("feature/login")).toBeNull();
		expect(parseHarborBranch("harbor/lse_")).toBeNull();
	});

	it("refuses to build a ref out of anything that is not a claim id", () => {
		// A branch name reaches argv. An unvalidated string in one is a shell-
		// adjacent injection with a git-flavoured payload (`--upload-pack=…`).
		for (const bad of ["", "  ", "../../etc/passwd", "--upload-pack=sh", "a b", "x".repeat(4), "he!!o"]) {
			expect(() => harborBranchName(bad), bad).toThrow(/claim id/);
		}
	});

	it("is derived at PR time from the claim, not carried in from the caller", async () => {
		const { provider, calls } = recordingProvider({ gho_rin: "rin" });
		await openPullRequest(provider, { kind: "user", token: "gho_rin", login: "rin" }, openInput());
		expect(calls[0]!.head).toBe(harborBranchName(CLAIM_ID));
	});
});

// ---------------------------------------------------------------------------

describe("the PR body carries the claim's intent verbatim", () => {
	it("reproduces a multi-line intent byte for byte", () => {
		// Markdown-hostile on purpose: a fenced block, a list, a blockquote marker
		// and trailing whitespace. Blockquoting or reflowing the intent would break
		// every one of these, and the intent is the answer to "why does this change
		// exist" asked six months later.
		const intent = [
			"Customers on the EU shard see duplicate charges.",
			"",
			"```",
			"retry(attempts=3, idempotent=false)",
			"```",
			"",
			"> per the incident review",
			"- do not change the public API",
		].join("\n");

		const body = pullRequestBody({
			intent,
			intent_ref: "https://linear.app/acme/issue/ENG-412",
			claim_id: CLAIM_ID,
			session_key: "sk_abc",
			session_url: "https://harbor.example/s/sk_abc",
			agent_id: "claude-code:wt-1",
			opened_by: "@rin",
			commit_identity: commitIdentity(attributedIdentity("Rin Ito", "rin@example.com"), BOT),
		});

		expect(body).toContain(intent);
		expect(body).toContain("https://linear.app/acme/issue/ENG-412");
		expect(body).toContain(harborBranchName(CLAIM_ID));
		expect(body).toContain(CLAIM_ID);
	});

	it("says so when there is no intent rather than inventing one", () => {
		const body = pullRequestBody({
			intent: null,
			intent_ref: null,
			claim_id: CLAIM_ID,
			session_key: null,
			session_url: null,
			agent_id: null,
			opened_by: "@rin",
			commit_identity: commitIdentity({ mode: "agent-only" }, BOT),
		});
		expect(body).toContain("No intent was recorded");
	});
});

// ---------------------------------------------------------------------------

describe("property 1 — the COMMIT author and committer come from git metadata", () => {
	it("authors as the human and commits as the bot: two different identities", () => {
		const who = commitIdentity(attributedIdentity("Rin Ito", "rin@example.com"), BOT);

		// Asserted as two separate facts, deliberately.
		expect(who.author_name).toBe("Rin Ito");
		expect(who.author_email).toBe("rin@example.com");

		expect(who.committer_name).toBe("Harbor");
		expect(who.committer_email).toBe("harbor[bot]@users.noreply.github.com");

		// And they must not be the same identity, which is the property itself.
		expect(who.author_email).not.toBe(who.committer_email);
	});

	it("puts both on the environment, never in per-clone git config", () => {
		const env = commitEnv(attributedIdentity("Rin Ito", "rin@example.com"), BOT);
		expect(env).toEqual({
			GIT_AUTHOR_NAME: "Rin Ito",
			GIT_AUTHOR_EMAIL: "rin@example.com",
			GIT_COMMITTER_NAME: "Harbor",
			GIT_COMMITTER_EMAIL: "harbor[bot]@users.noreply.github.com",
		});
	});

	it("attributes agent-only work to the bot on both lines, explicitly", () => {
		const who = commitIdentity({ mode: "agent-only" }, BOT);
		expect(who.author_name).toBe("Harbor");
		expect(who.committer_name).toBe("Harbor");
	});

	it("refuses to guess an author when the prompt author has no identity", () => {
		// The failure this prevents is a repository history that lies about who
		// asked for a change. `agent-only` is an explicit choice, not a fallback.
		expect(() => attributedIdentity("Rin Ito", "")).toThrow(/will not guess/);
		expect(() => attributedIdentity(null, "rin@example.com")).toThrow(/will not guess/);
	});

	it("takes the bot identity from configuration, resolved at call time", () => {
		const previous = process.env.HARBOR_GIT_BOT_NAME;
		process.env.HARBOR_GIT_BOT_NAME = "Acme Harbor";
		try {
			expect(harborBotIdentity().name).toBe("Acme Harbor");
		} finally {
			if (previous === undefined) delete process.env.HARBOR_GIT_BOT_NAME;
			else process.env.HARBOR_GIT_BOT_NAME = previous;
		}
	});
});

// ---------------------------------------------------------------------------

describe("property 2 — the PULL REQUEST author comes from the token", () => {
	it("opens with the prompting human's token and reports them as the author", async () => {
		const { provider, calls } = recordingProvider({ gho_rin: "rin" });

		const outcome = await openPullRequest(
			provider,
			{ kind: "user", token: "gho_rin", login: "rin" },
			openInput(),
		);

		if (outcome.kind !== "created") throw new Error(`expected created, got ${outcome.kind}`);
		expect(outcome.author_login).toBe("rin");
		expect(outcome.attribution).toBe("prompting_user");
		// The token, not the commit identity, is what carried the authorship.
		expect(calls[0]!.author_token).toBe("gho_rin");
		expect(calls[0]!.expected_author_login).toBe("rin");
	});

	it("changing the TOKEN changes the PR author and leaves the commit identity alone", async () => {
		const { provider, calls } = recordingProvider({ gho_rin: "rin", gho_maya: "maya" });
		// One fixed commit identity, two different tokens.
		const identity = commitIdentity(attributedIdentity("Rin Ito", "rin@example.com"), BOT);

		const first = await openPullRequest(
			provider,
			{ kind: "user", token: "gho_rin", login: "rin" },
			openInput({ commit_identity: identity }),
		);
		const second = await openPullRequest(
			provider,
			{ kind: "user", token: "gho_maya", login: "maya" },
			openInput({ commit_identity: identity }),
		);

		if (first.kind !== "created" || second.kind !== "created") throw new Error("expected created");
		expect(first.author_login).toBe("rin");
		expect(second.author_login).toBe("maya");
		// The commit metadata did not move. Two independent properties.
		expect(calls[0]!.body).toContain("Rin Ito <rin@example.com>");
		expect(calls[1]!.body).toContain("Rin Ito <rin@example.com>");
	});

	it("changing the COMMIT identity does not touch the PR author", async () => {
		const { provider } = recordingProvider({ gho_rin: "rin" });
		const outcome = await openPullRequest(
			provider,
			{ kind: "user", token: "gho_rin", login: "rin" },
			openInput({ commit_identity: commitIdentity({ mode: "agent-only" }, BOT) }),
		);
		if (outcome.kind !== "created") throw new Error("expected created");
		// Commits attributed to nobody; the pull request still authored by the human
		// who asked for it, because that comes from the token.
		expect(outcome.author_login).toBe("rin");
	});

	it("reports an author that is not the requester as a mismatch, not as success", async () => {
		// A token that belongs to the bot. This is the shape of the bug where a
		// refactor "simplifies" credential handling and the app opens the PR.
		const { provider } = recordingProvider({ gho_wrong: "harbor[bot]" });
		const outcome = await openPullRequest(
			provider,
			{ kind: "user", token: "gho_wrong", login: "rin" },
			openInput(),
		);
		expect(outcome.kind).toBe("attribution_mismatch");
	});

	it("says in the body why the opener cannot approve it", async () => {
		const { provider, calls } = recordingProvider({ gho_rin: "rin" });
		await openPullRequest(provider, { kind: "user", token: "gho_rin", login: "rin" }, openInput());
		expect(calls[0]!.body).toContain("cannot approve it");
	});
});

// ---------------------------------------------------------------------------

describe("no SCM identity — degrade loudly, never silently", () => {
	it("does not open the PR, returns a compare URL, and names the lost property", async () => {
		const { provider, calls } = recordingProvider({});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		try {
			const outcome = await openPullRequest(
				provider,
				{ kind: "absent", reason: "no_scm_identity" },
				openInput(),
			);

			if (outcome.kind !== "degraded") throw new Error(`expected degraded, got ${outcome.kind}`);

			// Nothing was opened as the app. This is the assertion that matters most
			// in the whole suite: the bot never authors a pull request.
			expect(calls).toHaveLength(0);

			// The branch is pushed, so the human is handed the one-click URL.
			expect(outcome.compare_url).toBe(
				`https://github.com/acme/api/compare/main...${harborBranchName(CLAIM_ID)}?expand=1`,
			);

			// And the warning names the security property in words, not in jargon.
			expect(outcome.warning).toContain(SELF_APPROVAL_LOST_SENTENCE);
			expect(outcome.warning).toContain(
				"this PR was opened by the Harbor bot, so the requesting user is able to approve it",
			);
			expect(outcome.warning).toContain(outcome.compare_url);
			expect(outcome.reason).toBe("no_scm_identity");

			// Loud at use time as well as in the returned value, so a caller that
			// forgets to surface it still leaves a trace an operator can find.
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0]![0])).toContain(SELF_APPROVAL_LOST_SENTENCE);
		} finally {
			warn.mockRestore();
		}
	});

	it("names the deployment-wide gap differently from one user's missing account", async () => {
		const { provider } = recordingProvider({});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const outcome = await openPullRequest(
				provider,
				{ kind: "absent", reason: "deployment_has_no_scm_oauth" },
				openInput(),
			);
			if (outcome.kind !== "degraded") throw new Error("expected degraded");
			expect(outcome.warning).toContain("no source-control OAuth app configured");
			expect(outcome.warning).toContain(SELF_APPROVAL_LOST_SENTENCE);
		} finally {
			warn.mockRestore();
		}
	});

	it("DEFERS rather than degrades when the identity could not be determined", async () => {
		const { provider, calls } = recordingProvider({});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		try {
			const outcome = await openPullRequest(
				provider,
				{
					kind: "indeterminate",
					reason: "refresh_upstream_unavailable",
					detail: "the token endpoint answered 502",
				},
				openInput(),
			);

			if (outcome.kind !== "deferred") throw new Error(`expected deferred, got ${outcome.kind}`);
			expect(calls).toHaveLength(0);
			expect(outcome.compare_url).toContain("compare/main...");
			// Critically it must NOT claim the user has no identity: a ten-second
			// outage would otherwise permanently downgrade this pull request, and the
			// message would send a user to reconnect an account that is fine.
			expect(outcome.message).not.toContain(SELF_APPROVAL_LOST_SENTENCE);
			expect(outcome.message).toContain("not the same as having no identity");
		} finally {
			warn.mockRestore();
		}
	});
});
