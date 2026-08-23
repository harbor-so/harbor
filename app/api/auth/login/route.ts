// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { NextResponse } from "next/server";
import { authorizeUrl, newState, signInScopes, stateCookieOptions } from "../../../lib/github-oauth.js";
import { oauthConfigured } from "../../../lib/session.js";

/**
 * Start GitHub OAuth, with a state parameter.
 *
 * The state was missing, which made this login-CSRF-able: a victim who loaded
 * the attacker's callback URL got a session for the ATTACKER's account, and any
 * API key they then minted landed in the attacker's org. The random value goes
 * into a short-lived httpOnly cookie and is compared in constant time on the way
 * back, so a callback that did not originate here is refused.
 *
 * The scopes come from `signInScopes()` and default to `read:user` — an identity
 * to attach a session to and nothing else. An operator can widen them to include
 * `repo` so that signing in also connects a pull-request authorship identity;
 * the reason that is not the default, and the separate consent that exists
 * instead, are in `src/lib/github-oauth.ts`.
 */
export async function GET(request: Request) {
	if (!oauthConfigured()) {
		return NextResponse.json(
			{ error: "GitHub OAuth is not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET." },
			{ status: 503 },
		);
	}

	const state = newState();
	const response = NextResponse.redirect(
		authorizeUrl({
			scopes: signInScopes(),
			redirectUri: new URL("/api/auth/callback", request.url).toString(),
			state,
		}),
	);
	response.cookies.set("harbor_oauth_state", state, stateCookieOptions());
	return response;
}
