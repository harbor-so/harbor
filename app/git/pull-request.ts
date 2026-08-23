// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The production caller `openPullRequest` never had.
 *
 * Everything below this module was already written and tested — the authority
 * resolution in `credentials.ts`, the three-outcome orchestration in
 * `provider.ts`, the GitHub calls in `github.ts`, and `markPullRequestMerged`
 * waiting on the other side for a webhook. What was missing was the edge from "a
 * sandbox pushed a branch" to "somebody calls that code", and because it was
 * missing no `pull_request` artifact was ever inserted, so the headline metric —
 * *sessions that resulted in a merged pull request* — read `0/n` on every
 * deployment for reasons that had nothing to do with the agents.
 *
 * This module is that edge, and it is one entry point rather than two so that the
 * inline path (a push just arrived) and the retry path (an identity lookup was
 * indeterminate ten minutes ago) cannot drift apart. The retry path is not
 * optional: `openPullRequest` distinguishes *absent* identity from
 * *indeterminate* identity precisely so that a provider outage does not
 * permanently strip a pull request of its attribution, and that distinction is
 * worth nothing unless somebody tries again.
 *
 * ## What this module refuses to do
 *
 * It never opens a pull request as the Harbor bot. Not as a fallback, not for a
 * scheduled automation with no human behind it. A session with no attributable
 * user pushes its branch and hands back a compare URL, loudly. The moment the bot
 * can author a PR, a reviewer approving their own agent's work becomes possible
 * again and nothing in the repository records that the guarantee lapsed.
 */

import { and, desc, eq, isNotNull, sql as raw } from "drizzle-orm";
import { db } from "@core/schema/index.js";
import { artifacts, claims, repos, sessionPrompts, sessions } from "@core/schema/schema.js";
import { appendEvent } from "../lib/session-events.js";
import { notifyChange } from "@core/kernel/work.js";
import { prAuthorityForUser } from "./credentials.js";
import { createScmProvider } from "./github.js";
import {
	assertNever,
	commitIdentity,
	harborBotIdentity,
	openPullRequest,
	parseHarborBranch,
	type CommitIdentity,
	type PrAuthority,
	type RepoRef,
	type ScmProviderId,
} from "./provider.js";

/**
 * What happened, in the caller's terms rather than the provider's.
 *
 * `noop` is separated from the rest because it is the *expected* outcome of every
 * push after the first: a session that pushes six times produces one pull
 * request, and the five later pushes update it on the host without Harbor doing
 * anything. Folding that into "created" would double-count the metric; folding it
 * into an error would fill the room with failures that are not failures.
 */
export type PullRequestRecord =
	| { kind: "opened"; url: string; number: number; author_login: string }
	| { kind: "noop"; reason: "already_open_for_branch"; url: string | null }
	| { kind: "degraded"; compare_url: string; warning: string }
	| { kind: "deferred"; compare_url: string | null; message: string }
	| { kind: "unavailable"; message: string };

export interface OpenForBranchInput {
	orgId: string;
	sessionId: string;
	repoId: string;
	/** The branch the sandbox reported pushing, already pinned. */
	branch: string;
	base: string | null;
	/** The prompt whose turn produced the push, when the sandbox named one. */
	promptId?: string | null;
}

/**
 * Has this branch already got a pull request recorded against it?
 *
 * Matched on the artifact's payload rather than on its URL, because the branch is
 * the identifier Harbor knows before the PR exists and the URL is the one it only
 * learns afterwards. Scoped to the session as well as the org: the same branch
 * name cannot recur across sessions (it carries a claim id) but the query is
 * cheap either way and a session-scoped read is the house rule.
 */
async function existingPullRequest(input: {
	orgId: string;
	sessionId: string;
	branch: string;
}): Promise<{ url: string | null } | null> {
	const rows = await db
		.select({ url: artifacts.url, payload: artifacts.payload })
		.from(artifacts)
		.where(
			and(
				eq(artifacts.orgId, input.orgId),
				eq(artifacts.sessionId, input.sessionId),
				eq(artifacts.kind, "pull_request"),
			),
		)
		.orderBy(desc(artifacts.createdAt));

	for (const row of rows) {
		const branch = (row.payload as { branch?: unknown } | null)?.branch;
		if (branch === input.branch) return { url: row.url };
	}
	return null;
}

/**
 * Who this pull request is opened as.
 *
 * The named prompt first — that is the turn whose commits are being pushed, so
 * its author is the person the work belongs to. Falling back to the most recent
 * prompt that *has* a user is deliberate and bounded: a session where a human
 * asked for something and an automation later nudged it should still open as the
 * human. A session with no attributable prompt at all returns null, and the
 * caller degrades rather than substituting the bot.
 */
async function promptingUserId(input: {
	orgId: string;
	sessionId: string;
	promptId?: string | null;
}): Promise<string | null> {
	if (input.promptId) {
		const [named] = await db
			.select({ userId: sessionPrompts.authorUserId })
			.from(sessionPrompts)
			.where(and(eq(sessionPrompts.id, input.promptId), eq(sessionPrompts.orgId, input.orgId)))
			.limit(1);
		if (named?.userId) return named.userId;
	}

	const [latest] = await db
		.select({ userId: sessionPrompts.authorUserId })
		.from(sessionPrompts)
		.where(
			and(
				eq(sessionPrompts.sessionId, input.sessionId),
				eq(sessionPrompts.orgId, input.orgId),
				isNotNull(sessionPrompts.authorUserId),
			),
		)
		.orderBy(desc(sessionPrompts.seq))
		.limit(1);
	return latest?.userId ?? null;
}

/**
 * The lease this branch was created under, read out of the branch name itself.
 *
 * This is the traceability claim being cashed in rather than asserted: the branch
 * carries the claim id, so the intent that goes in the pull request body comes
 * from the lease the work actually began under — not from whichever lease happens
 * to be held at the moment the PR is opened, which after a queue drain is a
 * different row describing a different stretch of work.
 */
async function leaseForBranch(
	orgId: string,
	branch: string,
): Promise<{ id: string; intent: string | null; intent_ref: string | null }> {
	const parsed = parseHarborBranch(branch);
	if (!parsed) return { id: branch, intent: null, intent_ref: null };

	const [row] = await db
		.select({ id: claims.id, intent: claims.intent, intentRef: claims.intentRef })
		.from(claims)
		.where(and(eq(claims.orgId, orgId), eq(claims.id, parsed.claim_id)))
		.limit(1);

	if (!row) return { id: parsed.claim_id, intent: null, intent_ref: null };
	return { id: row.id, intent: row.intent, intent_ref: row.intentRef };
}

/** The commit identity the PR body reports, for the reviewer reading `git log`. */
function identityFor(authority: PrAuthority, name: string | null, email: string | null): CommitIdentity {
	const bot = harborBotIdentity();
	// Attributed only when the turn could have been: the same two facts the
	// commands route uses to decide `attributed-user`. Reporting an attributed
	// identity in the body while the commits were made `agent-only` would be a
	// footer that contradicts the history it describes.
	if (authority.kind === "user" && name?.trim() && email?.trim()) {
		return commitIdentity({ mode: "attributed-user", name: name.trim(), email: email.trim() }, bot);
	}
	return commitIdentity({ mode: "agent-only" }, bot);
}

function sessionUrl(key: string): string | null {
	const base = process.env.HARBOR_PUBLIC_URL?.trim() || process.env.HARBOR_CONTROL_URL?.trim();
	if (!base) return null;
	return `${base.replace(/\/+$/, "")}/s/${key}`;
}

/**
 * Open the pull request for a pushed branch, or record honestly why not.
 *
 * Ordering matters and is not incidental: the branch artifact and the timeline
 * entry are written by the caller *before* this runs, so a failure here still
 * leaves the user a branch they can find. Nothing in this function is required
 * for the work to be recoverable; it is required for the work to be reviewable.
 */
export async function openPullRequestForBranch(
	input: OpenForBranchInput,
): Promise<PullRequestRecord> {
	const already = await existingPullRequest(input);
	if (already) {
		// The ordinary second-push case. GitHub updates the open PR from the branch
		// itself; there is nothing for Harbor to do and nothing worth saying.
		return { kind: "noop", reason: "already_open_for_branch", url: already.url };
	}

	const [repo] = await db
		.select({
			owner: repos.owner,
			name: repos.name,
			provider: repos.provider,
			defaultBranch: repos.defaultBranch,
		})
		.from(repos)
		.where(and(eq(repos.id, input.repoId), eq(repos.orgId, input.orgId)))
		.limit(1);
	if (!repo) {
		return {
			kind: "unavailable",
			message: `Session ${input.sessionId} pushed ${input.branch} for a repository that is no longer readable.`,
		};
	}

	const [session] = await db
		.select({ key: sessions.key, title: sessions.title })
		.from(sessions)
		.where(and(eq(sessions.id, input.sessionId), eq(sessions.orgId, input.orgId)))
		.limit(1);
	if (!session) {
		return { kind: "unavailable", message: `Session ${input.sessionId} no longer exists.` };
	}

	const selection = createScmProvider();
	if (!selection.ok) {
		// A deployment whose SCM provider is unconfigured or unimplemented. Not
		// retryable by waiting — it needs an operator — so it is not `deferred`,
		// which would have the sweep retrying forever against a config error.
		return { kind: "unavailable", message: selection.message };
	}

	const userId = await promptingUserId(input);
	const authority: PrAuthority = userId
		? await prAuthorityForUser(userId)
		: {
				kind: "absent",
				reason: "no_scm_identity",
				detail:
					"No prompt in this session was written by a signed-in user, so there is nobody "
					+ "whose credentials this pull request could be opened with. Automations and "
					+ "connector-created sessions reach this path legitimately.",
			};

	const [author] = userId
		? await db
				.select({ name: sessionPrompts.author, email: sessionPrompts.authorEmail })
				.from(sessionPrompts)
				.where(
					and(
						eq(sessionPrompts.sessionId, input.sessionId),
						eq(sessionPrompts.authorUserId, userId),
					),
				)
				.orderBy(desc(sessionPrompts.seq))
				.limit(1)
		: [];

	const lease = await leaseForBranch(input.orgId, input.branch);
	const ref: RepoRef = {
		provider: repo.provider as ScmProviderId,
		owner: repo.owner,
		name: repo.name,
	};

	const outcome = await openPullRequest(selection.provider, authority, {
		repo: ref,
		base: input.base || repo.defaultBranch,
		title: session.title,
		claim: { id: lease.id, intent: lease.intent, intent_ref: lease.intent_ref },
		session: { key: session.key, url: sessionUrl(session.key) },
		agent_id: null,
		requested_by: author?.name ?? "the requester",
		commit_identity: identityFor(authority, author?.name ?? null, author?.email ?? null),
		head: input.branch,
	});

	// No `default`: a fifth outcome is a compile error here rather than a pull
	// request that was opened and never recorded.
	switch (outcome.kind) {
		case "created":
		case "adopted": {
			// THE ROW THE METRIC HAS BEEN WAITING FOR. `url` is the PR's `html_url`,
			// which is the exact string every later webhook about this PR carries, and
			// which `markPullRequestMerged` joins on.
			await db.insert(artifacts).values({
				orgId: input.orgId,
				sessionId: input.sessionId,
				repoId: input.repoId,
				kind: "pull_request",
				title: `#${outcome.number} ${session.title}`,
				url: outcome.url,
				payload: {
					branch: input.branch,
					base: input.base || repo.defaultBranch,
					number: outcome.number,
					author_login: outcome.author_login,
					attribution: outcome.attribution,
					claim_id: lease.id,
					adopted: outcome.kind === "adopted",
					...(input.promptId ? { prompt_id: input.promptId } : {}),
				},
			});
			await appendEvent({
				orgId: input.orgId,
				sessionId: input.sessionId,
				type: "artifact_created",
				actor: "harbor",
				payload: {
					artifact: "pull_request",
					url: outcome.url,
					number: outcome.number,
					opened_by: outcome.author_login,
					branch: input.branch,
				},
			});
			await notifyChange(input.orgId, "session_event");
			return {
				kind: "opened",
				url: outcome.url,
				number: outcome.number,
				author_login: outcome.author_login,
			};
		}

		case "degraded": {
			// Terminal, and said out loud in the room rather than only in a log. This
			// is the case where an organisation on non-SCM SSO loses the central
			// guarantee, and burying it in documentation is how that goes unnoticed.
			await appendEvent({
				orgId: input.orgId,
				sessionId: input.sessionId,
				type: "policy_denied",
				actor: "harbor",
				payload: {
					decision: "pull_request_not_opened",
					reason: outcome.reason,
					branch: input.branch,
					compare_url: outcome.compare_url,
					message: outcome.warning,
				},
			});
			await notifyChange(input.orgId, "session_event");
			return { kind: "degraded", compare_url: outcome.compare_url, warning: outcome.warning };
		}

		case "deferred":
			// Retryable, and deliberately NOT written to the timeline as a denial. We
			// do not know that this user has no identity; we know we could not reach
			// the host. `sweepDeferredPullRequests` tries again.
			console.warn(`[pr] deferred for ${input.branch}: ${outcome.message}`);
			return { kind: "deferred", compare_url: outcome.compare_url, message: outcome.message };

		case "attribution_mismatch": {
			// The pull request exists and is authored by somebody other than the person
			// whose token we believed we were using. This is the self-approval
			// guarantee failing *silently* — the one failure mode the whole attribution
			// design exists to make impossible — so it is recorded as a denial on the
			// timeline and the artifact is written with the mismatch on it rather than
			// being left out. Leaving it out would be worse: the PR is real and open,
			// and an unrecorded PR is one nobody can reconcile later.
			await db.insert(artifacts).values({
				orgId: input.orgId,
				sessionId: input.sessionId,
				repoId: input.repoId,
				kind: "pull_request",
				title: `#${outcome.number} ${session.title}`,
				url: outcome.url,
				payload: {
					branch: input.branch,
					number: outcome.number,
					author_login: outcome.actual_login,
					expected_login: outcome.expected_login,
					attribution: "mismatch",
					claim_id: lease.id,
				},
			});
			await appendEvent({
				orgId: input.orgId,
				sessionId: input.sessionId,
				type: "policy_denied",
				actor: "harbor",
				payload: {
					decision: "pull_request_attribution_mismatch",
					url: outcome.url,
					expected_login: outcome.expected_login,
					actual_login: outcome.actual_login,
					branch: input.branch,
					message: outcome.message,
				},
			});
			await notifyChange(input.orgId, "session_event");
			console.error(`[pr] attribution mismatch on ${outcome.url}: ${outcome.message}`);
			return { kind: "unavailable", message: outcome.message };
		}

		case "failed":
			console.error(`[pr] ${input.branch}: ${outcome.message}`);
			return { kind: "unavailable", message: outcome.message };
	}
	return assertNever(outcome, "openPullRequestForBranch");
}

/**
 * Retry the pull requests that were deferred, not the ones that were refused.
 *
 * Driven from the session tick. It finds branch artifacts with no pull request
 * recorded against them and re-runs the orchestration; the idempotence check at
 * the top of `openPullRequestForBranch` makes a duplicate impossible, and a
 * `degraded` outcome writes a `policy_denied` event whose presence is what stops
 * this retrying an identity that is genuinely absent rather than merely
 * unreachable.
 */
export async function sweepDeferredPullRequests(limit = 20): Promise<{
	attempted: number;
	opened: number;
}> {
	const pending = await db
		.select({
			id: artifacts.id,
			orgId: artifacts.orgId,
			sessionId: artifacts.sessionId,
			repoId: artifacts.repoId,
			payload: artifacts.payload,
		})
		.from(artifacts)
		.where(
			and(
				eq(artifacts.kind, "branch"),
				// Terminal rows are excluded HERE rather than skipped after the read.
				// Skipping in the loop leaves them occupying the limit: twenty branches
				// that degraded — a deployment with no SCM OAuth, which is a legitimate
				// state, not an error — would sit at the top of this ordering forever
				// and starve every older branch still waiting for a retry. The sweep
				// would report `attempted: 0` on every tick while genuinely pending work
				// went untouched.
				raw`(${artifacts.payload} ->> 'retry') is distinct from 'false'`,
			),
		)
		.orderBy(desc(artifacts.createdAt))
		.limit(limit);

	let attempted = 0;
	let opened = 0;

	for (const row of pending) {
		const payload = (row.payload ?? {}) as { branch?: unknown; base?: unknown; retry?: unknown };
		if (typeof payload.branch !== "string" || !row.repoId) continue;

		const already = await existingPullRequest({
			orgId: row.orgId,
			sessionId: row.sessionId,
			branch: payload.branch,
		});
		if (already) continue;

		attempted += 1;
		const outcome = await openPullRequestForBranch({
			orgId: row.orgId,
			sessionId: row.sessionId,
			repoId: row.repoId,
			branch: payload.branch,
			base: typeof payload.base === "string" ? payload.base : null,
		});
		if (outcome.kind === "opened") opened += 1;
		// A terminal outcome marks the branch so the sweep stops reconsidering it.
		// Without this the degraded case — a real deployment state, not an error —
		// is retried on every tick forever, and each retry costs an OAuth lookup.
		if (outcome.kind === "degraded" || outcome.kind === "unavailable") {
			await db
				.update(artifacts)
				.set({ payload: { ...payload, retry: false, last_outcome: outcome.kind } })
				.where(eq(artifacts.id, row.id));
		}
	}

	return { attempted, opened };
}
