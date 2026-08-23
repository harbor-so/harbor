// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The GitHub OAuth mechanics, shared by the two flows that need them.
 *
 * Harbor asks GitHub for a user's authorisation twice, for two unrelated
 * reasons, and keeping them apart is the point of this module:
 *
 *  - **Sign-in** (`/api/auth/login`) wants an identity to hang a dashboard
 *    session on. `read:user` is enough and is the default.
 *  - **PR authorship** (`/api/auth/scm`) wants a token that can open a pull
 *    request *as that person*, which needs `repo`. That is a materially larger
 *    grant — write access to every repository they can push to — and asking for
 *    it as the price of loading a dashboard is how a security review ends.
 *
 * So the two are separate consents by default, and an operator who would rather
 * have one flow can set `HARBOR_GITHUB_OAUTH_SCOPES=read:user,repo` and get it.
 * Both paths land in exactly one place, `storeUserScmToken`, so there is one
 * answer to "where did this token come from and what may it do".
 *
 * Everything here takes an injected `fetch` because the alternative is a test
 * suite that either hits GitHub or proves nothing.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { setting } from "@core/kernel/config.js";
import type { StoredScmToken } from "../git/credentials.js";

export type FetchLike = typeof fetch;

/**
 * The scope that lets Harbor open a pull request as the signed-in human.
 *
 * `repo` and not `public_repo`, deliberately. `public_repo` would author pull
 * requests on public repositories and fail on private ones, which produces a
 * deployment where attribution silently holds for some repos and not others —
 * the exact split-brain the whole `absent`/`indeterminate` distinction in
 * `openPullRequest` exists to make impossible.
 */
export const SCM_AUTHORSHIP_SCOPE = "repo";

/** The identity scope sign-in cannot do without. */
export const SIGN_IN_SCOPE = "read:user";

/**
 * Split a GitHub scope string — `"read:user,repo"` at authorize time, or
 * `"read:user, repo"` in a token response, because GitHub uses both.
 */
export function parseScopes(raw: string | null | undefined): string[] {
	return (raw ?? "")
		.split(/[,\s]+/)
		.map((scope) => scope.trim())
		.filter(Boolean);
}

/**
 * Does this grant let Harbor author a pull request for the user?
 *
 * Asked of what GitHub *returned*, never of what we requested. A user can
 * un-tick an organisation on the consent screen, and a request that asked for
 * `repo` is not evidence that `repo` was given.
 */
export function grantsAuthorship(scopes: string | null | undefined): boolean {
	return parseScopes(scopes).includes(SCM_AUTHORSHIP_SCOPE);
}

/** The scopes sign-in requests, always including the one it cannot work without. */
export function signInScopes(): string {
	const configured = parseScopes(setting("githubOAuthScopes"));
	if (!configured.includes(SIGN_IN_SCOPE)) configured.unshift(SIGN_IN_SCOPE);
	return configured.join(",");
}

/** True when sign-in itself is configured to collect an authorship-capable token. */
export function signInGrantsAuthorship(): boolean {
	return grantsAuthorship(signInScopes());
}

// ---------------------------------------------------------------------------
// The state parameter
// ---------------------------------------------------------------------------

/**
 * A CSRF state value and the cookie that carries it.
 *
 * Each flow gets its OWN cookie name. Sharing one would let a callback started
 * by the sign-in flow be completed by the SCM callback — which is not a
 * theoretical shuffle: the two exchanges store their results in different
 * places, and a token minted for identity should never land in
 * `user_scm_tokens` because a redirect was swapped.
 */
export function newState(): string {
	return randomBytes(32).toString("base64url");
}

export function stateCookieOptions() {
	return {
		httpOnly: true,
		sameSite: "lax" as const,
		secure: process.env.NODE_ENV === "production",
		path: "/",
		maxAge: 600,
	};
}

export function readCookie(header: string | null, name: string): string | undefined {
	const match = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(header ?? "");
	return match?.[1];
}

export function statesMatch(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b) return false;
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

// ---------------------------------------------------------------------------
// The exchange
// ---------------------------------------------------------------------------

export type TokenExchange =
	| { kind: "granted"; token: StoredScmToken; scopes: string }
	| { kind: "refused"; message: string };

interface TokenResponse {
	access_token?: string;
	expires_in?: number;
	refresh_token?: string;
	refresh_token_expires_in?: number;
	scope?: string;
	error?: string;
	error_description?: string;
}

function secondsFromNow(seconds: number | undefined, now: Date): string | undefined {
	if (typeof seconds !== "number" || !Number.isFinite(seconds)) return undefined;
	return new Date(now.getTime() + seconds * 1000).toISOString();
}

/**
 * Trade the callback code for a token.
 *
 * `expires_in` is turned into an absolute instant here rather than stored as a
 * duration, because a duration is only meaningful next to the moment it was
 * issued and that moment is not in the row. `userScmToken` compares against
 * `access_token_expires_at`; a relative number would have it refreshing on a
 * clock that started when somebody read the row.
 */
export async function exchangeCode(input: {
	code: string;
	redirectUri: string;
	fetch?: FetchLike;
	now?: () => Date;
}): Promise<TokenExchange> {
	const doFetch = input.fetch ?? fetch;
	const now = (input.now ?? (() => new Date()))();

	const response = await doFetch("https://github.com/login/oauth/access_token", {
		method: "POST",
		headers: { accept: "application/json", "content-type": "application/json" },
		body: JSON.stringify({
			client_id: process.env.GITHUB_CLIENT_ID,
			client_secret: process.env.GITHUB_CLIENT_SECRET,
			code: input.code,
			redirect_uri: input.redirectUri,
		}),
	});

	const body = (await response.json()) as TokenResponse;
	if (!body.access_token) {
		return {
			kind: "refused",
			message: body.error_description ?? body.error ?? "GitHub rejected the code.",
		};
	}

	const token: StoredScmToken = { access_token: body.access_token };
	const accessExpiry = secondsFromNow(body.expires_in, now);
	if (accessExpiry) token.access_token_expires_at = accessExpiry;
	if (body.refresh_token) {
		token.refresh_token = body.refresh_token;
		const refreshExpiry = secondsFromNow(body.refresh_token_expires_in, now);
		if (refreshExpiry) token.refresh_token_expires_at = refreshExpiry;
	}

	return { kind: "granted", token, scopes: body.scope ?? "" };
}

export interface GitHubProfile {
	id: string;
	login: string;
	name: string | null;
	email: string | null;
}

export async function readProfile(
	accessToken: string,
	doFetch: FetchLike = fetch,
): Promise<GitHubProfile | null> {
	const response = await doFetch("https://api.github.com/user", {
		headers: { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json" },
	});
	const profile = (await response.json()) as {
		id?: number;
		login?: string;
		name?: string;
		email?: string;
	};
	if (!profile.id || !profile.login) return null;
	return {
		id: String(profile.id),
		login: profile.login,
		name: profile.name ?? profile.login,
		email: profile.email ?? null,
	};
}

/** The authorize URL, built the same way for both flows. */
export function authorizeUrl(input: { scopes: string; redirectUri: string; state: string }): string {
	const authorize = new URL("https://github.com/login/oauth/authorize");
	authorize.searchParams.set("client_id", process.env.GITHUB_CLIENT_ID as string);
	authorize.searchParams.set("redirect_uri", input.redirectUri);
	authorize.searchParams.set("scope", input.scopes);
	authorize.searchParams.set("state", input.state);
	return authorize.toString();
}
