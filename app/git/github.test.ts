// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The GitHub provider and the credential broker.
 *
 * Nothing here touches the network. `fetch` is injected, so every case the suite
 * cares about — a 5xx during an authority check, a 200 with no `permissions`
 * object, a pull request that already exists, a refresh endpoint that answers
 * `200 {"error": "bad_refresh_token"}` — is producible on demand. Those are
 * exactly the cases you cannot arrange against the real API, and they are the
 * ones where the interesting decisions live.
 *
 * The database, by contrast, is real. The credential broker's guarantees are
 * relational — "this sandbox's session includes this repository" — and a mocked
 * database would happily agree with an assertion that production would not.
 */

import { generateKeyPairSync, verify as verifySignature } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SANDBOX_STATUSES } from "../contracts/index.js";
import { db, sql } from "@core/schema/index.js";
import { orgs, repos, sandboxes, sessionRepos, sessions, users } from "@core/schema/schema.js";
import {
	DEAD_STATUSES_FOR_CREDENTIALS,
	authoriseGitHost,
	mintGitCredential,
	prAuthorityForUser,
	sandboxLiveness,
	scmOAuthConfig,
	storeUserScmToken,
	userScmToken,
	warnScmAttributionAtStartup,
} from "./credentials.js";
import { GitHubProvider, appJwt, clearRepoAccessCache, createScmProvider } from "./github.js";
import {
	type InstallationTokenResult,
	type InstallationTokenScope,
	type ScmProvider,
	enforceRepoAccess,
	resolveScmProviderId,
} from "./provider.js";

/**
 * A key is needed for the encrypted user-token rows, and OAuth credentials for
 * the refresh path. Set here rather than in the ambient environment so the suite
 * is self-contained — `crypto.ts` and `scmSetting` both read at call time, which
 * is exactly why that is possible.
 *
 * Restored in `afterAll` because vitest reuses a worker process across files:
 * leaving `GITHUB_CLIENT_ID` set would silently change the behaviour of another
 * suite that asserts what happens when it is absent, and the failure would land
 * in that file rather than in this one.
 */
const ENV_KEYS = ["HARBOR_ENCRYPTION_KEY", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
process.env.HARBOR_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

let orgId: string;
let userId: string;
let sessionId: string;
let repoId: string;
let sandboxId: string;

beforeEach(async () => {
	clearRepoAccessCache();
	await sql`truncate table user_scm_tokens, sandboxes, session_repos, session_events, session_prompts, session_participants, sessions, repos, users, orgs cascade`;

	const [org] = await db.insert(orgs).values({ name: "Git Org" }).returning();
	orgId = org!.id;
	const [user] = await db.insert(users).values({ orgId, name: "Rin", email: "rin@example.com" }).returning();
	userId = user!.id;
	const [session] = await db
		.insert(sessions)
		.values({ orgId, key: "sk_git_test", title: "Fix the retry cap", createdBy: "@rin" })
		.returning();
	sessionId = session!.id;
	const [repo] = await db
		.insert(repos)
		.values({ orgId, provider: "github", owner: "acme", name: "api", installationId: "4242" })
		.returning();
	repoId = repo!.id;
	await db.insert(sessionRepos).values({ orgId, sessionId, repoId, baseBranch: "main" });
	const [sandbox] = await db
		.insert(sandboxes)
		.values({ orgId, sessionId, provider: "docker", status: "ready" })
		.returning();
	sandboxId = sandbox!.id;
});

afterAll(async () => {
	for (const key of ENV_KEYS) {
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
	}
	await sql.end();
});

// ---------------------------------------------------------------------------

describe("provider selection", () => {
	it("refuses a named-but-unimplemented provider instead of shipping a stub", () => {
		const resolution = resolveScmProviderId("gitlab");
		expect(resolution.ok).toBe(false);
		if (resolution.ok) throw new Error("unreachable");
		expect(resolution.reason).toBe("provider_not_implemented");
		// The message has to say what the operator should do, because the failure
		// otherwise surfaces after a sandbox has already been paid for.
		expect(resolution.message).toContain("SCM_PROVIDER=github");
	});

	it("refuses a provider it has never heard of, and lists the ones it has", () => {
		const resolution = resolveScmProviderId("perforce");
		expect(resolution.ok).toBe(false);
		if (resolution.ok) throw new Error("unreachable");
		expect(resolution.reason).toBe("provider_unknown");
		expect(resolution.message).toContain("github");
	});

	it("builds a GitHub provider when configured for github", () => {
		const selection = createScmProvider({ host: "github.com" });
		expect(selection.ok).toBe(true);
		if (!selection.ok) throw new Error("unreachable");
		expect(selection.provider.id).toBe("github");
	});
});

// ---------------------------------------------------------------------------

describe("verifyRepoAccess — the multi-tenancy check", () => {
	it("FAILS CLOSED on a 5xx: could-not-determine is not permission", async () => {
		const provider = new GitHubProvider({
			host: "github.com",
			fetch: async () => json({ message: "Server Error" }, 503),
		});

		const access = await provider.verifyRepoAccess("gho_user", "acme", "api");
		expect(access.decision).toBe("indeterminate");
		if (access.decision !== "indeterminate") throw new Error("unreachable");
		expect(access.reason).toBe("upstream_unavailable");

		// And the authority boundary collapses it to a denial — deliberately, and in
		// the opposite direction to sandbox liveness below.
		const authorised = enforceRepoAccess(access, "write");
		expect(authorised.decision).toBe("deny");
		if (authorised.decision !== "deny") throw new Error("unreachable");
		expect(authorised.cause).toEqual({ kind: "indeterminate", reason: "upstream_unavailable" });
		expect(authorised.message).toContain("could not determine");
	});

	it("does not cache an indeterminate answer — an outage must not outlive itself", async () => {
		let calls = 0;
		const provider = new GitHubProvider({
			host: "github.com",
			fetch: async () => {
				calls += 1;
				return calls === 1
					? json({ message: "Server Error" }, 500)
					: json({ permissions: { push: true, pull: true } }, 200);
			},
		});

		expect((await provider.verifyRepoAccess("gho_user", "acme", "api")).decision).toBe("indeterminate");
		// Second call goes back to GitHub rather than replaying the failure.
		expect((await provider.verifyRepoAccess("gho_user", "acme", "api")).decision).toBe("allowed");
		expect(calls).toBe(2);
	});

	it("caches a settled answer so the check is not a per-request round trip", async () => {
		let calls = 0;
		const provider = new GitHubProvider({
			host: "github.com",
			fetch: async () => {
				calls += 1;
				return json({ permissions: { admin: true } }, 200);
			},
		});

		const first = await provider.verifyRepoAccess("gho_user", "acme", "api");
		const second = await provider.verifyRepoAccess("gho_user", "acme", "api");
		expect(first).toEqual(second);
		expect(calls).toBe(1);

		// Keyed by the token: a different user must not inherit this answer, which is
		// the entire point of a per-user check.
		await provider.verifyRepoAccess("gho_someone_else", "acme", "api");
		expect(calls).toBe(2);
	});

	it("reads 404 as a denial, because GitHub hides private repositories behind one", async () => {
		const provider = new GitHubProvider({
			host: "github.com",
			fetch: async () => json({ message: "Not Found" }, 404),
		});
		const access = await provider.verifyRepoAccess("gho_user", "acme", "secret");
		expect(access.decision).toBe("denied");
		if (access.decision !== "denied") throw new Error("unreachable");
		expect(access.reason).toBe("not_found_or_no_access");
	});

	it("separates a SAML-authorisation 403 from an ordinary one", async () => {
		const provider = new GitHubProvider({
			host: "github.com",
			fetch: async () =>
				json({ message: "Resource protected by organization SAML enforcement" }, 403, {
					"x-github-sso": "required; url=https://github.com/orgs/acme/sso",
				}),
		});
		const access = await provider.verifyRepoAccess("gho_user", "acme", "api");
		if (access.decision !== "denied") throw new Error("expected a denial");
		expect(access.reason).toBe("sso_authorization_required");
	});

	it("treats a rate-limited check as indeterminate, never as a denial", async () => {
		const provider = new GitHubProvider({
			host: "github.com",
			fetch: async () =>
				json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0" }),
		});
		const access = await provider.verifyRepoAccess("gho_user", "acme", "api");
		// A rate limit says nothing about access. Recording it as a denial would make
		// a traffic spike look like a permissions incident in the logs.
		expect(access.decision).toBe("indeterminate");
		if (access.decision !== "indeterminate") throw new Error("unreachable");
		expect(access.reason).toBe("rate_limited");
	});

	it("refuses to guess when a 200 carries no permissions object", async () => {
		const provider = new GitHubProvider({ host: "github.com", fetch: async () => json({ id: 1 }, 200) });
		const access = await provider.verifyRepoAccess("gho_user", "acme", "api");
		if (access.decision !== "indeterminate") throw new Error("expected indeterminate");
		expect(access.reason).toBe("permission_unreported");
		expect(enforceRepoAccess(access, "write").decision).toBe("deny");
	});

	it("reads the highest permission, not the first true flag", async () => {
		const provider = new GitHubProvider({
			host: "github.com",
			// An admin has pull and push set too; checking pull first would report
			// every administrator as a reader and refuse them work.
			fetch: async () => json({ permissions: { admin: true, push: true, pull: true } }, 200),
		});
		const access = await provider.verifyRepoAccess("gho_user", "acme", "api");
		if (access.decision !== "allowed") throw new Error("expected allowed");
		expect(access.permission).toBe("admin");
		expect(enforceRepoAccess(access, "write").decision).toBe("allow");
	});

	it("denies read-only access when the session needs to push", async () => {
		const provider = new GitHubProvider({
			host: "github.com",
			fetch: async () => json({ permissions: { pull: true } }, 200),
		});
		const access = await provider.verifyRepoAccess("gho_user", "acme", "api");
		const authorised = enforceRepoAccess(access, "write");
		expect(authorised.decision).toBe("deny");
		if (authorised.decision !== "deny") throw new Error("unreachable");
		expect(authorised.cause).toEqual({ kind: "denied", reason: "insufficient_permission" });
		// Read access is still enough for a session that only reads.
		expect(enforceRepoAccess(access, "read").decision).toBe("allow");
	});
});

// ---------------------------------------------------------------------------

describe("URLs", () => {
	const provider = new GitHubProvider({ host: "github.com", fetch: async () => json({}) });

	it("never puts a credential in a remote URL", () => {
		const url = provider.pushUrl({ provider: "github", owner: "acme", name: "api" });
		expect(url).toBe("https://github.com/acme/api.git");
		expect(url).not.toMatch(/@|token|ghs_|x-access-token/);
	});

	it("builds a compare URL that survives a slash in the branch name", () => {
		const url = provider.compareUrl(
			{ provider: "github", owner: "acme", name: "api" },
			"main",
			"harbor/lse_9f1c",
		);
		expect(url).toBe("https://github.com/acme/api/compare/main...harbor/lse_9f1c?expand=1");
	});

	it("points at /api/v3 on Enterprise Server rather than api.github.com", () => {
		const ghes = new GitHubProvider({ host: "git.acme.internal", fetch: async () => json({}) });
		expect(ghes.apiBase).toBe("https://git.acme.internal/api/v3");
	});
});

// ---------------------------------------------------------------------------

describe("installation tokens", () => {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

	it("signs a verifiable RS256 JWT and backdates iat against clock skew", () => {
		const now = new Date("2026-01-01T00:00:00.000Z");
		const token = appJwt("12345", pem, now);
		const [header, payload, signature] = token.split(".") as [string, string, string];

		expect(verifySignature(
			"RSA-SHA256",
			Buffer.from(`${header}.${payload}`),
			publicKey,
			Buffer.from(signature, "base64url"),
		)).toBe(true);

		const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, number>;
		const seconds = Math.floor(now.getTime() / 1000);
		// Backdated by a minute: GitHub rejects a JWT whose iat is even a second in
		// the future, so a control plane with a fast clock would fail every mint.
		expect(claims.iat).toBe(seconds - 60);
		// And inside GitHub's ten-minute ceiling.
		expect(claims.exp! - claims.iat!).toBeLessThanOrEqual(600);
	});

	it("mints a token scoped to one repository and reports its expiry", async () => {
		let body: Record<string, unknown> = {};
		const provider = new GitHubProvider({
			host: "github.com",
			app: { appId: "12345", privateKey: pem },
			fetch: async (url, init) => {
				expect(url).toBe("https://api.github.com/app/installations/4242/access_tokens");
				expect((init?.headers as Record<string, string>).authorization).toMatch(/^Bearer /);
				body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return json({ token: "ghs_minted", expires_at: "2026-01-01T01:00:00Z" }, 201);
			},
		});

		const result = await provider.installationToken("4242", {
			repositories: ["api"],
			permissions: { contents: "write" },
		});
		expect(result).toEqual({ kind: "minted", token: "ghs_minted", expires_at: "2026-01-01T01:00:00Z" });
		expect(body).toEqual({ repositories: ["api"], permissions: { contents: "write" } });
	});

	it("reports a missing app as unavailable, not as a failure to retry", async () => {
		const provider = new GitHubProvider({ host: "github.com", fetch: async () => json({}, 201) });
		const result = await provider.installationToken("4242");
		expect(result.kind).toBe("unavailable");
		if (result.kind !== "unavailable") throw new Error("unreachable");
		expect(result.reason).toBe("app_not_configured");
	});

	it("classifies an uninstalled app as unavailable and a 503 as transient", async () => {
		const gone = new GitHubProvider({
			host: "github.com",
			app: { appId: "1", privateKey: pem },
			fetch: async () => json({ message: "Not Found" }, 404),
		});
		expect((await gone.installationToken("4242")).kind).toBe("unavailable");

		const down = new GitHubProvider({
			host: "github.com",
			app: { appId: "1", privateKey: pem },
			fetch: async () => json({ message: "unavailable" }, 503),
		});
		const result = await down.installationToken("4242");
		if (result.kind !== "failed") throw new Error("expected failed");
		expect(result.error_type).toBe("transient");
	});
});

// ---------------------------------------------------------------------------

describe("liveness versus authority", () => {
	it("treats a status this build has never heard of as LIVE", () => {
		// Fail open. Refusing a credential to a box that is actually running throws
		// away a whole session's work at the moment it tries to push.
		expect(sandboxLiveness("teleported")).toEqual({ state: "live", basis: "unknown_status" });
	});

	it("agrees with DEAD_SANDBOX_STATUSES for every status in the contract", () => {
		for (const status of SANDBOX_STATUSES) {
			const expected = DEAD_STATUSES_FOR_CREDENTIALS.includes(status) ? "dead" : "live";
			expect(sandboxLiveness(status).state, status).toBe(expected);
		}
	});
});

// ---------------------------------------------------------------------------

describe("credential brokering", () => {
	function fakeProvider(
		token: InstallationTokenResult = {
			kind: "minted",
			token: "ghs_installation",
			expires_at: new Date(Date.now() + 3_600_000).toISOString(),
		},
	) {
		const scopes: Array<InstallationTokenScope | undefined> = [];
		const provider: ScmProvider = {
			id: "github",
			host: "github.com",
			createPullRequest: async () => {
				throw new Error("the credential broker must never open a pull request");
			},
			pushUrl: () => "https://github.com/acme/api.git",
			compareUrl: () => "https://github.com/acme/api/compare/main...x",
			verifyRepoAccess: async () => ({
				decision: "allowed",
				permission: "write",
				checked_at: new Date().toISOString(),
			}),
			installationToken: async (_id, scope) => {
				scopes.push(scope);
				return token;
			},
		};
		return { provider, scopes };
	}

	it("refuses a host that is not the configured SCM host, before touching the database", async () => {
		const { provider, scopes } = fakeProvider();
		const outcome = await mintGitCredential(
			sandboxId,
			{ repo: { owner: "acme", name: "api", host: "evil.example.com" }, operation: "push" },
			{ provider },
		);

		expect(outcome.kind).toBe("refused");
		if (outcome.kind !== "refused") throw new Error("unreachable");
		expect(outcome.reason).toBe("host_not_allowed");
		expect(outcome.message).toContain("submodule");
		expect(scopes).toHaveLength(0);
	});

	it("is not fooled by a lookalike host, a trailing dot, or a userinfo prefix", () => {
		expect(authoriseGitHost({ host: "evilgithub.com" }, "github.com").decision).toBe("refused");
		expect(authoriseGitHost({ host: "github.com.evil.tld" }, "github.com").decision).toBe("refused");
		expect(authoriseGitHost({ host: "user@github.com" }, "github.com").decision).toBe("refused");
		expect(authoriseGitHost({ host: "github.com:8443" }, "github.com").decision).toBe("refused");
		// Case and the FQDN trailing dot are normalisation, not a way past the check.
		expect(authoriseGitHost({ host: "GitHub.com." }, "github.com")).toEqual({
			decision: "allowed",
			host: "github.com",
		});
	});

	it("refuses anything that is not https", () => {
		const http = authoriseGitHost({ protocol: "http", host: "github.com" }, "github.com");
		expect(http.decision).toBe("refused");
		if (http.decision !== "refused") throw new Error("unreachable");
		expect(http.reason).toBe("scheme_not_https");
		expect(authoriseGitHost({ protocol: "ssh", host: "github.com" }, "github.com").decision).toBe(
			"refused",
		);
	});

	it("mints a read-only credential for a fetch and a write one for a push", async () => {
		const { provider, scopes } = fakeProvider();

		const fetched = await mintGitCredential(
			sandboxId,
			{ repo: { owner: "acme", name: "api" }, operation: "fetch" },
			{ provider },
		);
		expect(fetched.kind).toBe("minted");
		expect(scopes[0]).toEqual({ repositories: ["api"], permissions: { contents: "read" } });

		const pushed = await mintGitCredential(
			sandboxId,
			{ repo: { owner: "ACME", name: "API" }, operation: "push" },
			{ provider },
		);
		if (pushed.kind !== "minted") throw new Error("expected a credential");
		expect(scopes[1]).toEqual({ repositories: ["api"], permissions: { contents: "write" } });
		expect(pushed.username).toBe("x-access-token");
		expect(pushed.password).toBe("ghs_installation");
	});

	it("reports a refresh deadline sooner than the token actually dies", async () => {
		const now = new Date("2026-01-01T00:00:00.000Z");
		const { provider } = fakeProvider({
			kind: "minted",
			token: "ghs_installation",
			// GitHub's real ceiling: one hour.
			expires_at: "2026-01-01T01:00:00.000Z",
		});

		const outcome = await mintGitCredential(
			sandboxId,
			{ repo: { owner: "acme", name: "api" }, operation: "push" },
			{ provider, now: () => now },
		);
		if (outcome.kind !== "minted") throw new Error("expected a credential");
		// The helper is told to come back long before the credential expires, so a
		// long session never discovers a dead token at the moment it finally pushes.
		expect(Date.parse(outcome.expires_at)).toBeLessThan(Date.parse("2026-01-01T01:00:00.000Z"));
		expect(outcome.expires_at).toBe("2026-01-01T00:10:00.000Z");
	});

	it("refuses a repository the session does not include, even though the app can see it", async () => {
		// The App installation reaches every repository in the org; the session's own
		// snapshot is the authorisation. This is the multi-tenancy hole closed at the
		// credential layer, so it holds even if a caller reaches this directly.
		await db
			.insert(repos)
			.values({ orgId, provider: "github", owner: "acme", name: "billing", installationId: "4242" });

		const { provider, scopes } = fakeProvider();
		const outcome = await mintGitCredential(
			sandboxId,
			{ repo: { owner: "acme", name: "billing" }, operation: "push" },
			{ provider },
		);
		expect(outcome.kind).toBe("refused");
		if (outcome.kind !== "refused") throw new Error("unreachable");
		expect(outcome.reason).toBe("repo_not_in_session");
		expect(scopes).toHaveLength(0);
	});

	it("refuses a sandbox it has no record of — authority fails closed", async () => {
		const { provider } = fakeProvider();
		const outcome = await mintGitCredential(
			"00000000-0000-0000-0000-000000000000",
			{ repo: { owner: "acme", name: "api" }, operation: "push" },
			{ provider },
		);
		expect(outcome.kind).toBe("refused");
		if (outcome.kind !== "refused") throw new Error("unreachable");
		expect(outcome.reason).toBe("sandbox_unknown");
	});

	it("refuses a dead sandbox but serves one whose status it does not recognise", async () => {
		const { provider } = fakeProvider();

		await db.update(sandboxes).set({ status: "stopped" });
		const dead = await mintGitCredential(
			sandboxId,
			{ repo: { owner: "acme", name: "api" }, operation: "push" },
			{ provider },
		);
		expect(dead.kind).toBe("refused");
		if (dead.kind !== "refused") throw new Error("unreachable");
		expect(dead.reason).toBe("sandbox_dead");

		// Fail open on liveness: a status written by a newer control plane must not
		// strand a box that is demonstrably working.
		await db.update(sandboxes).set({ status: "hibernating" });
		expect(
			(
				await mintGitCredential(
					sandboxId,
					{ repo: { owner: "acme", name: "api" }, operation: "push" },
					{ provider },
				)
			).kind,
		).toBe("minted");
	});

	it("refuses when no app installation is recorded for the repository", async () => {
		await db.update(repos).set({ installationId: null }).where(eq(repos.id, repoId));
		const { provider } = fakeProvider();
		const outcome = await mintGitCredential(
			sandboxId,
			{ repo: { owner: "acme", name: "api" }, operation: "clone" },
			{ provider },
		);
		expect(outcome.kind).toBe("refused");
		if (outcome.kind !== "refused") throw new Error("unreachable");
		expect(outcome.reason).toBe("installation_missing");
	});

	it("refuses to hand anything shaped like a refresh token to a sandbox", async () => {
		const { provider } = fakeProvider({
			kind: "minted",
			token: "ghr_refresh_token_by_mistake",
			expires_at: new Date(Date.now() + 3_600_000).toISOString(),
		});
		const outcome = await mintGitCredential(
			sandboxId,
			{ repo: { owner: "acme", name: "api" }, operation: "push" },
			{ provider },
		);
		expect(outcome.kind).toBe("refused");
		if (outcome.kind !== "refused") throw new Error("unreachable");
		expect(outcome.reason).toBe("credential_shape_rejected");
	});
});

// ---------------------------------------------------------------------------

describe("user tokens", () => {
	it("reports no identity for a user who never connected one", async () => {
		const outcome = await userScmToken(userId);
		expect(outcome.kind).toBe("absent");
		if (outcome.kind !== "absent") throw new Error("unreachable");
		expect(["no_scm_identity", "deployment_has_no_scm_oauth"]).toContain(outcome.reason);
	});

	it("stores a token encrypted and never in plaintext", async () => {
		await storeUserScmToken({
			orgId,
			userId,
			login: "rin",
			token: { access_token: "gho_live", refresh_token: "ghr_live" },
		});

		const [row] = await sql`select ciphertext from user_scm_tokens`;
		expect(String(row!.ciphertext)).toMatch(/^v1\./);
		expect(String(row!.ciphertext)).not.toContain("gho_live");
		expect(String(row!.ciphertext)).not.toContain("ghr_live");

		const outcome = await userScmToken(userId);
		if (outcome.kind !== "available") throw new Error("expected a token");
		expect(outcome.token).toBe("gho_live");
		expect(outcome.refreshed).toBe(false);
	});

	it("refreshes a token that is inside the skew window, and stores the rotated refresh token", async () => {
		process.env.GITHUB_CLIENT_ID = "client";
		process.env.GITHUB_CLIENT_SECRET = "secret";
		const now = new Date("2026-01-01T00:00:00.000Z");

		await storeUserScmToken({
			orgId,
			userId,
			login: "rin",
			token: {
				access_token: "gho_old",
				// Two minutes left: inside the five-minute refresh skew, because the PR
				// call must not be the one that discovers the token died.
				access_token_expires_at: "2026-01-01T00:02:00.000Z",
				refresh_token: "ghr_old",
			},
		});

		const outcome = await userScmToken(userId, {
			now: () => now,
			fetch: async (_url, init) => {
				const body = JSON.parse(String(init?.body)) as Record<string, string>;
				expect(body.grant_type).toBe("refresh_token");
				expect(body.refresh_token).toBe("ghr_old");
				return json({
					access_token: "gho_new",
					expires_in: 28_800,
					refresh_token: "ghr_new",
					refresh_token_expires_in: 15_897_600,
				});
			},
		});

		if (outcome.kind !== "available") throw new Error("expected a refreshed token");
		expect(outcome.token).toBe("gho_new");
		expect(outcome.refreshed).toBe(true);

		// The rotated refresh token must be the one stored: GitHub invalidates the
		// old one the moment the new one is issued, so keeping it disconnects the
		// user at the next refresh.
		const second = await userScmToken(userId, {
			now: () => new Date("2026-01-01T08:00:00.000Z"),
			fetch: async (_url, init) => {
				const body = JSON.parse(String(init?.body)) as Record<string, string>;
				expect(body.refresh_token).toBe("ghr_new");
				return json({ access_token: "gho_newer", expires_in: 28_800, refresh_token: "ghr_newer" });
			},
		});
		if (second.kind !== "available") throw new Error("expected a refreshed token");
		expect(second.token).toBe("gho_newer");
	});

	it("treats GitHub's 200-with-an-error body as a real failure", async () => {
		process.env.GITHUB_CLIENT_ID = "client";
		process.env.GITHUB_CLIENT_SECRET = "secret";
		await storeUserScmToken({
			orgId,
			userId,
			login: "rin",
			token: {
				access_token: "gho_old",
				access_token_expires_at: "2020-01-01T00:00:00.000Z",
				refresh_token: "ghr_dead",
			},
		});

		// 200 OK. A `response.ok` check would store `undefined` as the access token
		// and fail hours later, somewhere unrelated.
		const outcome = await userScmToken(userId, {
			fetch: async () => json({ error: "bad_refresh_token" }, 200),
		});
		expect(outcome.kind).toBe("absent");
		if (outcome.kind !== "absent") throw new Error("unreachable");
		expect(outcome.reason).toBe("refresh_token_expired");
	});

	it("reports a refresh outage as INDETERMINATE, never as a missing identity", async () => {
		process.env.GITHUB_CLIENT_ID = "client";
		process.env.GITHUB_CLIENT_SECRET = "secret";
		await storeUserScmToken({
			orgId,
			userId,
			login: "rin",
			token: {
				access_token: "gho_old",
				access_token_expires_at: "2020-01-01T00:00:00.000Z",
				refresh_token: "ghr_live",
			},
		});

		const outcome = await userScmToken(userId, { fetch: async () => json({ message: "boom" }, 502) });
		expect(outcome.kind).toBe("indeterminate");

		// And it stays indeterminate all the way to the PR decision, so a ten-second
		// outage cannot permanently downgrade a pull request's attribution.
		const authority = await prAuthorityForUser(userId, {
			fetch: async () => json({ message: "boom" }, 502),
		});
		expect(authority.kind).toBe("indeterminate");
	});

	it("warns at startup, by name, when the deployment has no SCM OAuth at all", () => {
		const clientId = process.env.GITHUB_CLIENT_ID;
		const clientSecret = process.env.GITHUB_CLIENT_SECRET;
		delete process.env.GITHUB_CLIENT_ID;
		delete process.env.GITHUB_CLIENT_SECRET;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		try {
			expect(scmOAuthConfig().configured).toBe(false);
			const message = warnScmAttributionAtStartup();
			expect(message).toBeTruthy();
			// The startup warning names the property, not just the missing variable.
			// An operator who reads "GITHUB_CLIENT_ID unset" does not learn that the
			// central guarantee of the product is off.
			expect(message).toContain("the self-approval guarantee does not hold for this pull request");
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
			if (clientId) process.env.GITHUB_CLIENT_ID = clientId;
			if (clientSecret) process.env.GITHUB_CLIENT_SECRET = clientSecret;
		}
	});

	it("says nothing at startup when OAuth is configured", () => {
		process.env.GITHUB_CLIENT_ID = "client";
		process.env.GITHUB_CLIENT_SECRET = "secret";
		expect(warnScmAttributionAtStartup()).toBeNull();
	});
});
