// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The OAuth mechanics, and the two places a plausible implementation is wrong.
 *
 * First: authorship is decided by what GitHub RETURNED, never by what Harbor
 * asked for. A user can complete the consent screen having declined the one
 * organisation that matters, and a deployment that trusts the request believes
 * attribution holds when every pull request will 403.
 *
 * Second: `expires_in` is a duration relative to the instant of issue, and that
 * instant is not stored anywhere. Persisting the duration and comparing it later
 * produces a token that refreshes on a clock which started when somebody read
 * the row. It is converted to an absolute instant here, at the only moment the
 * relationship is knowable.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	SCM_AUTHORSHIP_SCOPE,
	authorizeUrl,
	exchangeCode,
	grantsAuthorship,
	parseScopes,
	readCookie,
	signInGrantsAuthorship,
	signInScopes,
	statesMatch,
} from "./github-oauth.js";

const saved = process.env.HARBOR_GITHUB_OAUTH_SCOPES;
afterEach(() => {
	if (saved === undefined) delete process.env.HARBOR_GITHUB_OAUTH_SCOPES;
	else process.env.HARBOR_GITHUB_OAUTH_SCOPES = saved;
});

describe("scopes", () => {
	it("splits both spellings GitHub uses", () => {
		expect(parseScopes("read:user,repo")).toEqual(["read:user", "repo"]);
		expect(parseScopes("read:user, repo")).toEqual(["read:user", "repo"]);
		expect(parseScopes("")).toEqual([]);
		expect(parseScopes(null)).toEqual([]);
	});

	it("treats public_repo as insufficient for authorship", () => {
		// It would author pull requests on public repositories and fail on private
		// ones, which is a deployment where the guarantee holds for some repos and
		// not others — worse than one where it plainly does not hold.
		expect(grantsAuthorship("public_repo")).toBe(false);
		expect(grantsAuthorship(SCM_AUTHORSHIP_SCOPE)).toBe(true);
		expect(grantsAuthorship("read:user,repo")).toBe(true);
	});

	it("defaults sign-in to identity only", () => {
		delete process.env.HARBOR_GITHUB_OAUTH_SCOPES;
		expect(signInScopes()).toBe("read:user");
		expect(signInGrantsAuthorship()).toBe(false);
	});

	it("lets an operator opt into one flow, and keeps read:user when they forget it", () => {
		process.env.HARBOR_GITHUB_OAUTH_SCOPES = "repo";
		expect(signInScopes()).toBe("read:user,repo");
		expect(signInGrantsAuthorship()).toBe(true);
	});
});

describe("state", () => {
	it("refuses a missing, short or mismatched state", () => {
		expect(statesMatch(undefined, "abc")).toBe(false);
		expect(statesMatch("abc", undefined)).toBe(false);
		expect(statesMatch("abc", "abcd")).toBe(false);
		expect(statesMatch("abc", "abc")).toBe(true);
	});

	it("reads its own cookie out of a header carrying several", () => {
		const header = "harbor_session=xyz; harbor_scm_state=state-two; harbor_oauth_state=state-one";
		expect(readCookie(header, "harbor_scm_state")).toBe("state-two");
		expect(readCookie(header, "harbor_oauth_state")).toBe("state-one");
		expect(readCookie(header, "absent")).toBeUndefined();
		expect(readCookie(null, "harbor_scm_state")).toBeUndefined();
	});
});

describe("exchangeCode", () => {
	const at = new Date("2026-08-13T12:00:00.000Z");

	function respondWith(body: unknown) {
		return async () => new Response(JSON.stringify(body), { status: 200 }) as never;
	}

	it("turns expires_in into an absolute instant", async () => {
		const result = await exchangeCode({
			code: "c",
			redirectUri: "http://harbor.test/api/auth/scm/callback",
			now: () => at,
			fetch: respondWith({
				access_token: "gho_live",
				expires_in: 28_800,
				refresh_token: "ghr_live",
				refresh_token_expires_in: 15_811_200,
				scope: "repo",
			}),
		});

		expect(result.kind).toBe("granted");
		if (result.kind !== "granted") return;
		expect(result.token.access_token).toBe("gho_live");
		expect(result.token.access_token_expires_at).toBe("2026-08-13T20:00:00.000Z");
		expect(result.token.refresh_token).toBe("ghr_live");
		// 15,811,200s is GitHub's six-month refresh window — 183 days.
		expect(result.token.refresh_token_expires_at).toBe("2027-02-12T12:00:00.000Z");
		expect(result.scopes).toBe("repo");
	});

	it("leaves expiry absent for a token that does not expire", async () => {
		const result = await exchangeCode({
			code: "c",
			redirectUri: "http://harbor.test/api/auth/callback",
			now: () => at,
			fetch: respondWith({ access_token: "gho_forever", scope: "read:user" }),
		});

		expect(result.kind).toBe("granted");
		if (result.kind !== "granted") return;
		// `stillFresh` reads "no expiry" as fresh forever, which is correct for a
		// classic OAuth App grant and wrong for a zero it invented.
		expect(result.token.access_token_expires_at).toBeUndefined();
		expect(result.token.refresh_token).toBeUndefined();
	});

	it("reports GitHub's own refusal rather than a generic one", async () => {
		const result = await exchangeCode({
			code: "stale",
			redirectUri: "http://harbor.test/api/auth/callback",
			fetch: respondWith({
				error: "bad_verification_code",
				error_description: "The code passed is incorrect or expired.",
			}),
		});

		expect(result).toEqual({
			kind: "refused",
			message: "The code passed is incorrect or expired.",
		});
	});
});

describe("authorizeUrl", () => {
	it("carries the scopes, redirect and state", () => {
		process.env.GITHUB_CLIENT_ID = "client-abc";
		const url = new URL(
			authorizeUrl({
				scopes: "repo",
				redirectUri: "http://harbor.test/api/auth/scm/callback",
				state: "s",
			}),
		);
		expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
		expect(url.searchParams.get("scope")).toBe("repo");
		expect(url.searchParams.get("redirect_uri")).toBe(
			"http://harbor.test/api/auth/scm/callback",
		);
		expect(url.searchParams.get("state")).toBe("s");
	});
});
