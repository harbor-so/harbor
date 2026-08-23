// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The GitHub implementation of `ScmProvider`.
 *
 * Everything GitHub-specific lives here — URL shapes, response bodies, the App
 * JWT, the status codes that mean "you may not see this" — so that the policy in
 * `provider.ts` stays provider-agnostic and a second provider is a new file
 * rather than a rewrite.
 *
 * ## Why `fetch` is injected
 *
 * The constructor takes a `fetch`. The tests drive fabricated GitHub responses
 * through it and never touch the network, which is not merely a speed
 * optimisation: the cases that matter most here are the ones that are hard to
 * produce on demand against a real API — a 5xx during an authority check, a 200
 * with the `permissions` object missing, a pull request that already exists, a
 * response whose author is not who we expected. A suite that can only exercise
 * the happy path is a suite that tests the one case nobody was worried about.
 *
 * ## Three status codes that do not mean what they say
 *
 *  - **404 is a denial, not a missing repository.** GitHub deliberately answers
 *    404 for a private repository the caller cannot see, so that the existence of
 *    a repository is not itself leaked. Treating it as "not found, maybe try the
 *    app's token instead" is how a per-user access check turns back into no check
 *    at all.
 *  - **403 is sometimes a rate limit**, and a rate-limited check has told us
 *    *nothing* about access. It is indeterminate, and indeterminate fails closed
 *    at the authority boundary — but it must not be recorded as a denial, or a
 *    burst of traffic looks in the logs like a permissions incident.
 *  - **200 can be a refresh-token failure.** GitHub's OAuth token endpoint
 *    answers 200 with `{"error": "bad_refresh_token"}` in the body. Code that
 *    checks `response.ok` and moves on stores an access token of `undefined` and
 *    fails much later, somewhere unrelated. See `src/git/credentials.ts`.
 */

import { createSign } from "node:crypto";
import type { ProviderErrorType } from "../contracts/index.js";
import {
	type CreatePullRequestInput,
	type InstallationTokenResult,
	type InstallationTokenScope,
	type PullRequestOutcome,
	type RepoAccess,
	type RepoListing,
	type RepoListingProvider,
	type RepoPermission,
	type RepoRef,
	type RepoSummary,
	type ScmProvider,
	type ScmProviderId,
	assertNever,
	encodeRefForUrl,
	resolveScmProviderId,
	scmSetting,
} from "./provider.js";

/**
 * The injection point. Deliberately the real `fetch` shape rather than a bespoke
 * transport interface, so a test double is `async () => new Response(...)` and
 * cannot drift from what the production path actually does.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GitHubProviderOptions {
	/** `github.com`, or a GitHub Enterprise Server hostname. */
	host?: string;
	fetch?: FetchLike;
	/** The GitHub App, for minting installation tokens. Never for opening PRs. */
	app?: { appId: string; privateKey: string };
	now?: () => Date;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

type HttpOutcome =
	| { kind: "response"; status: number; headers: Headers; body: unknown; text: string }
	| { kind: "transport_error"; error_type: ProviderErrorType; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Map an HTTP status onto the classification the circuit breaker consumes.
 *
 * The split that matters is transient versus permanent: a 503 should count
 * towards opening the breaker, a 422 "no commits between branches" must not.
 * Counting configuration errors as outages means the breaker opens on a mistake
 * in one repository and refuses every other repository's work while hiding the
 * real cause behind a generic "circuit open".
 */
function classifyStatus(status: number): ProviderErrorType {
	if (status === 401) return "unauthorized";
	if (status === 403) return "unauthorized";
	if (status === 404) return "not_found";
	if (status === 422) return "invalid_config";
	if (status === 429) return "rate_limited";
	if (status >= 500) return "transient";
	return "unknown";
}

function messageFrom(body: unknown, fallback: string): string {
	if (isRecord(body) && typeof body.message === "string") return body.message;
	return fallback;
}

/** GitHub signals a rate limit with a 403 and an exhausted remaining counter. */
function isRateLimited(status: number, headers: Headers, body: unknown): boolean {
	if (status === 429) return true;
	if (status !== 403) return false;
	if (headers.get("x-ratelimit-remaining") === "0") return true;
	if (headers.get("retry-after")) return true;
	return /rate limit|secondary rate/i.test(messageFrom(body, ""));
}

/** GitHub signals "authorise this token for the SAML org" with a dedicated header. */
function needsSsoAuthorization(headers: Headers, body: unknown): boolean {
	if (headers.get("x-github-sso")) return true;
	return /SAML enforcement|single sign-on/i.test(messageFrom(body, ""));
}

// ---------------------------------------------------------------------------
// Repository access cache
// ---------------------------------------------------------------------------

interface CachedAccess {
	access: RepoAccess;
	expires_at: number;
}

/**
 * Keyed by a digest of the token, never the token itself.
 *
 * Module-level rather than per-instance because a provider is constructed per
 * request; an instance cache would never be read twice and the check would run
 * on every page load of the session list. The TTL comes from a setting, not from
 * a constant here — see the rule at the top of `src/config.ts`.
 */
const repoAccessCache = new Map<string, CachedAccess>();

/** Exported for tests, and for an admin action that revokes access immediately. */
export function clearRepoAccessCache(): void {
	repoAccessCache.clear();
}

async function tokenFingerprint(token: string): Promise<string> {
	const { createHash } = await import("node:crypto");
	return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// Token shapes
// ---------------------------------------------------------------------------

/**
 * `ghs_` is a server-to-server (installation) token, `ghr_` is a refresh token.
 *
 * These prefixes are checked rather than trusted-by-convention because the two
 * invariants they protect are the two the whole design rests on: an installation
 * token must never open a pull request (it would author it as the app, and the
 * requester could then approve their own agent's work), and a refresh token must
 * never leave the control plane (it is the long-lived credential; the sandbox
 * gets minutes-lived ones). A prefix check is a cheap tripwire on a mistake that
 * is otherwise invisible until somebody audits a PR author months later.
 */
export function looksLikeInstallationToken(token: string): boolean {
	return token.startsWith("ghs_") || token.startsWith("v1.");
}

export function looksLikeRefreshToken(token: string): boolean {
	return token.startsWith("ghr_");
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

export class GitHubProvider implements ScmProvider, RepoListingProvider {
	readonly id: ScmProviderId = "github";
	readonly host: string;
	/** The discriminant `listsRepositories()` narrows on. See `RepoListingProvider`. */
	readonly listsRepositories = true as const;

	private readonly doFetch: FetchLike;
	private readonly app: { appId: string; privateKey: string } | null;
	private readonly now: () => Date;

	constructor(options: GitHubProviderOptions = {}) {
		this.host = (options.host ?? scmSetting("scmHost")).trim().toLowerCase();
		this.doFetch = options.fetch ?? ((input, init) => fetch(input, init));
		this.app = options.app ?? null;
		this.now = options.now ?? (() => new Date());
	}

	/**
	 * `api.github.com` on github.com, `/api/v3` on Enterprise Server. Derived
	 * rather than configured separately, so an operator cannot point the two at
	 * different installations and get a system that reads permissions from one
	 * host and pushes to another.
	 */
	get apiBase(): string {
		return this.host === "github.com" ? "https://api.github.com" : `https://${this.host}/api/v3`;
	}

	/**
	 * A remote URL with **no credential in it**, ever.
	 *
	 * Embedding a token in the remote is the obvious shortcut and it fails in the
	 * worst possible place. A session runs for two hours; the token baked into
	 * `origin` expired after one; the agent finishes, runs `git push`, and the
	 * push is rejected with a credential error after all the work is done. It also
	 * leaves the token in `.git/config`, in `git remote -v`, and in every error
	 * message git prints — which is to say, in the session transcript.
	 *
	 * Instead the in-sandbox credential helper fetches a fresh credential per
	 * operation from `mintGitCredential`, so the credential's lifetime is the
	 * operation's lifetime.
	 */
	pushUrl(repo: RepoRef): string {
		const host = (repo.host ?? this.host).toLowerCase();
		return `https://${host}/${repo.owner}/${repo.name}.git`;
	}

	compareUrl(repo: RepoRef, base: string, head: string): string {
		const host = (repo.host ?? this.host).toLowerCase();
		return (
			`https://${host}/${repo.owner}/${repo.name}/compare/`
			+ `${encodeRefForUrl(base)}...${encodeRefForUrl(head)}?expand=1`
		);
	}

	// -- Authority ----------------------------------------------------------

	/**
	 * Can *this user* reach this repository? Asked with the user's own token.
	 *
	 * The bug this exists to close: a deployment has one GitHub App installed
	 * across an organisation, and every session uses that installation. Without a
	 * per-user check, any user of the deployment can start a session against any
	 * repository the App can see — including one they have no access to at all —
	 * and the agent will happily clone it, read it, and push a branch to it. The
	 * App's permissions are a ceiling, not an authorisation.
	 *
	 * Required at session creation, not at push time, because by push time the
	 * repository has already been cloned into a box the user can read.
	 */
	async verifyRepoAccess(userToken: string, owner: string, name: string): Promise<RepoAccess> {
		const cacheKey = `${this.host}/${owner}/${name}/${await tokenFingerprint(userToken)}`;
		const cached = repoAccessCache.get(cacheKey);
		if (cached && cached.expires_at > this.now().getTime()) return cached.access;

		const result = await this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
			method: "GET",
			token: userToken,
			scheme: "token",
		});

		const access = this.interpretRepoAccess(result);

		// Only settled answers are cached. Caching an indeterminate answer converts
		// a five-second outage into a full cache-TTL of denials for every user who
		// happened to ask during it — the outage outlives the outage.
		if (access.decision !== "indeterminate") {
			repoAccessCache.set(cacheKey, {
				access,
				expires_at: this.now().getTime() + scmSetting("scmRepoAccessCacheMs"),
			});
		}
		return access;
	}

	private interpretRepoAccess(result: HttpOutcome): RepoAccess {
		const checkedAt = this.now().toISOString();

		if (result.kind === "transport_error") {
			return {
				decision: "indeterminate",
				reason: result.error_type === "transient" ? "upstream_unavailable" : "upstream_timeout",
				status: null,
				detail: result.message,
			};
		}

		const { status, headers, body } = result;

		if (status >= 500) {
			return {
				decision: "indeterminate",
				reason: "upstream_unavailable",
				status,
				detail: `The source-control host answered ${status}.`,
			};
		}
		if (isRateLimited(status, headers, body)) {
			return {
				decision: "indeterminate",
				reason: "rate_limited",
				status,
				detail:
					"The access check was rate limited, which says nothing about whether this "
					+ "account may use the repository.",
			};
		}
		if (status === 401) {
			return {
				decision: "denied",
				reason: "token_invalid",
				status,
				detail: "The stored source-control token was rejected. The user must reconnect.",
			};
		}
		if (status === 403) {
			if (needsSsoAuthorization(headers, body)) {
				return {
					decision: "denied",
					reason: "sso_authorization_required",
					status,
					detail:
						"The organisation enforces SAML and this token has not been authorised for "
						+ "it. The user authorises it once from their GitHub settings.",
				};
			}
			return { decision: "denied", reason: "forbidden", status, detail: messageFrom(body, "") };
		}
		if (status === 404) {
			// Not "the repository does not exist". GitHub answers 404 rather than 403
			// for a private repository the caller cannot see, precisely so that
			// existence is not leaked. Both readings lead to the same decision here,
			// which is why this is a denial rather than an error.
			return {
				decision: "denied",
				reason: "not_found_or_no_access",
				status,
				detail:
					"GitHub returned 404, which for a private repository means the account cannot "
					+ "see it. Harbor cannot distinguish that from the repository not existing, and "
					+ "does not need to: both are a refusal.",
			};
		}
		if (status !== 200) {
			return {
				decision: "indeterminate",
				reason: "malformed_response",
				status,
				detail: `Unexpected status ${status} from the repository endpoint.`,
			};
		}
		if (!isRecord(body)) {
			return {
				decision: "indeterminate",
				reason: "malformed_response",
				status,
				detail: "The repository endpoint returned something that was not a JSON object.",
			};
		}

		const permission = readPermission(body.permissions);
		if (!permission) {
			// A 200 proves the account can *see* the repository, but the session needs
			// to know whether it can push. Guessing "read" would refuse legitimate
			// work; guessing "write" would admit it without evidence. Neither is a
			// determination, so it is reported as one that could not be made.
			return {
				decision: "indeterminate",
				reason: "permission_unreported",
				status,
				detail:
					"The repository is visible to this account but the response carried no "
					+ "`permissions` object, so the access level could not be established.",
			};
		}

		return { decision: "allowed", permission, checked_at: checkedAt };
	}

	// -- Listing ------------------------------------------------------------

	/**
	 * What this user can see, for the connect picker.
	 *
	 * Asked with the **user's own token**, like every other question about what a
	 * person may reach. Listing through the App installation would be easier and
	 * would show every repository the App is installed on to every user of the
	 * deployment — which is the multi-tenancy hole `verifyRepoAccess` exists to
	 * close, reintroduced at the only place a user goes looking for repositories.
	 *
	 * This is a convenience, never an authority: `connectRepo` re-checks the
	 * chosen repository with `verifyRepoAccess` before writing a row, so a stale
	 * or over-generous list cannot connect anything.
	 */
	async listRepositories(
		userToken: string,
		options: { limit?: number } = {},
	): Promise<RepoListing> {
		// One page. A picker showing the hundred most recently pushed repositories
		// with a search box beats paginating a thousand, and the honest answer for
		// anything past it is `truncated: true` plus the owner/name box, which is
		// what a person with a thousand repositories will use anyway.
		const limit = Math.min(Math.max(options.limit ?? 100, 1), 100);
		const result = await this.request(
			`/user/repos?per_page=${limit}&sort=pushed&affiliation=owner,collaborator,organization_member`,
			{ method: "GET", token: userToken, scheme: "token" },
		);

		if (result.kind === "transport_error") {
			return {
				kind: "unavailable",
				reason: result.error_type === "transient" ? "upstream_unavailable" : "upstream_timeout",
				detail: result.message,
			};
		}

		const { status, headers, body } = result;
		if (status === 401) {
			return {
				kind: "unavailable",
				reason: "token_invalid",
				detail: "GitHub rejected the stored token. Reconnect your account in Settings.",
			};
		}
		if (isRateLimited(status, headers, body)) {
			return { kind: "unavailable", reason: "rate_limited", detail: messageFrom(body, "Rate limited.") };
		}
		if (status === 403) {
			return { kind: "unavailable", reason: "forbidden", detail: messageFrom(body, "Forbidden.") };
		}
		if (status >= 500) {
			return {
				kind: "unavailable",
				reason: "upstream_unavailable",
				detail: `GitHub returned ${status}.`,
			};
		}
		if (!Array.isArray(body)) {
			return {
				kind: "unavailable",
				reason: "malformed_response",
				detail: "GitHub returned a repository list Harbor could not read.",
			};
		}

		const repositories: RepoSummary[] = [];
		for (const entry of body) {
			if (!isRecord(entry)) continue;
			const owner = isRecord(entry.owner) ? entry.owner.login : null;
			if (typeof owner !== "string" || typeof entry.name !== "string") continue;
			repositories.push({
				owner,
				name: entry.name,
				default_branch: typeof entry.default_branch === "string" ? entry.default_branch : "main",
				description: typeof entry.description === "string" ? entry.description : null,
				private: entry.private === true,
				permission: readPermission(entry.permissions),
			});
		}

		// GitHub only sends a `link` header when there is another page, so its
		// presence is the truthful test for "there is more than this".
		const truncated = (headers.get("link") ?? "").includes('rel="next"');
		return { kind: "listed", repositories, truncated };
	}

	// -- Pull requests ------------------------------------------------------

	/**
	 * Open a pull request **as the prompting human**.
	 *
	 * The first thing this does is refuse an installation token. It is a cheap
	 * check on the single mistake that silently voids the product's central
	 * guarantee: a PR authored by the app can be approved by the person who asked
	 * for it, and nothing in the resulting repository records that the review was
	 * self-granted. A wrong token is far more likely to arrive from a refactor
	 * that "simplified" credential handling than from an attacker, and this
	 * catches exactly that.
	 */
	async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestOutcome> {
		if (looksLikeInstallationToken(input.author_token)) {
			return {
				kind: "failed",
				error_type: "unauthorized",
				message:
					"Refusing to open a pull request with a GitHub App installation token. Harbor "
					+ "opens pull requests with the prompting human's own credentials and never with "
					+ "the app's, because the author of a pull request cannot approve it — that is "
					+ "the mechanism that makes unreviewed agent code structurally impossible. If no "
					+ "user token is available the correct outcome is a compare URL and a warning, "
					+ "not a bot-authored pull request.",
			};
		}

		const path = `/repos/${encodeURIComponent(input.repo.owner)}/${encodeURIComponent(input.repo.name)}/pulls`;
		const result = await this.request(path, {
			method: "POST",
			token: input.author_token,
			scheme: "token",
			body: {
				title: input.title,
				head: input.head,
				base: input.base,
				body: input.body,
				draft: input.draft ?? false,
				// Harbor never opens a PR that a maintainer cannot edit — a reviewer who
				// has to push a one-line fix should not have to ask the agent to run again.
				maintainer_can_modify: true,
			},
		});

		if (result.kind === "transport_error") {
			return { kind: "failed", error_type: result.error_type, message: result.message };
		}

		if (result.status === 201) {
			return this.settleCreated(result.body, input, "created");
		}

		// 422 with "A pull request already exists" is the idempotent retry path, and
		// it is not rare: the response to a successful create can be lost in transit
		// and the caller retries. Adopting the existing PR is the same reconciliation
		// discipline `SpawnOutcome.adopted` uses for a sandbox whose creation
		// response went missing — the alternative is a permanent failure on a
		// pull request that actually exists.
		if (result.status === 422 && /already exists/i.test(JSON.stringify(result.body ?? ""))) {
			return this.adoptExistingPullRequest(input);
		}

		return {
			kind: "failed",
			error_type: classifyStatus(result.status),
			message: `GitHub refused to open the pull request (${result.status}): ${messageFrom(
				result.body,
				result.text.slice(0, 400),
			)}`,
		};
	}

	private async adoptExistingPullRequest(
		input: CreatePullRequestInput,
	): Promise<PullRequestOutcome> {
		const path =
			`/repos/${encodeURIComponent(input.repo.owner)}/${encodeURIComponent(input.repo.name)}/pulls`
			+ `?head=${encodeURIComponent(`${input.repo.owner}:${input.head}`)}&state=open`;
		const result = await this.request(path, {
			method: "GET",
			token: input.author_token,
			scheme: "token",
		});

		if (result.kind === "transport_error") {
			return { kind: "failed", error_type: result.error_type, message: result.message };
		}
		const first = Array.isArray(result.body) ? result.body[0] : undefined;
		if (result.status !== 200 || !isRecord(first)) {
			return {
				kind: "failed",
				error_type: "unknown",
				message:
					"GitHub reported that a pull request for this branch already exists, but it "
					+ "could not be read back. Nothing was opened and nothing was lost; retry.",
			};
		}
		return this.settleCreated(first, input, "adopted");
	}

	/**
	 * Read the created PR back and **verify who authored it**.
	 *
	 * The author is the one property that cannot be re-checked later without
	 * calling GitHub again, and it is the property everything else depends on. If
	 * the response says the PR belongs to somebody other than the human we
	 * intended, that is reported as its own outcome rather than folded into
	 * success — including the URL, because the pull request does exist by then and
	 * whoever handles this needs to be able to reach it.
	 */
	private settleCreated(
		body: unknown,
		input: CreatePullRequestInput,
		how: "created" | "adopted",
	): PullRequestOutcome {
		if (!isRecord(body) || typeof body.html_url !== "string" || typeof body.number !== "number") {
			return {
				kind: "failed",
				error_type: "unknown",
				message:
					"GitHub accepted the pull request but returned a body Harbor could not read. "
					+ "The pull request may exist; check the branch before retrying.",
			};
		}
		const user = isRecord(body.user) && typeof body.user.login === "string" ? body.user.login : "";
		const expected = input.expected_author_login;

		if (user.toLowerCase() !== expected.toLowerCase()) {
			return {
				kind: "attribution_mismatch",
				url: body.html_url,
				number: body.number,
				expected_login: expected,
				actual_login: user || "(unreported)",
				message:
					`This pull request was expected to be authored by ${expected} but GitHub reports `
					+ `${user || "no author"}. Harbor surfaces this instead of accepting it, because `
					+ "an author who is not the requester means the requester can approve it, and "
					+ "the self-approval guarantee no longer holds for this pull request.",
			};
		}

		return how === "created"
			? {
					kind: "created",
					url: body.html_url,
					number: body.number,
					author_login: user,
					attribution: "prompting_user",
				}
			: {
					kind: "adopted",
					url: body.html_url,
					number: body.number,
					author_login: user,
					attribution: "prompting_user",
					reason: "already_open",
				};
	}

	// -- Installation tokens ------------------------------------------------

	/**
	 * A short-lived installation token, scoped down to one repository.
	 *
	 * GitHub caps these at one hour, which is both too long to embed anywhere and
	 * short enough that a long session must be able to re-fetch. `scope` narrows
	 * it further — one repository, and `contents: write` only when the operation
	 * is a push — so a leaked credential from a `git fetch` cannot be used to push
	 * to a sibling repository the installation also covers.
	 */
	async installationToken(
		installationId: string,
		scope?: InstallationTokenScope,
	): Promise<InstallationTokenResult> {
		if (!this.app) {
			return {
				kind: "unavailable",
				reason: "app_not_configured",
				message:
					"No GitHub App is configured, so Harbor cannot mint a credential for the "
					+ "sandbox to clone or push with. Set the app id and private key, or use a "
					+ "deployment mode that does not need repository access.",
			};
		}

		let jwt: string;
		try {
			jwt = appJwt(this.app.appId, this.app.privateKey, this.now());
		} catch (error) {
			return {
				kind: "failed",
				error_type: "invalid_config",
				message:
					`The GitHub App private key could not be used to sign a request: `
					+ `${(error as Error).message}. It must be the PEM GitHub issued, newlines and all.`,
			};
		}

		const result = await this.request(
			`/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
			{
				method: "POST",
				token: jwt,
				scheme: "bearer",
				body: scope
					? { repositories: scope.repositories, permissions: scope.permissions }
					: undefined,
			},
		);

		if (result.kind === "transport_error") {
			return { kind: "failed", error_type: result.error_type, message: result.message };
		}
		if (result.status === 404) {
			return {
				kind: "unavailable",
				reason: "installation_not_found",
				message:
					`Installation ${installationId} does not exist or this app cannot see it. The `
					+ "App was probably uninstalled from the organisation; reinstall it and the "
					+ "repository row will pick up the new installation id.",
			};
		}
		if (result.status === 403 && /suspend/i.test(messageFrom(result.body, ""))) {
			return {
				kind: "unavailable",
				reason: "installation_suspended",
				message: `Installation ${installationId} is suspended. An org admin must unsuspend it.`,
			};
		}
		if (result.status !== 201) {
			return {
				kind: "failed",
				error_type: classifyStatus(result.status),
				message: `Minting an installation token failed (${result.status}): ${messageFrom(
					result.body,
					result.text.slice(0, 200),
				)}`,
			};
		}
		if (
			!isRecord(result.body)
			|| typeof result.body.token !== "string"
			|| typeof result.body.expires_at !== "string"
		) {
			return {
				kind: "failed",
				error_type: "unknown",
				message:
					"GitHub returned a token response Harbor could not read. Refusing to hand a "
					+ "credential with an unknown expiry to a sandbox.",
			};
		}

		return { kind: "minted", token: result.body.token, expires_at: result.body.expires_at };
	}

	// -- Transport ----------------------------------------------------------

	private async request(
		path: string,
		init: {
			method: string;
			token: string;
			scheme: "token" | "bearer";
			body?: unknown;
		},
	): Promise<HttpOutcome> {
		const url = path.startsWith("https://") ? path : `${this.apiBase}${path}`;
		const timeoutMs = scmSetting("scmRequestTimeoutMs");

		try {
			const response = await this.doFetch(url, {
				method: init.method,
				headers: {
					accept: "application/vnd.github+json",
					"x-github-api-version": "2022-11-28",
					"user-agent": "harbor",
					authorization: `${init.scheme === "bearer" ? "Bearer" : "token"} ${init.token}`,
					...(init.body === undefined ? {} : { "content-type": "application/json" }),
				},
				body: init.body === undefined ? undefined : JSON.stringify(init.body),
				// AbortSignal.timeout rather than a manual timer: a manual one has to be
				// cleared on every return path, and the one that gets missed leaks a
				// handle that keeps a serverless invocation alive past its response.
				signal: AbortSignal.timeout(timeoutMs),
			});

			const text = await response.text();
			let body: unknown = null;
			if (text) {
				try {
					body = JSON.parse(text);
				} catch {
					body = null;
				}
			}
			return { kind: "response", status: response.status, headers: response.headers, body, text };
		} catch (error) {
			const name = (error as Error)?.name ?? "";
			// A timeout and a DNS failure are both transient for breaker purposes, but
			// they read very differently in a log line, so the message says which.
			return {
				kind: "transport_error",
				error_type: "transient",
				message:
					name === "TimeoutError" || name === "AbortError"
						? `The source-control host did not answer within ${timeoutMs}ms.`
						: `Could not reach the source-control host: ${(error as Error).message}`,
			};
		}
	}
}

/**
 * Read GitHub's `permissions` object into a single level.
 *
 * Highest first, because the object is cumulative — an admin has `push` and
 * `pull` set too — so checking `pull` first would report every administrator as
 * a reader and refuse them work they are plainly entitled to do.
 */
function readPermission(value: unknown): RepoPermission | null {
	if (!isRecord(value)) return null;
	if (value.admin === true) return "admin";
	if (value.maintain === true) return "maintain";
	if (value.push === true) return "write";
	if (value.triage === true) return "triage";
	if (value.pull === true) return "read";
	return null;
}

/**
 * The App JWT. RS256, signed with `node:crypto` rather than a JWT dependency —
 * the payload is three fields and pulling in a library to build it would add a
 * supply-chain surface for `JSON.stringify` plus a signature.
 *
 * The two numbers below are **GitHub protocol limits, not operator tunables**,
 * which is why they are literals here rather than settings: GitHub rejects a JWT
 * whose `exp` is more than ten minutes out, and rejects one whose `iat` is in the
 * future by even a second. Backdating `iat` by sixty seconds is what stops a
 * control plane whose clock runs two seconds fast from failing *every* token mint
 * with a 401 that says nothing about clocks.
 */
export function appJwt(appId: string, privateKey: string, now: Date): string {
	const issuedAt = Math.floor(now.getTime() / 1000) - 60;
	const expiresAt = issuedAt + 540;

	const encode = (value: unknown): string =>
		Buffer.from(JSON.stringify(value)).toString("base64url");

	const header = encode({ alg: "RS256", typ: "JWT" });
	const payload = encode({ iat: issuedAt, exp: expiresAt, iss: appId });
	const signer = createSign("RSA-SHA256");
	signer.update(`${header}.${payload}`);
	const signature = signer.sign(privateKey).toString("base64url");
	return `${header}.${payload}.${signature}`;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export type ScmProviderSelection =
	| { ok: true; provider: ScmProvider }
	| { ok: false; reason: "provider_not_implemented" | "provider_unknown"; message: string };

/**
 * The one place a provider instance is constructed.
 *
 * The factory lives beside the only implementation so that `provider.ts` — which
 * holds the policy every caller depends on — imports nothing concrete and cannot
 * acquire an import cycle when a second provider is added.
 */
/**
 * The App credentials, read from the environment at call time.
 *
 * Read here rather than passed in by every caller, because the one caller that
 * matters — `mintGitCredential`, on the sandbox's credential broker — constructs a
 * provider with nothing but a host. Without this the App is always `null`, so
 * `installationToken` answers `app_not_configured` and **every git operation in
 * every sandbox fails with a 403**, on a deployment whose `.env` names both
 * variables and looks correctly configured. That failure is fail-closed and
 * therefore safe, which is precisely why it would survive review: nothing leaks,
 * the product simply cannot clone.
 *
 * At call time, never at import: a module-level read happens before a test (or a
 * container that loads its secrets late) can set the variable, and the process then
 * behaves as though the App were absent for its whole life. Same rule as
 * `src/config.ts`.
 *
 * The PEM keeps its newlines. Deployments that cannot carry a multi-line value
 * through their secret store commonly substitute `\n`, so that spelling is restored
 * rather than handed to `createSign`, which would otherwise fail with an opaque
 * "error:1E08010C:DECODER routines::unsupported" that names nothing.
 */
function appFromEnvironment(): { appId: string; privateKey: string } | null {
	const appId = process.env.GITHUB_APP_ID?.trim();
	const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
	if (!appId || !privateKey) return null;
	return { appId, privateKey: privateKey.replace(/\\n/g, "\n") };
}

export function createScmProvider(options: GitHubProviderOptions = {}): ScmProviderSelection {
	const resolved = resolveScmProviderId();
	if (!resolved.ok) return { ok: false, reason: resolved.reason, message: resolved.message };

	switch (resolved.id) {
		case "github": {
			// An explicitly supplied app wins, so a test that passes one is never
			// overridden by whatever happens to be in the developer's environment.
			const app = options.app ?? appFromEnvironment();
			return {
				ok: true,
				provider: new GitHubProvider(app === null ? options : { ...options, app }),
			};
		}
		case "gitlab":
		case "bitbucket":
			// Unreachable: resolveScmProviderId already refused these. Kept as explicit
			// cases with no `default`, so implementing one is a compile error here
			// rather than a silent fallthrough to GitHub.
			return {
				ok: false,
				reason: "provider_not_implemented",
				message: `SCM_PROVIDER=${resolved.id} is not implemented in this build.`,
			};
	}
	return assertNever(resolved.id, "createScmProvider");
}
