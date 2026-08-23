// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Source control, and the one property the whole product rests on.
 *
 * ## The attribution split
 *
 * A sandbox pushes a branch with **short-lived brokered credentials** and reports
 * the branch name. The control plane then opens the pull request with the
 * **prompting human's own OAuth token**. The human is therefore the author of the
 * PR, and GitHub will not let an author approve their own pull request — so
 * "agent code was merged without a second pair of eyes" stops being a policy
 * somebody has to enforce and becomes a thing the platform cannot express.
 *
 * That is why `createPullRequest` takes a user token as a required input rather
 * than reaching for an installation token when one is missing. Harbor never opens
 * a pull request as the app. Not as a fallback, not "just this once for the
 * scheduled job". The moment the bot can author a PR, every reviewer's approval
 * of their own agent's work is again a possibility, and nothing in the repository
 * records that the guarantee lapsed.
 *
 * ## The detail the naive implementation gets wrong
 *
 * There are **two independent attribution properties**, and they come from two
 * completely different places:
 *
 *   - The **pull request author** comes from the *token used to call the API*.
 *   - The **commit author and committer** come from *git commit metadata* —
 *     `GIT_AUTHOR_*` and `GIT_COMMITTER_*` set inside the sandbox — and have
 *     nothing whatsoever to do with the credential used to push.
 *
 * Conflating them produces a system that looks right in a screenshot and is
 * wrong in the audit: commits authored by a bot under a PR opened by a human, or
 * the reverse. The target state is
 *
 *     Author:    <the human who prompted>
 *     Committer: Harbor <bot@…>
 *     PR opened by: <the human who prompted>
 *
 * and `attribution.test.ts` asserts each of those separately, because a test that
 * checks them together passes when both are wrong in the same direction.
 *
 * ## What lives here versus in `github.ts`
 *
 * This file is provider-agnostic: the interface, the typed decisions, the branch
 * naming, the PR body, and the orchestration in `openPullRequest` that decides
 * between opening, degrading and deferring. `github.ts` is the only concrete
 * implementation and holds every GitHub-specific URL and response shape. Nothing
 * here imports an implementation, so adding GitLab later is a new file plus one
 * case, not a rewrite of the policy.
 */

import type { ProviderErrorType } from "../contracts/index.js";
import type { GitIdentity } from "../contracts/agent.js";

// ---------------------------------------------------------------------------
// Exhaustiveness
// ---------------------------------------------------------------------------

/**
 * The `never` assertion that turns "somebody added a variant" into a compile
 * error at every decision point instead of a silent fallthrough at runtime.
 *
 * Every switch on a closed set in `src/git/` ends in a call to this and has **no
 * `default` branch**. A `default` is what makes adding a status safe to forget:
 * the compiler stays quiet, and the new status quietly takes whatever behaviour
 * the default happened to have — which for an authority check is usually "allow".
 */
export function assertNever(value: never, context: string): never {
	throw new Error(
		`${context}: unhandled variant ${JSON.stringify(value)}. A member was added to a closed `
			+ "set without updating this switch. This is a bug in Harbor, not in your configuration.",
	);
}

// ---------------------------------------------------------------------------
// Settings that belong in src/config.ts
// ---------------------------------------------------------------------------

/**
 * Tunables this module needs which are **not yet in `SETTINGS`**.
 *
 * `src/config.ts` is owned elsewhere and is off limits to this change, so these
 * live here temporarily under exactly the same discipline it enforces: resolved
 * at the point of use rather than hoisted to a module constant, every default
 * carrying the derivation that justifies it. They should be moved into `SETTINGS`
 * verbatim — the final report says so — after which this block deletes and
 * callers switch to `setting()` with no behavioural change.
 *
 * Resolving at call time rather than at import is the same rule for the same
 * reason: a module-level read is captured before a test can set the variable,
 * which silently makes every timeout in the suite the production default.
 */
interface PendingSetting<T> {
	env: string;
	fallback: T;
	derivation: string;
	parse: (raw: string) => T;
}

const asInt = (raw: string): number => {
	const value = Number(raw);
	if (!Number.isFinite(value) || !Number.isInteger(value)) {
		throw new ScmConfigError(`expected an integer, got ${JSON.stringify(raw)}`);
	}
	return value;
};

const asString = (raw: string): string => raw;

export class ScmConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ScmConfigError";
	}
}

export const PENDING_SETTINGS = {
	scmProvider: {
		env: "SCM_PROVIDER",
		fallback: "github",
		derivation:
			"One source-control provider per deployment. Not per repository: a deployment "
			+ "that mixes providers needs two OAuth apps, two credential brokers and two "
			+ "webhook verifiers, and every one of those is a place where a half-working "
			+ "second provider silently degrades attribution. Anything other than `github` "
			+ "is refused with a typed error rather than served by a stub.",
		parse: asString,
	} satisfies PendingSetting<string>,

	scmHost: {
		env: "SCM_HOST",
		fallback: "github.com",
		derivation:
			"The one host git credentials are ever brokered for. GitHub Enterprise Server "
			+ "deployments set their own hostname here. It is an allow-list of exactly one "
			+ "entry because a credential helper that answers for any host it is asked "
			+ "about will happily hand an installation token to `evil.example.com` the "
			+ "first time a repository contains a submodule pointing there.",
		parse: asString,
	} satisfies PendingSetting<string>,

	scmRequestTimeoutMs: {
		env: "HARBOR_SCM_REQUEST_TIMEOUT_MS",
		fallback: 10_000,
		derivation:
			"One API call to the source-control host. Ten seconds is far beyond GitHub's "
			+ "p99 and still short enough that a hung connection does not hold a request "
			+ "handler — or a sandbox's `git push` — open until something else times out "
			+ "first and reports a misleading error.",
		parse: asInt,
	} satisfies PendingSetting<number>,

	scmRepoAccessCacheMs: {
		env: "HARBOR_SCM_REPO_ACCESS_CACHE_MS",
		fallback: 60_000,
		derivation:
			"How long an *allowed* or *denied* repository access answer is reused. A "
			+ "minute, deliberately short: this is the check that stops one tenant "
			+ "reaching another tenant's repository through a shared App installation, and "
			+ "a long cache means a revoked collaborator keeps their access for the length "
			+ "of the cache. Indeterminate answers are never cached at all — caching one "
			+ "turns a single upstream blip into a minute of sticky denial.",
		parse: asInt,
	} satisfies PendingSetting<number>,

	scmTokenRefreshSkewMs: {
		env: "HARBOR_SCM_TOKEN_REFRESH_SKEW_MS",
		fallback: 300_000,
		derivation:
			"How long before its stated expiry a user access token is refreshed. Five "
			+ "minutes covers clock skew between us and the provider plus a request that "
			+ "is already in flight when the token turns over. Refreshing exactly at "
			+ "expiry means the PR-opening call — the last step of a long session — is the "
			+ "one that fails, which is the worst possible moment to lose a credential.",
		parse: asInt,
	} satisfies PendingSetting<number>,

	gitCredentialTtlMs: {
		env: "HARBOR_GIT_CREDENTIAL_TTL_MS",
		fallback: 600_000,
		derivation:
			"The refresh deadline Harbor reports with a brokered git credential. Ten "
			+ "minutes: comfortably longer than any single `git push`, far shorter than "
			+ "the one hour a GitHub installation token actually lives. The gap is the "
			+ "point — the sandbox is told to come back long before the underlying token "
			+ "dies, so a long session never discovers an expired credential at the "
			+ "moment the agent is finally ready to push.",
		parse: asInt,
	} satisfies PendingSetting<number>,

	gitBotName: {
		env: "HARBOR_GIT_BOT_NAME",
		fallback: "Harbor",
		derivation:
			"The committer on every commit an agent makes. Distinct from the author on "
			+ "purpose: the human authored the change, the platform committed it, and a "
			+ "reader of `git log --format=full` can tell those apart six months later.",
		parse: asString,
	} satisfies PendingSetting<string>,

	gitBotEmail: {
		env: "HARBOR_GIT_BOT_EMAIL",
		fallback: "harbor[bot]@users.noreply.github.com",
		derivation:
			"A noreply address by default, so the committer line does not resolve to a "
			+ "real person's account and inflate somebody's contribution graph with work "
			+ "they did not commit.",
		parse: asString,
	} satisfies PendingSetting<string>,
} as const;

export type PendingSettingKey = keyof typeof PENDING_SETTINGS;

export function scmSetting<K extends PendingSettingKey>(
	key: K,
): (typeof PENDING_SETTINGS)[K]["fallback"] {
	const spec = PENDING_SETTINGS[key];
	const raw = process.env[spec.env];
	if (raw !== undefined && raw !== "") {
		try {
			return spec.parse(raw) as (typeof PENDING_SETTINGS)[K]["fallback"];
		} catch (error) {
			throw new ScmConfigError(`${spec.env}: ${(error as Error).message}.`);
		}
	}
	return spec.fallback as (typeof PENDING_SETTINGS)[K]["fallback"];
}

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

/**
 * The providers this closed set can name. Only `github` is implemented, and the
 * others are here so that asking for one produces a typed refusal that names the
 * provider rather than a `TypeError` three layers down.
 */
export const SCM_PROVIDERS = ["github", "gitlab", "bitbucket"] as const;
export type ScmProviderId = (typeof SCM_PROVIDERS)[number];

export type ScmProviderResolution =
	| { ok: true; id: ScmProviderId }
	| {
			ok: false;
			reason: "provider_not_implemented" | "provider_unknown";
			requested: string;
			message: string;
	  };

/**
 * Resolve `SCM_PROVIDER` to an implemented provider, or refuse in a way an
 * operator can act on.
 *
 * A half-working stub is the failure this prevents. The tempting shape is a
 * GitLab class whose `createPullRequest` throws and whose `pushUrl` works, which
 * means a deployment configured for GitLab boots, clones, runs an agent, pushes a
 * branch, spends money — and only then discovers that the one step the product
 * exists for is unimplemented. Refusing at selection time costs the operator one
 * clear error before anything has been provisioned.
 */
export function resolveScmProviderId(requested?: string): ScmProviderResolution {
	const raw = (requested ?? scmSetting("scmProvider")).trim().toLowerCase();

	if (!(SCM_PROVIDERS as readonly string[]).includes(raw)) {
		return {
			ok: false,
			reason: "provider_unknown",
			requested: raw,
			message:
				`SCM_PROVIDER is set to ${JSON.stringify(raw)}, which is not a source-control `
				+ `provider Harbor knows about. Supported values: ${SCM_PROVIDERS.join(", ")}.`,
		};
	}

	const id = raw as ScmProviderId;
	switch (id) {
		case "github":
			return { ok: true, id };
		case "gitlab":
		case "bitbucket":
			return {
				ok: false,
				reason: "provider_not_implemented",
				requested: id,
				message:
					`SCM_PROVIDER=${id} is named but not implemented in this build. Harbor refuses `
					+ "here rather than shipping a partial provider, because a partial provider "
					+ "boots a sandbox, runs an agent and pushes a branch before failing at the "
					+ "one step — opening an attributed pull request — that the product exists "
					+ "for. Set SCM_PROVIDER=github, or implement the ScmProvider interface in "
					+ `src/git/${id}.ts.`,
			};
	}
	return assertNever(id, "resolveScmProviderId");
}

// ---------------------------------------------------------------------------
// Repository identity
// ---------------------------------------------------------------------------

export interface RepoRef {
	provider: ScmProviderId;
	owner: string;
	name: string;
	/** Defaults to the deployment's configured SCM host. */
	host?: string;
}

/** Encode a git ref for a URL path without mangling the slashes inside it. */
export function encodeRefForUrl(ref: string): string {
	return ref
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
}

// ---------------------------------------------------------------------------
// Repository access — the multi-tenancy check
// ---------------------------------------------------------------------------

/**
 * Permission levels, weakest first. The order **is** the comparison.
 */
export const REPO_PERMISSIONS = ["read", "triage", "write", "maintain", "admin"] as const;
export type RepoPermission = (typeof REPO_PERMISSIONS)[number];

export function permissionAtLeast(have: RepoPermission, need: RepoPermission): boolean {
	return REPO_PERMISSIONS.indexOf(have) >= REPO_PERMISSIONS.indexOf(need);
}

/** Why a repository is definitely not available to this user. */
export const REPO_ACCESS_DENIALS = [
	/** GitHub answers 404 for a private repository the caller cannot see. */
	"not_found_or_no_access",
	"forbidden",
	/** The org enforces SAML and this token has not been authorised for it. */
	"sso_authorization_required",
	"token_invalid",
	"insufficient_permission",
] as const;
export type RepoAccessDenial = (typeof REPO_ACCESS_DENIALS)[number];

/**
 * Why the answer is *unknown*. Kept rigorously separate from denial.
 *
 * "Denied" and "could not determine" are different facts with different correct
 * responses, and collapsing them has exactly two outcomes, both bad: treat
 * unknown as allowed and a five-second upstream blip is a cross-tenant hole;
 * treat unknown as denied *inside the provider* and callers lose the ability to
 * tell an outage from a permission problem in their logs and their error
 * messages. So the provider reports the distinction faithfully and
 * `enforceRepoAccess` — the authority decision — is the single place that
 * collapses it, deliberately, to deny.
 */
export const REPO_ACCESS_INDETERMINACIES = [
	"upstream_unavailable",
	"upstream_timeout",
	"malformed_response",
	/** 200 OK with no `permissions` object: access is real, its level is not stated. */
	"permission_unreported",
	"rate_limited",
] as const;
export type RepoAccessIndeterminacy = (typeof REPO_ACCESS_INDETERMINACIES)[number];

export type RepoAccess =
	| { decision: "allowed"; permission: RepoPermission; checked_at: string }
	| { decision: "denied"; reason: RepoAccessDenial; status: number | null; detail: string }
	| {
			decision: "indeterminate";
			reason: RepoAccessIndeterminacy;
			status: number | null;
			detail: string;
	  };

// ---------------------------------------------------------------------------
// Listing repositories — a capability, not a fifth interface member
// ---------------------------------------------------------------------------

/**
 * One repository as a picker needs it.
 *
 * `permission` is nullable and that nullability is load-bearing: GitHub omits
 * the `permissions` object on some listing responses, and inventing `read` for a
 * missing one would offer a repository the user cannot push to. A null renders
 * as "permission not reported" and the real check still happens at connect time
 * against `verifyRepoAccess`, which fails closed. The list is a convenience; it
 * is never the authority.
 */
export interface RepoSummary {
	owner: string;
	name: string;
	default_branch: string;
	description: string | null;
	private: boolean;
	permission: RepoPermission | null;
}

export type RepoListing =
	| {
			kind: "listed";
			repositories: RepoSummary[];
			/**
			 * True when the host had more than Harbor asked for. Stated rather than
			 * hidden: a silently truncated list reads as "these are all my repos",
			 * and the person whose repository is missing concludes Harbor cannot see
			 * it and gives up.
			 */
			truncated: boolean;
	  }
	| { kind: "unavailable"; reason: RepoAccessIndeterminacy | RepoAccessDenial; detail: string };

/**
 * Providers that can enumerate what a user can see.
 *
 * A separate interface discovered by a type guard, not a sixth member of
 * `ScmProvider` and emphatically not a `capabilities.canList` boolean. Nothing
 * ties a boolean to a method: a provider that sets the flag and forgets the
 * function compiles, and the picker comes back empty on a deployment that has no
 * idea why. Here, `listRepositories` does not exist on the type unless
 * `listsRepositories` is `true`, so the compiler is what enforces the pairing.
 */
export interface RepoListingProvider {
	readonly listsRepositories: true;
	listRepositories(userToken: string, options?: { limit?: number }): Promise<RepoListing>;
}

export function listsRepositories(
	provider: ScmProvider,
): provider is ScmProvider & RepoListingProvider {
	return (provider as Partial<RepoListingProvider>).listsRepositories === true;
}

export type RepoAuthorisation =
	| { decision: "allow"; permission: RepoPermission }
	| {
			decision: "deny";
			cause:
				| { kind: "denied"; reason: RepoAccessDenial }
				| { kind: "indeterminate"; reason: RepoAccessIndeterminacy };
			message: string;
	  };

/**
 * Turn an access answer into an authority decision. **Fails CLOSED.**
 *
 * This closes the multi-tenancy hole that a shared App installation creates. The
 * installation reaches every repository it is installed on, so authorising
 * against *it* means any user of the deployment can start a session on any
 * repository in the org — including ones they have never been granted access to,
 * and the deployment looks correct right up until someone notices. The check has
 * to be made against *the user's own token*,
 * because that is the only credential that encodes what that particular human is
 * allowed to see.
 *
 * Note the asymmetry with liveness, and it is deliberate at both ends:
 *
 *   - **Authority fails closed** — here. An unreadable answer denies. Being told
 *     "try again" because GitHub was down for five seconds is an annoyance; being
 *     admitted to somebody else's repository because GitHub was down for five
 *     seconds is the breach this function exists to prevent.
 *   - **Liveness fails open** — see `sandboxLiveness` in `src/git/credentials.ts`
 *     and `DEAD_SANDBOX_STATUSES` in `src/contracts/index.ts`. An unknown sandbox
 *     status reads as *live*, because wrongly declaring a running box dead throws
 *     away work that was demonstrably fine.
 *
 * The two rules point in opposite directions on purpose. Anyone who "fixes" one
 * to match the other has broken something.
 */
export function enforceRepoAccess(access: RepoAccess, required: RepoPermission): RepoAuthorisation {
	switch (access.decision) {
		case "allowed":
			if (permissionAtLeast(access.permission, required)) {
				return { decision: "allow", permission: access.permission };
			}
			return {
				decision: "deny",
				cause: { kind: "denied", reason: "insufficient_permission" },
				message:
					`This account can read the repository but holds ${access.permission} access, `
					+ `and ${required} is required. Harbor will not start a session it cannot push `
					+ "from — the failure would otherwise surface half an hour later as a rejected "
					+ "push, after the work was already done.",
			};
		case "denied":
			return {
				decision: "deny",
				cause: { kind: "denied", reason: access.reason },
				message:
					`Access to this repository was refused (${access.reason}). ${access.detail} `
					+ "Harbor checks repository access with the requesting user's own credentials, "
					+ "not with the app installation, so being able to see a repository in Harbor "
					+ "never grants more than the person already had on the source-control host.",
			};
		case "indeterminate":
			return {
				decision: "deny",
				cause: { kind: "indeterminate", reason: access.reason },
				message:
					`Harbor could not determine whether this account may use the repository `
					+ `(${access.reason}). ${access.detail} This is refused rather than allowed: an `
					+ "unreadable authorisation answer is not permission. Retry once the source-"
					+ "control host is answering again — nothing has been provisioned and nothing "
					+ "was charged.",
			};
	}
	return assertNever(access, "enforceRepoAccess");
}

// ---------------------------------------------------------------------------
// Branch naming
// ---------------------------------------------------------------------------

export class GitAttributionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GitAttributionError";
	}
}

/** The prefix every branch Harbor creates carries. Also the parser's anchor. */
export const HARBOR_BRANCH_PREFIX = "harbor/lse_";

/**
 * `harbor/lse_<claim_id>` — the branch name, derived from the lease it was
 * created under.
 *
 * This is load-bearing, not cosmetic. Every git artifact in a repository that
 * Harbor touched traces back to exactly one row in `claims` with **zero
 * inference**: no timestamp correlation, no "the only session running that
 * afternoon", no guessing from the commit author. Somebody asking "why does this
 * branch exist and who authorised it" reads the claim id out of the branch name
 * and gets the intent, the holder, the lease window and the cost rows attributed
 * to it. A name like `harbor/fix-login-bug` cannot answer any of that, and the
 * question is always asked long after the session's UI has scrolled away.
 *
 * Derived **lazily, at PR-creation time**. Baking it into spawn configuration
 * means the branch name is fixed before the lease it names is necessarily still
 * held: a spawn that is retried under a new lease would push to the old lease's
 * branch, and the ledger row the name points at would describe different work
 * than the branch contains.
 */
export function harborBranchName(claimId: string): string {
	const id = claimId.trim();

	// A claim id comes from our own database, so anything else is a programming
	// error rather than user input — but it is a programming error that would put
	// an attacker-influenced string into a shell-adjacent git ref, so it is caught
	// here rather than trusted. Git ref rules plus the characters that make a ref
	// ambiguous with a path or an option.
	if (!/^[0-9a-fA-F-]{8,36}$/.test(id) || id.includes("--") || id.startsWith("-")) {
		throw new GitAttributionError(
			`Refusing to build a branch name from ${JSON.stringify(claimId)}: a claim id is a `
				+ "UUID or a hex prefix of one. A branch name is a git ref and ends up in argv, so "
				+ "Harbor will not interpolate an unvalidated string into one.",
		);
	}

	return `${HARBOR_BRANCH_PREFIX}${id.toLowerCase()}`;
}

/**
 * The inverse. Exists so the traceability claim above is verifiable rather than
 * aspirational: given any branch in a repository, either it is Harbor's and names
 * its lease, or it is not Harbor's at all.
 */
export function parseHarborBranch(branch: string): { claim_id: string } | null {
	if (!branch.startsWith(HARBOR_BRANCH_PREFIX)) return null;
	const claimId = branch.slice(HARBOR_BRANCH_PREFIX.length);
	if (!/^[0-9a-f-]{8,36}$/.test(claimId)) return null;
	return { claim_id: claimId };
}

// ---------------------------------------------------------------------------
// Commit identity — the half of attribution that does NOT come from a token
// ---------------------------------------------------------------------------

export interface BotIdentity {
	name: string;
	email: string;
}

export function harborBotIdentity(): BotIdentity {
	return { name: scmSetting("gitBotName"), email: scmSetting("gitBotEmail") };
}

export interface CommitIdentity {
	author_name: string;
	author_email: string;
	committer_name: string;
	committer_email: string;
}

/**
 * The author/committer split, as git environment variables.
 *
 * Read this next to `createPullRequest` and notice that they share no inputs.
 * The commit author comes from the prompting human's `GitIdentity`; the committer
 * is always Harbor; the credential used to push is a brokered installation token
 * that appears in neither. A reviewer looking at `git log --format=full` sees who
 * asked for the change and that a machine made it, which are two different facts
 * and both are true.
 *
 * `agent-only` is an explicit mode for work nobody is claiming authorship of — a
 * scheduled dependency bump — and it is *not* the fallback for "we could not
 * work out who asked". `attributedIdentity()` in `src/contracts/agent.ts` raises
 * rather than guessing, for the reason written there: a guessed author makes the
 * repository history lie.
 */
export function commitIdentity(identity: GitIdentity, bot: BotIdentity): CommitIdentity {
	switch (identity.mode) {
		case "attributed-user":
			return {
				author_name: identity.name,
				author_email: identity.email,
				committer_name: bot.name,
				committer_email: bot.email,
			};
		case "agent-only":
			return {
				author_name: bot.name,
				author_email: bot.email,
				committer_name: bot.name,
				committer_email: bot.email,
			};
	}
	return assertNever(identity, "commitIdentity");
}

/**
 * The same thing as environment variables, which is how it reaches git.
 *
 * `git config user.name` is deliberately not used: config is per-clone state that
 * survives between turns, so a session where two people take turns prompting
 * would attribute the second person's commits to the first until something
 * happened to rewrite the file. The environment is per-process and cannot leak
 * across turns.
 */
export function commitEnv(identity: GitIdentity, bot: BotIdentity): Record<string, string> {
	const who = commitIdentity(identity, bot);
	return {
		GIT_AUTHOR_NAME: who.author_name,
		GIT_AUTHOR_EMAIL: who.author_email,
		GIT_COMMITTER_NAME: who.committer_name,
		GIT_COMMITTER_EMAIL: who.committer_email,
	};
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

export interface CreatePullRequestInput {
	repo: RepoRef;
	/** The branch the sandbox pushed. `harbor/lse_<claim_id>`. */
	head: string;
	base: string;
	title: string;
	body: string;
	draft?: boolean;
	/**
	 * The prompting human's OAuth token. Required, never optional, never
	 * defaulted to an installation token. See the header of this file.
	 */
	author_token: string;
	/**
	 * Who the resulting PR must be authored by. Checked against what the API
	 * actually returns, so a bug that passes the wrong token is caught by the
	 * response rather than by an auditor months later.
	 */
	expected_author_login: string;
}

export type PullRequestOutcome =
	| {
			kind: "created";
			url: string;
			number: number;
			author_login: string;
			/** Always `user`. There is no other value; the type documents the invariant. */
			attribution: "prompting_user";
	  }
	| {
			kind: "adopted";
			url: string;
			number: number;
			author_login: string;
			attribution: "prompting_user";
			reason: "already_open";
	  }
	/** The branch is pushed and nothing was opened. The warning names what was lost. */
	| {
			kind: "degraded";
			compare_url: string;
			reason: ScmIdentityGap;
			warning: string;
	  }
	/** Could not tell whether an identity exists. Retryable; deliberately not degraded. */
	| {
			kind: "deferred";
			compare_url: string;
			reason: ScmIdentityIndeterminacy;
			message: string;
	  }
	/** The PR exists but was authored by somebody other than the requester. */
	| {
			kind: "attribution_mismatch";
			url: string;
			number: number;
			expected_login: string;
			actual_login: string;
			message: string;
	  }
	| { kind: "failed"; error_type: ProviderErrorType; message: string };

export type InstallationTokenResult =
	| { kind: "minted"; token: string; expires_at: string }
	| { kind: "unavailable"; reason: InstallationTokenGap; message: string }
	| { kind: "failed"; error_type: ProviderErrorType; message: string };

export const INSTALLATION_TOKEN_GAPS = [
	"app_not_configured",
	"installation_not_found",
	"installation_suspended",
] as const;
export type InstallationTokenGap = (typeof INSTALLATION_TOKEN_GAPS)[number];

/** What an installation token is narrowed to before it is handed out. */
export interface InstallationTokenScope {
	/** Repository names — not `owner/name` — the token may touch. */
	repositories: string[];
	permissions: Record<string, "read" | "write">;
}

/**
 * One source-control provider. Five members, and each is a distinct trust level.
 *
 * `pushUrl` and `compareUrl` are pure string builders and carry no credential —
 * see the note on `pushUrl` in `github.ts` for why a token must never appear in
 * a remote URL.
 */
export interface ScmProvider {
	readonly id: ScmProviderId;
	readonly host: string;

	/** With the prompting human's token. Never with the app's. */
	createPullRequest(input: CreatePullRequestInput): Promise<PullRequestOutcome>;

	/** Credential-free HTTPS remote. The credential helper supplies auth per operation. */
	pushUrl(repo: RepoRef): string;

	compareUrl(repo: RepoRef, base: string, head: string): string;

	/** Against the user's own token. The multi-tenancy check; fails closed. */
	verifyRepoAccess(userToken: string, owner: string, name: string): Promise<RepoAccess>;

	/** Short-lived, repo-scoped, for the sandbox to push with. Never opens a PR. */
	installationToken(
		installationId: string,
		scope?: InstallationTokenScope,
	): Promise<InstallationTokenResult>;
}

// ---------------------------------------------------------------------------
// Identity gaps — and the warning nobody is allowed to bury
// ---------------------------------------------------------------------------

/**
 * Reasons there is definitely no user token to author a PR with. Terminal until
 * a human does something (connects an identity, re-authorises the app).
 */
export const SCM_IDENTITY_GAPS = [
	/** Signed in through SSO, never connected a source-control account. */
	"no_scm_identity",
	/** The deployment has no SCM OAuth app configured at all. */
	"deployment_has_no_scm_oauth",
	"token_revoked",
	"refresh_token_expired",
	/** The stored token expired and there is no refresh token to renew it with. */
	"token_expired_no_refresh",
] as const;
export type ScmIdentityGap = (typeof SCM_IDENTITY_GAPS)[number];

/**
 * Reasons we *could not tell* whether a user token exists or is valid. Separate
 * from the gaps above because they must not produce the degradation path: a
 * provider outage is not the same fact as "this human has no GitHub account",
 * and quietly treating it as one permanently strips a PR of its attribution over
 * a blip that lasted ten seconds.
 */
export const SCM_IDENTITY_INDETERMINACIES = [
	"refresh_upstream_unavailable",
	"refresh_upstream_timeout",
	"stored_token_undecryptable",
	"storage_unavailable",
] as const;
export type ScmIdentityIndeterminacy = (typeof SCM_IDENTITY_INDETERMINACIES)[number];

export type PrAuthority =
	| { kind: "user"; token: string; login: string }
	| { kind: "absent"; reason: ScmIdentityGap; detail?: string }
	| { kind: "indeterminate"; reason: ScmIdentityIndeterminacy; detail: string };

/**
 * The sentence, verbatim, that every degradation message must contain.
 *
 * It is a named export because it is the thing the tests assert on and the thing
 * a reviewer of this file should be able to find in one grep. The property is
 * stated in plain language — not "attribution is reduced", which means nothing to
 * the person reading a Slack notification — because the failure this guards
 * against is an organisation standardising on non-SCM SSO and losing the central
 * guarantee of the product without anybody noticing. Documentation is where that
 * notice goes to die.
 */
export const SELF_APPROVAL_LOST_SENTENCE =
	"this PR was opened by the Harbor bot, so the requesting user is able to approve it; "
	+ "the self-approval guarantee does not hold for this pull request";

function describeIdentityGap(reason: ScmIdentityGap): string {
	switch (reason) {
		case "no_scm_identity":
			return (
				"the requesting user has no source-control identity connected — they signed in "
				+ "through SSO and never linked an account"
			);
		case "deployment_has_no_scm_oauth":
			return (
				"this deployment has no source-control OAuth app configured, so no user can have "
				+ "an identity to author with"
			);
		case "token_revoked":
			return "the requesting user's source-control token has been revoked";
		case "refresh_token_expired":
			return "the requesting user's refresh token has expired and they must sign in again";
		case "token_expired_no_refresh":
			return (
				"the requesting user's stored token has expired and no refresh token was stored "
				+ "with it"
			);
	}
	return assertNever(reason, "describeIdentityGap");
}

/**
 * The use-time warning. Loud, specific, and it names the lost property.
 *
 * Note what it does **not** say: it does not say the PR was opened anyway. Harbor
 * did not open it — that is the whole point — and the sentence about the bot
 * describes the property that would be lost *if it had*, which is what makes the
 * cost legible to somebody who is deciding whether to connect their account.
 */
export function attributionWarning(input: {
	reason: ScmIdentityGap;
	requested_by: string;
	repo: RepoRef;
	head: string;
	compare_url: string;
}): string {
	return (
		`Harbor did not open a pull request for ${input.repo.owner}/${input.repo.name} `
		+ `(${input.head}), because ${describeIdentityGap(input.reason)}. The branch has been `
		+ `pushed and can be opened by hand: ${input.compare_url}\n\n`
		+ "Harbor will not open it with the app's own credentials, and this is why: "
		+ `${SELF_APPROVAL_LOST_SENTENCE}. Opening the pull request as ${input.requested_by} is `
		+ "what makes it impossible for them to approve their own agent's changes. Connect a "
		+ "source-control identity for that account to restore the guarantee."
	);
}

/**
 * The startup warning, for a deployment with no SCM OAuth configured at all.
 *
 * Emitted once at boot rather than only at first use, because the first use is
 * six weeks after the deployment was set up, by which point the person who
 * configured it has moved on and the missing property looks like how Harbor has
 * always worked.
 */
export function startupAttributionWarning(configured: boolean): string | null {
	if (configured) return null;
	return (
		"[harbor:scm] No source-control OAuth app is configured "
		+ "(SCM_PROVIDER/GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET). Harbor can still clone, run "
		+ "agents and push branches, but it cannot open a pull request as the human who asked "
		+ "for the work, so every session will fall back to handing back a compare URL.\n"
		+ "  The property this costs, stated plainly: if a pull request were opened with "
		+ `Harbor's own credentials instead, ${SELF_APPROVAL_LOST_SENTENCE}. Harbor refuses to `
		+ "do that, so pull requests will simply not be opened automatically until an OAuth "
		+ "app is configured and users connect their accounts."
	);
}

// ---------------------------------------------------------------------------
// The PR body
// ---------------------------------------------------------------------------

export interface PullRequestBodyInput {
	/** `claims.intent` — the claimant's own words, reproduced verbatim. */
	intent: string | null;
	/** `claims.intent_ref` — a spec, thread or issue backing the intent. */
	intent_ref: string | null;
	claim_id: string;
	session_key: string | null;
	session_url: string | null;
	agent_id: string | null;
	/** The human whose token opened this PR, for the line that says so. */
	opened_by: string;
	/** As it will appear in `git log`. Author and committer are different people. */
	commit_identity: CommitIdentity;
}

/**
 * The PR body, carrying the claim's `intent` **verbatim**.
 *
 * Verbatim is a requirement, not a nicety, and it is why the intent is emitted as
 * its own top-level block with nothing prepended to its lines. The obvious
 * alternatives all corrupt it: a blockquote prefixes `> ` to every line, so a
 * fenced code block inside an intent stops being one; reflowing to a width breaks
 * pasted stack traces; truncating loses the sentence that explained the
 * exception. The intent is the answer to "why does this change exist", asked six
 * months later by somebody deciding whether it can be reverted, and a paraphrase
 * is not an answer.
 *
 * The attribution footer is emitted for the reviewer, not for us: it states that
 * the author of the commits and the committer are different identities, so that
 * a reviewer who notices the bot in `git log` does not conclude the change is
 * unattributed.
 */
export function pullRequestBody(input: PullRequestBodyInput): string {
	const lines: string[] = [];

	lines.push("### Why this work was started");
	lines.push("");
	if (input.intent?.trim()) {
		// Verbatim. No trimming of interior whitespace, no prefixes, no wrapping.
		lines.push(input.intent);
	} else {
		lines.push(
			"_No intent was recorded on the lease this branch was created under._ "
				+ "Harbor does not invent one: an intent nobody wrote is worse than a missing "
				+ "intent, because it reads as though somebody did.",
		);
	}
	lines.push("");

	if (input.intent_ref?.trim()) {
		lines.push(`Backing reference: ${input.intent_ref.trim()}`);
		lines.push("");
	}

	lines.push("---");
	lines.push("");
	lines.push("### Provenance");
	lines.push("");
	lines.push(`- Lease: \`${input.claim_id}\` (branch \`${harborBranchName(input.claim_id)}\`)`);
	if (input.session_key) {
		const session = input.session_url
			? `[${input.session_key}](${input.session_url})`
			: `\`${input.session_key}\``;
		lines.push(`- Harbor session: ${session}`);
	}
	if (input.agent_id) lines.push(`- Agent: \`${input.agent_id}\``);
	lines.push(
		`- Commits are authored by \`${input.commit_identity.author_name} `
			+ `<${input.commit_identity.author_email}>\` and committed by `
			+ `\`${input.commit_identity.committer_name} `
			+ `<${input.commit_identity.committer_email}>\`.`,
	);
	lines.push(
		`- This pull request was opened with ${input.opened_by}'s own credentials, which is `
			+ "why they cannot approve it. That is deliberate: it is what makes unreviewed agent "
			+ "code structurally impossible rather than a rule somebody has to remember.",
	);

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface OpenPullRequestInput {
	repo: RepoRef;
	base: string;
	title: string;
	claim: { id: string; intent: string | null; intent_ref: string | null };
	session: { key: string; url: string | null } | null;
	agent_id: string | null;
	/** Display handle of the person the work was done for. Appears in the warning. */
	requested_by: string;
	commit_identity: CommitIdentity;
	draft?: boolean;
	/**
	 * The branch the sandbox reported pushing. Omitted, it is derived from the
	 * claim — lazily, here, which is the only place that knows the lease is still
	 * the one the work was done under.
	 */
	head?: string;
}

/**
 * Open the pull request, or fail in the one of three ways that tells the truth.
 *
 * The switch on `authority` has no `default`, and the three arms are genuinely
 * different outcomes rather than three shades of failure:
 *
 *   - `user`     → open it as them. The normal path.
 *   - `absent`   → do not open it. Hand back a compare URL and a warning that
 *                  names the lost property. Terminal until a human acts.
 *   - `indeterminate` → do not open it and do not warn as though the identity
 *                  were missing, because we do not know that. Retryable.
 *
 * Merging the last two is the tempting simplification and it is exactly what
 * turns a ten-second provider outage into a permanent, silent downgrade of the
 * product's central guarantee.
 */
export async function openPullRequest(
	provider: ScmProvider,
	authority: PrAuthority,
	input: OpenPullRequestInput,
): Promise<PullRequestOutcome> {
	const head = input.head ?? harborBranchName(input.claim.id);
	const compareUrl = provider.compareUrl(input.repo, input.base, head);

	switch (authority.kind) {
		case "absent": {
			const warning = attributionWarning({
				reason: authority.reason,
				requested_by: input.requested_by,
				repo: input.repo,
				head,
				compare_url: compareUrl,
			});
			// Loud at use time as well as in the returned outcome. A caller that
			// forgets to surface the outcome's warning still leaves a trace an
			// operator can find, which is the difference between a degraded
			// guarantee somebody notices and one nobody does.
			console.warn(`[harbor:scm] ${warning}`);
			return { kind: "degraded", compare_url: compareUrl, reason: authority.reason, warning };
		}
		case "indeterminate": {
			const message =
				`Harbor could not establish the requesting user's source-control identity `
				+ `(${authority.reason}: ${authority.detail}), so it has not opened a pull request `
				+ `for ${head}. This is not the same as having no identity: nothing has been `
				+ "downgraded and the pull request can be opened attributed once the source-control "
				+ `host is answering again. The branch is pushed: ${compareUrl}`;
			console.warn(`[harbor:scm] ${message}`);
			return {
				kind: "deferred",
				compare_url: compareUrl,
				reason: authority.reason,
				message,
			};
		}
		case "user":
			return provider.createPullRequest({
				repo: input.repo,
				head,
				base: input.base,
				title: input.title,
				body: pullRequestBody({
					intent: input.claim.intent,
					intent_ref: input.claim.intent_ref,
					claim_id: input.claim.id,
					session_key: input.session?.key ?? null,
					session_url: input.session?.url ?? null,
					agent_id: input.agent_id,
					opened_by: `@${authority.login}`,
					commit_identity: input.commit_identity,
				}),
				draft: input.draft,
				author_token: authority.token,
				expected_author_login: authority.login,
			});
	}
	return assertNever(authority, "openPullRequest");
}
