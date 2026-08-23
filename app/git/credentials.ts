// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Brokered git credentials, and the tokens they are never made from.
 *
 * ## Brokered, not embedded
 *
 * The sandbox holds exactly one long-lived secret: its own session token. It
 * holds no git credential at all. When git needs to authenticate, the in-sandbox
 * credential helper calls the control plane, which mints a repository-scoped
 * installation token for that one operation and hands it back with a refresh
 * deadline measured in minutes.
 *
 * The alternative — bake a token into the remote URL or the environment at boot —
 * fails in the worst possible place. A session runs for two hours. The token
 * minted at boot expired after one. The agent finishes its work, runs `git push`,
 * and the push is rejected: the credential died exactly when the agent was
 * finally ready to use it, after all the money had been spent. It also leaves the
 * token in `.git/config`, in `git remote -v`, in the process environment of every
 * command the agent runs, and therefore in the session transcript the moment git
 * prints an error.
 *
 * ## The three secrets, and which of them may cross which boundary
 *
 *   - **The refresh token** (long-lived, renews a user's access token). Never
 *     leaves the control plane. Stored encrypted with `src/lib/crypto.ts`. The
 *     sandbox has no API that can return one, which is a structural guarantee
 *     rather than a rule — `mintGitCredential` does not read the user token table
 *     at all.
 *   - **The user access token** (8 hours). Control plane only, used for exactly
 *     two things: checking that this human may use this repository, and opening a
 *     pull request as them.
 *   - **The installation token** (1 hour, scoped to one repository). The only
 *     credential a sandbox ever sees, and it is fetched per operation.
 *
 * ## Exactly one host
 *
 * A credential helper answers questions of the form "what is the password for
 * https://<host>/<path>". Git asks it for *every* host it touches, including one
 * named by a submodule inside the repository being worked on — which is
 * attacker-controlled content. A helper that answers for any host it is asked
 * about will hand an installation token to `evil.example.com` the first time
 * somebody commits a malicious `.gitmodules`. So the host check here is an
 * allow-list with exactly one entry, matched exactly, and it runs before anything
 * else.
 */

import { and, eq } from "drizzle-orm";
import {
	DEAD_SANDBOX_STATUSES,
	SANDBOX_STATUSES,
	type ProviderErrorType,
	type SandboxStatus,
} from "../contracts/index.js";
import { db } from "@core/schema/index.js";
import { repos, sandboxes, sessionRepos, userScmTokens } from "@core/schema/schema.js";
import { CryptoError, decrypt, encrypt } from "../lib/crypto.js";
import { type FetchLike, createScmProvider, looksLikeRefreshToken } from "./github.js";
import {
	type InstallationTokenScope,
	type PrAuthority,
	type ScmIdentityGap,
	type ScmIdentityIndeterminacy,
	type ScmProvider,
	type ScmProviderId,
	assertNever,
	scmSetting,
	startupAttributionWarning,
} from "./provider.js";

// ---------------------------------------------------------------------------
// Host authorisation
// ---------------------------------------------------------------------------

export const GIT_HOST_REFUSALS = [
	"host_not_configured_scm_host",
	"scheme_not_https",
	"host_malformed",
] as const;
export type GitHostRefusal = (typeof GIT_HOST_REFUSALS)[number];

export type GitHostDecision =
	| { decision: "allowed"; host: string }
	| { decision: "refused"; reason: GitHostRefusal; message: string };

/**
 * Is this the one host Harbor brokers credentials for?
 *
 * Note the comparison: **exact equality after normalisation**, never a suffix
 * test. `host.endsWith(configured)` is the natural-looking version and it admits
 * `evilgithub.com` when the configured host is `github.com`; `host.includes()` is
 * worse still. The FQDN trailing dot (`github.com.`) and case are normalised away
 * because both resolve to the same host and neither should be a way past the
 * check.
 *
 * `http` is refused as well as `ssh`. Over plain http the brokered token would
 * cross the network in cleartext to whatever answered the DNS query, and the
 * whole point of a short-lived credential is undone by a credential that is
 * observable in flight. SSH is refused because there is nothing short-lived to
 * broker — an SSH key is a long-lived secret on disk, which is the model this
 * file exists to replace.
 */
export function authoriseGitHost(
	requested: { protocol?: string; host: string },
	configured?: string,
): GitHostDecision {
	const expected = (configured ?? scmSetting("scmHost")).trim().toLowerCase().replace(/\.$/, "");

	const protocol = (requested.protocol ?? "https").trim().toLowerCase();
	if (protocol !== "https") {
		return {
			decision: "refused",
			reason: "scheme_not_https",
			message:
				`Harbor brokers git credentials over https only, and this request was ${protocol}. `
				+ "Over http the token would cross the network in cleartext; over ssh there is no "
				+ "short-lived credential to broker at all.",
		};
	}

	const raw = requested.host.trim().toLowerCase().replace(/\.$/, "");
	if (!raw || /[^a-z0-9.\-:]/.test(raw)) {
		return {
			decision: "refused",
			reason: "host_malformed",
			message:
				`Refusing to broker a credential for ${JSON.stringify(requested.host)}: that is not `
				+ "a bare hostname. Userinfo, paths and escapes in a host are how a submodule URL "
				+ "smuggles one host past a check written for another.",
		};
	}

	const [host, port, ...rest] = raw.split(":");
	if (rest.length > 0 || !host) {
		return {
			decision: "refused",
			reason: "host_malformed",
			message: `Refusing to broker a credential for ${JSON.stringify(requested.host)}.`,
		};
	}
	if (port !== undefined && port !== "443") {
		return {
			decision: "refused",
			reason: "host_malformed",
			message:
				`Refusing to broker a credential for ${raw}: only the default https port is served. `
				+ "A non-default port on the configured host is a different endpoint, and a "
				+ "credential minted for one is not authorisation for the other.",
		};
	}

	if (host !== expected) {
		return {
			decision: "refused",
			reason: "host_not_configured_scm_host",
			message:
				`Refusing to broker a git credential for ${host}. This deployment brokers `
				+ `credentials for exactly one host (${expected}), and git asks its credential `
				+ "helper about every host it touches — including hosts named by a submodule "
				+ "inside the repository being worked on, which is attacker-controlled content. "
				+ "Answering for an unconfigured host is how an installation token leaves the "
				+ "organisation.",
		};
	}

	return { decision: "allowed", host };
}

// ---------------------------------------------------------------------------
// Sandbox liveness — the fail-OPEN half of the asymmetry
// ---------------------------------------------------------------------------

export type SandboxLiveness =
	| { state: "live"; basis: "known_status" | "unknown_status" }
	| { state: "dead"; status: SandboxStatus };

function isKnownSandboxStatus(value: string): value is SandboxStatus {
	return (SANDBOX_STATUSES as readonly string[]).includes(value);
}

/**
 * Is this sandbox still worth serving? **Fails OPEN.**
 *
 * A status this build does not recognise — because a newer control plane wrote it,
 * or because someone added one and did not redeploy every process — reads as
 * *live*. That is the recoverable direction: refusing a credential to a box that
 * is actually running loses an agent's entire session's work at the moment it
 * tries to push, with nothing in the logs to explain it, whereas serving a
 * credential to a box that has in fact stopped costs one wasted API call to a
 * host that will reject it.
 *
 * Contrast `enforceRepoAccess` in `provider.ts`, which is an **authority**
 * decision and therefore fails CLOSED: an unreadable answer there denies. The two
 * rules point in opposite directions deliberately. Making them agree — in either
 * direction — either loses live work or opens a cross-tenant hole.
 *
 * The switch is exhaustive over `SandboxStatus` with no `default`, so adding a
 * status is a compile error here; the unknown-status case above is what handles a
 * status this *binary* has never heard of, which is a different thing.
 */
export function sandboxLiveness(status: string): SandboxLiveness {
	if (!isKnownSandboxStatus(status)) return { state: "live", basis: "unknown_status" };

	switch (status) {
		case "requested":
		case "spawning":
		case "ready":
		case "busy":
		case "idle":
		case "stopping":
			return { state: "live", basis: "known_status" };
		// Must agree with DEAD_SANDBOX_STATUSES in src/contracts; `credentials.test`
		// asserts the two cannot drift apart.
		case "stopped":
		case "stale":
		case "failed":
			return { state: "dead", status };
	}
	return assertNever(status, "sandboxLiveness");
}

/** Exported so a test can prove this file and the contract still agree. */
export const DEAD_STATUSES_FOR_CREDENTIALS: readonly SandboxStatus[] = DEAD_SANDBOX_STATUSES;

// ---------------------------------------------------------------------------
// Minting
// ---------------------------------------------------------------------------

export const GIT_OPERATIONS = ["clone", "fetch", "push"] as const;
export type GitOperation = (typeof GIT_OPERATIONS)[number];

export const CREDENTIAL_REFUSALS = [
	"host_not_allowed",
	"scheme_not_https",
	"host_malformed",
	"sandbox_unknown",
	"sandbox_dead",
	"repo_not_in_session",
	"cross_org_repo",
	"installation_missing",
	"provider_not_supported",
	/** A credential came back in a shape Harbor refuses to hand to a sandbox. */
	"credential_shape_rejected",
] as const;
export type CredentialRefusal = (typeof CREDENTIAL_REFUSALS)[number];

export interface MintGitCredentialRequest {
	repo: { owner: string; name: string; host?: string; protocol?: string };
	operation: GitOperation;
}

export type GitCredentialOutcome =
	| {
			kind: "minted";
			/** GitHub's convention for an installation token used as a password. */
			username: string;
			password: string;
			/** When the *helper* must come back. Deliberately sooner than the token dies. */
			expires_at: string;
			host: string;
			repo: string;
			operation: GitOperation;
	  }
	| { kind: "refused"; reason: CredentialRefusal; message: string }
	| { kind: "failed"; error_type: ProviderErrorType; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Least privilege per operation.
 *
 * A `git fetch` gets a read-only token. Only a push gets `contents: write`, and
 * only for the one repository being pushed to. Without the split, a credential
 * leaked from a clone — the operation that runs unattended at boot, before any
 * human is watching — is a credential that can rewrite every repository the
 * installation covers.
 */
function scopeFor(operation: GitOperation, repoName: string): InstallationTokenScope {
	switch (operation) {
		case "clone":
		case "fetch":
			return { repositories: [repoName], permissions: { contents: "read" } };
		case "push":
			return { repositories: [repoName], permissions: { contents: "write" } };
	}
	return assertNever(operation, "scopeFor");
}

/**
 * Mint a credential for one sandbox, one repository, one operation.
 *
 * The order of the checks is the design. The host check is first and needs no
 * database, because it is the one that defends against content inside the
 * repository (a submodule pointing somewhere else) rather than against a
 * misconfigured caller. Then liveness — fail open. Then authority: does this
 * sandbox's session actually include this repository — fail closed.
 *
 * Note what this function never touches: `user_scm_tokens`. A sandbox cannot ask
 * for a user's credential because there is no code path from here to one. That is
 * a stronger guarantee than a check, because a check can be relaxed by somebody
 * who does not know why it was there.
 */
export async function mintGitCredential(
	sandboxId: string,
	request: MintGitCredentialRequest,
	deps: { provider?: ScmProvider; now?: () => Date } = {},
): Promise<GitCredentialOutcome> {
	const now = deps.now ?? (() => new Date());

	const hostDecision = authoriseGitHost({
		protocol: request.repo.protocol,
		host: request.repo.host ?? scmSetting("scmHost"),
	});
	if (hostDecision.decision === "refused") {
		const reason: CredentialRefusal =
			hostDecision.reason === "host_not_configured_scm_host"
				? "host_not_allowed"
				: hostDecision.reason === "scheme_not_https"
					? "scheme_not_https"
					: "host_malformed";
		return { kind: "refused", reason, message: hostDecision.message };
	}
	const host = hostDecision.host;

	// A malformed id is refused rather than passed to Postgres, which would raise
	// `invalid input syntax for type uuid` and surface as a 500 — an unauthenticated
	// caller should not be able to turn a typo into a stack trace.
	if (!UUID.test(sandboxId)) {
		return {
			kind: "refused",
			reason: "sandbox_unknown",
			message: "That sandbox id is not a sandbox id.",
		};
	}

	const sandbox = await db.query.sandboxes.findFirst({ where: eq(sandboxes.id, sandboxId) });
	// Fail CLOSED on authority: no row means we cannot establish that anybody
	// authorised this box, and "we could not find it" is not permission.
	if (!sandbox) {
		return {
			kind: "refused",
			reason: "sandbox_unknown",
			message:
				"No sandbox with that id. Harbor refuses rather than assuming a box it has no "
				+ "record of is entitled to a repository credential.",
		};
	}

	const liveness = sandboxLiveness(sandbox.status);
	if (liveness.state === "dead") {
		return {
			kind: "refused",
			reason: "sandbox_dead",
			message:
				`This sandbox is ${liveness.status}. A stopped box asking for a push credential is `
				+ "either a stale process that outlived its lease or a replay of a captured "
				+ "request; neither should be able to write to a repository.",
		};
	}

	const linked = await db
		.select({
			id: repos.id,
			orgId: repos.orgId,
			owner: repos.owner,
			name: repos.name,
			provider: repos.provider,
			installationId: repos.installationId,
		})
		.from(sessionRepos)
		.innerJoin(repos, eq(sessionRepos.repoId, repos.id))
		.where(eq(sessionRepos.sessionId, sandbox.sessionId));

	const wanted = `${request.repo.owner.toLowerCase()}/${request.repo.name.toLowerCase()}`;
	const repo = linked.find((row) => `${row.owner.toLowerCase()}/${row.name.toLowerCase()}` === wanted);

	// Fail CLOSED again, and this is the check that keeps one session out of
	// another tenant's repository: the App installation can reach every repository
	// in the organisation, so "the installation has access" is not authorisation.
	// The session's own snapshot of repositories is.
	if (!repo) {
		return {
			kind: "refused",
			reason: "repo_not_in_session",
			message:
				`This session does not include ${request.repo.owner}/${request.repo.name}. A `
				+ "credential is scoped to the repositories the session was created with, not to "
				+ "everything the app installation can see — otherwise any session could reach any "
				+ "repository in the organisation.",
		};
	}
	if (repo.orgId !== sandbox.orgId) {
		return {
			kind: "refused",
			reason: "cross_org_repo",
			message: "That repository belongs to a different organisation than the sandbox.",
		};
	}
	if (repo.provider !== ("github" satisfies ScmProviderId)) {
		return {
			kind: "refused",
			reason: "provider_not_supported",
			message: `Repository ${wanted} is on ${repo.provider}, which this build cannot broker for.`,
		};
	}
	if (!repo.installationId) {
		return {
			kind: "refused",
			reason: "installation_missing",
			message:
				`No app installation is recorded for ${wanted}, so there is nothing to mint a `
				+ "credential from. Install the Harbor GitHub App on that repository.",
		};
	}

	let provider = deps.provider;
	if (!provider) {
		const selection = createScmProvider({ host });
		if (!selection.ok) {
			return { kind: "refused", reason: "provider_not_supported", message: selection.message };
		}
		provider = selection.provider;
	}

	const minted = await provider.installationToken(
		repo.installationId,
		scopeFor(request.operation, repo.name),
	);

	switch (minted.kind) {
		case "unavailable":
			return { kind: "refused", reason: "installation_missing", message: minted.message };
		case "failed":
			return { kind: "failed", error_type: minted.error_type, message: minted.message };
		case "minted": {
			// Defence in depth on the boundary that matters most. A refresh token is
			// the long-lived credential; if one ever reached a sandbox it would
			// outlive every control we have. It cannot get here today — this function
			// never reads the user token table — and this check exists so that if a
			// future change makes it possible, the sandbox gets an error instead.
			if (looksLikeRefreshToken(minted.token)) {
				return {
					kind: "refused",
					reason: "credential_shape_rejected",
					message:
						"Refusing to hand what looks like a refresh token to a sandbox. A refresh "
						+ "token never leaves the control plane.",
				};
			}

			// The reported expiry is the helper's *refresh deadline*, not the token's
			// death. It is deliberately earlier: the sandbox comes back for a fresh
			// credential long before the underlying token expires, so a long session
			// never discovers a dead credential at the moment it finally pushes.
			const ttlDeadline = now().getTime() + scmSetting("gitCredentialTtlMs");
			const tokenDeath = Date.parse(minted.expires_at);
			const expiresAt = new Date(
				Number.isFinite(tokenDeath) ? Math.min(ttlDeadline, tokenDeath) : ttlDeadline,
			);

			return {
				kind: "minted",
				username: "x-access-token",
				password: minted.token,
				expires_at: expiresAt.toISOString(),
				host,
				repo: `${repo.owner}/${repo.name}`,
				operation: request.operation,
			};
		}
	}
	return assertNever(minted, "mintGitCredential");
}

// ---------------------------------------------------------------------------
// The user's own token — control plane only
// ---------------------------------------------------------------------------

/**
 * What is inside the encrypted envelope in `user_scm_tokens.ciphertext`.
 *
 * One JSON document rather than a column per secret, so that adding a field
 * later is not a migration that has to decrypt and rewrite every row — and so
 * that the refresh token cannot be selected on its own by a query that forgot it
 * was a secret.
 */
export interface StoredScmToken {
	access_token: string;
	/** Absent for a token that does not expire (a classic PAT, or a non-expiring app). */
	access_token_expires_at?: string;
	refresh_token?: string;
	refresh_token_expires_at?: string;
}

export type UserTokenOutcome =
	| { kind: "available"; token: string; login: string; refreshed: boolean; expires_at: string | null }
	| { kind: "absent"; reason: ScmIdentityGap; message: string }
	| { kind: "indeterminate"; reason: ScmIdentityIndeterminacy; detail: string };

export type ScmOAuthConfig =
	| { configured: true; client_id: string; client_secret: string }
	| { configured: false; missing: string[] };

export function scmOAuthConfig(): ScmOAuthConfig {
	const clientId = process.env.GITHUB_CLIENT_ID?.trim();
	const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim();
	const missing: string[] = [];
	if (!clientId) missing.push("GITHUB_CLIENT_ID");
	if (!clientSecret) missing.push("GITHUB_CLIENT_SECRET");
	if (missing.length > 0) return { configured: false, missing };
	return { configured: true, client_id: clientId!, client_secret: clientSecret! };
}

/**
 * The startup half of the loud warning.
 *
 * Called from server boot. Returns the message as well as logging it so a health
 * endpoint can show the same text — an operator who reads "attribution: degraded"
 * on a dashboard should see the same sentence, not a shorter one that leaves out
 * which property was lost.
 */
export function warnScmAttributionAtStartup(): string | null {
	const message = startupAttributionWarning(scmOAuthConfig().configured);
	if (message) console.warn(message);
	return message;
}

export async function storeUserScmToken(input: {
	orgId: string;
	userId: string;
	login: string;
	email?: string | null;
	scopes?: string | null;
	provider?: ScmProviderId;
	token: StoredScmToken;
}): Promise<void> {
	const provider = input.provider ?? "github";
	const expiresAt = input.token.access_token_expires_at
		? new Date(input.token.access_token_expires_at)
		: null;

	await db
		.insert(userScmTokens)
		.values({
			orgId: input.orgId,
			userId: input.userId,
			provider,
			login: input.login,
			email: input.email ?? null,
			scopes: input.scopes ?? null,
			ciphertext: encrypt(JSON.stringify(input.token)),
			expiresAt,
		})
		.onConflictDoUpdate({
			target: [userScmTokens.userId, userScmTokens.provider],
			set: {
				login: input.login,
				email: input.email ?? null,
				scopes: input.scopes ?? null,
				ciphertext: encrypt(JSON.stringify(input.token)),
				expiresAt,
			},
		});
}

function parseStored(ciphertext: string): StoredScmToken | null {
	const parsed: unknown = JSON.parse(decrypt(ciphertext));
	if (
		typeof parsed !== "object"
		|| parsed === null
		|| typeof (parsed as StoredScmToken).access_token !== "string"
	) {
		return null;
	}
	return parsed as StoredScmToken;
}

function stillFresh(stored: StoredScmToken, now: Date): boolean {
	if (!stored.access_token_expires_at) return true;
	const expiry = Date.parse(stored.access_token_expires_at);
	if (!Number.isFinite(expiry)) return true;
	return now.getTime() < expiry - scmSetting("scmTokenRefreshSkewMs");
}

/**
 * The user's access token, refreshed if it is close to expiry.
 *
 * GitHub user access tokens live eight hours and come with a refresh token that
 * is **rotated on every use** — the old one stops working the moment the new one
 * is issued. That rotation is what makes the concurrency here matter: two
 * requests refreshing at once each send the same refresh token, GitHub honours
 * one and invalidates the other, and the loser writes a dead refresh token over
 * the live one. The user is then disconnected until they sign in again, and
 * nothing logs why.
 *
 * So the refresh happens inside a transaction that takes a row lock, and
 * re-reads under the lock before deciding — the second caller wakes up, sees the
 * token the first one just stored, and returns it. Holding a row lock across an
 * HTTP call is normally a smell; here it is the cheapest correct answer, it is
 * bounded by the request timeout, and the lock is on a single user's row.
 */
export async function userScmToken(
	userId: string,
	deps: { fetch?: FetchLike; now?: () => Date; host?: string } = {},
): Promise<UserTokenOutcome> {
	const now = deps.now ?? (() => new Date());
	const provider: ScmProviderId = "github";

	let row: typeof userScmTokens.$inferSelect | undefined;
	try {
		row = await db.query.userScmTokens.findFirst({
			where: and(eq(userScmTokens.userId, userId), eq(userScmTokens.provider, provider)),
		});
	} catch (error) {
		// The database being unreachable is emphatically *not* "this user has no
		// source-control identity". Reporting it as one would permanently degrade a
		// pull request over a blip — see `openPullRequest`, which refuses to
		// degrade on an indeterminate answer.
		return {
			kind: "indeterminate",
			reason: "storage_unavailable",
			detail: (error as Error).message,
		};
	}

	if (!row) {
		return {
			kind: "absent",
			reason: scmOAuthConfig().configured ? "no_scm_identity" : "deployment_has_no_scm_oauth",
			message:
				"This account has no source-control identity connected, so there is no token that "
				+ "can author a pull request as them.",
		};
	}

	let stored: StoredScmToken | null;
	try {
		stored = parseStored(row.ciphertext);
	} catch (error) {
		return {
			kind: "indeterminate",
			reason: "stored_token_undecryptable",
			detail:
				error instanceof CryptoError
					? error.message
					: `The stored token could not be read: ${(error as Error).message}`,
		};
	}
	if (!stored) {
		return {
			kind: "indeterminate",
			reason: "stored_token_undecryptable",
			detail: "The stored token decrypted to something that is not a token document.",
		};
	}

	if (stillFresh(stored, now())) {
		return {
			kind: "available",
			token: stored.access_token,
			login: row.login,
			refreshed: false,
			expires_at: stored.access_token_expires_at ?? null,
		};
	}

	if (!stored.refresh_token) {
		return {
			kind: "absent",
			reason: "token_expired_no_refresh",
			message:
				"The stored source-control token has expired and no refresh token was kept with "
				+ "it. The user needs to reconnect their account.",
		};
	}

	const oauth = scmOAuthConfig();
	if (!oauth.configured) {
		return {
			kind: "absent",
			reason: "deployment_has_no_scm_oauth",
			message:
				`Cannot refresh the token: ${oauth.missing.join(" and ")} not set. Without an OAuth `
				+ "app there is no way to renew a user credential.",
		};
	}

	return refreshUserToken({
		userId,
		provider,
		login: row.login,
		stored,
		oauth,
		fetchImpl: deps.fetch ?? ((input, init) => fetch(input, init)),
		host: deps.host ?? scmSetting("scmHost"),
		now,
	});
}

async function refreshUserToken(input: {
	userId: string;
	provider: ScmProviderId;
	login: string;
	stored: StoredScmToken;
	oauth: { client_id: string; client_secret: string };
	fetchImpl: FetchLike;
	host: string;
	now: () => Date;
}): Promise<UserTokenOutcome> {
	return db.transaction(async (tx) => {
		const [locked] = await tx
			.select()
			.from(userScmTokens)
			.where(and(eq(userScmTokens.userId, input.userId), eq(userScmTokens.provider, input.provider)))
			.for("update")
			.limit(1);

		if (!locked) {
			return {
				kind: "absent",
				reason: "no_scm_identity",
				message: "The source-control identity was disconnected while it was being refreshed.",
			} satisfies UserTokenOutcome;
		}

		// Re-read under the lock. Another request may have refreshed while this one
		// waited, and using the token it stored is both correct and one fewer
		// rotation of a credential GitHub invalidates on every use.
		let current: StoredScmToken | null = null;
		try {
			current = parseStored(locked.ciphertext);
		} catch {
			current = null;
		}
		if (current && stillFresh(current, input.now())) {
			return {
				kind: "available",
				token: current.access_token,
				login: locked.login,
				refreshed: false,
				expires_at: current.access_token_expires_at ?? null,
			} satisfies UserTokenOutcome;
		}

		const refreshToken = current?.refresh_token ?? input.stored.refresh_token;
		if (!refreshToken) {
			return {
				kind: "absent",
				reason: "token_expired_no_refresh",
				message: "The stored token expired and no refresh token is available.",
			} satisfies UserTokenOutcome;
		}

		const url = `https://${input.host}/login/oauth/access_token`;
		let response: Response;
		try {
			response = await input.fetchImpl(url, {
				method: "POST",
				headers: { accept: "application/json", "content-type": "application/json" },
				body: JSON.stringify({
					client_id: input.oauth.client_id,
					client_secret: input.oauth.client_secret,
					grant_type: "refresh_token",
					refresh_token: refreshToken,
				}),
				signal: AbortSignal.timeout(scmSetting("scmRequestTimeoutMs")),
			});
		} catch (error) {
			const name = (error as Error)?.name ?? "";
			return {
				kind: "indeterminate",
				reason:
					name === "TimeoutError" || name === "AbortError"
						? "refresh_upstream_timeout"
						: "refresh_upstream_unavailable",
				detail: (error as Error).message,
			} satisfies UserTokenOutcome;
		}

		const text = await response.text();
		let body: Record<string, unknown> = {};
		try {
			const parsed: unknown = JSON.parse(text);
			if (typeof parsed === "object" && parsed !== null) body = parsed as Record<string, unknown>;
		} catch {
			body = {};
		}

		if (response.status >= 500 || response.status === 429) {
			return {
				kind: "indeterminate",
				reason: "refresh_upstream_unavailable",
				detail: `The token endpoint answered ${response.status}.`,
			} satisfies UserTokenOutcome;
		}

		// The trap: GitHub answers **200 OK** with `{"error": "bad_refresh_token"}`.
		// Code that checks `response.ok` and reads `access_token` stores `undefined`
		// and fails hours later somewhere unrelated, with a stack trace that points
		// at the pull request code rather than at the refresh that actually failed.
		const error = typeof body.error === "string" ? body.error : null;
		if (error) {
			const terminal = ["bad_refresh_token", "bad_verification_code", "unauthorized_client"];
			if (terminal.includes(error)) {
				return {
					kind: "absent",
					reason: "refresh_token_expired",
					message:
						`The source-control host rejected the refresh token (${error}). The user must `
						+ "sign in again to restore attributed pull requests.",
				} satisfies UserTokenOutcome;
			}
			return {
				kind: "indeterminate",
				reason: "refresh_upstream_unavailable",
				detail: `The token endpoint returned error=${error}.`,
			} satisfies UserTokenOutcome;
		}

		const accessToken = typeof body.access_token === "string" ? body.access_token : null;
		if (!accessToken) {
			return {
				kind: "indeterminate",
				reason: "refresh_upstream_unavailable",
				detail: "The token endpoint returned no access token and no error.",
			} satisfies UserTokenOutcome;
		}

		const expiresIn = typeof body.expires_in === "number" ? body.expires_in : null;
		const refreshExpiresIn =
			typeof body.refresh_token_expires_in === "number" ? body.refresh_token_expires_in : null;
		const nowMs = input.now().getTime();

		const next: StoredScmToken = {
			access_token: accessToken,
			access_token_expires_at: expiresIn
				? new Date(nowMs + expiresIn * 1000).toISOString()
				: undefined,
			// GitHub rotates the refresh token on every use. Keeping the old one when
			// a new one is issued means the *next* refresh presents a token that was
			// invalidated the moment this one succeeded.
			refresh_token:
				typeof body.refresh_token === "string" ? body.refresh_token : refreshToken,
			refresh_token_expires_at: refreshExpiresIn
				? new Date(nowMs + refreshExpiresIn * 1000).toISOString()
				: current?.refresh_token_expires_at,
		};

		await tx
			.update(userScmTokens)
			.set({
				ciphertext: encrypt(JSON.stringify(next)),
				expiresAt: next.access_token_expires_at ? new Date(next.access_token_expires_at) : null,
			})
			.where(eq(userScmTokens.id, locked.id));

		return {
			kind: "available",
			token: accessToken,
			login: locked.login,
			refreshed: true,
			expires_at: next.access_token_expires_at ?? null,
		} satisfies UserTokenOutcome;
	});
}

/**
 * Bridge from a stored identity to the authority `openPullRequest` consumes.
 *
 * The switch has no `default` and the three arms stay three arms all the way to
 * the pull request: available opens it attributed, absent degrades loudly,
 * indeterminate defers. Collapsing indeterminate into absent here — one line,
 * very tempting — is what would silently convert a provider outage into a
 * permanent loss of the self-approval guarantee for whichever pull requests
 * happened to be opened during it.
 */
export async function prAuthorityForUser(
	userId: string,
	deps: { fetch?: FetchLike; now?: () => Date; host?: string } = {},
): Promise<PrAuthority> {
	const outcome = await userScmToken(userId, deps);
	switch (outcome.kind) {
		case "available":
			return { kind: "user", token: outcome.token, login: outcome.login };
		case "absent":
			return { kind: "absent", reason: outcome.reason, detail: outcome.message };
		case "indeterminate":
			return { kind: "indeterminate", reason: outcome.reason, detail: outcome.detail };
	}
	return assertNever(outcome, "prAuthorityForUser");
}

/**
 * Forget a user's stored source-control identity.
 *
 * Deleting the row rather than blanking the ciphertext, because a row that
 * exists with an unreadable secret is `stored_token_undecryptable` — an
 * INDETERMINATE answer, which `openPullRequest` retries forever. Disconnecting
 * is a decision, and the honest encoding of a decision is `no_scm_identity`:
 * absent, degraded loudly, not retried.
 *
 * Returns whether there was anything to forget so the caller can tell a
 * disconnect from a double-click without a second query.
 */
export async function forgetUserScmToken(
	userId: string,
	provider: ScmProviderId = "github",
): Promise<boolean> {
	const removed = await db
		.delete(userScmTokens)
		.where(and(eq(userScmTokens.userId, userId), eq(userScmTokens.provider, provider)))
		.returning({ id: userScmTokens.id });
	return removed.length > 0;
}

/**
 * What to show a person on the settings page, without touching the secret.
 *
 * Deliberately does NOT go through `userScmToken`: that function refreshes, and
 * rendering a page must not rotate a refresh token as a side effect of somebody
 * looking at it. Expiry is read from the column, which is what the column is
 * for.
 */
export interface ScmIdentitySummary {
	connected: boolean;
	login: string | null;
	scopes: string | null;
	/** Null for a token that does not expire — a classic OAuth App grant. */
	expires_at: string | null;
	connected_at: string | null;
}

export async function scmIdentitySummary(
	userId: string,
	provider: ScmProviderId = "github",
): Promise<ScmIdentitySummary> {
	const row = await db.query.userScmTokens.findFirst({
		where: and(eq(userScmTokens.userId, userId), eq(userScmTokens.provider, provider)),
	});
	if (!row) {
		return { connected: false, login: null, scopes: null, expires_at: null, connected_at: null };
	}
	return {
		connected: true,
		login: row.login,
		scopes: row.scopes,
		expires_at: row.expiresAt?.toISOString() ?? null,
		connected_at: row.createdAt?.toISOString() ?? null,
	};
}

/** Re-exported so callers do not have to import from two files to switch on a gap. */
export type { ScmIdentityGap, ScmIdentityIndeterminacy };
