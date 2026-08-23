// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { NextResponse } from "next/server";
import {
	SCM_AUTHORSHIP_SCOPE,
	authorizeUrl,
	newState,
	stateCookieOptions,
} from "../../../lib/github-oauth.js";
import { currentSession, oauthConfigured } from "../../../lib/session.js";

/**
 * Connect a source-control identity, so Harbor can open pull requests as you.
 *
 * A second, deliberate consent rather than a scope bolted onto sign-in. The
 * grant being asked for here — `repo` — is write access to everything the
 * person can push to, and the honest place to ask for that is the moment they
 * want the thing it buys, next to a sentence saying what it buys. Bundling it
 * into the login button gets it granted by people who never read it, which is
 * the same outcome as not asking.
 *
 * This flow requires an existing dashboard session: the token is stored against
 * a user row, and there is no user row until sign-in has happened. Under the
 * development bypass there is no user at all, and the refusal says so rather
 * than storing the identity against whoever happens to be first in the table.
 */
export async function GET(request: Request) {
	if (!oauthConfigured()) {
		return NextResponse.json(
			{
				error:
					"GitHub OAuth is not configured, so no user can connect a source-control "
					+ "identity. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.",
			},
			{ status: 503 },
		);
	}

	const session = await currentSession();
	if (!session || !session.userId) {
		return NextResponse.json(
			{
				error:
					"Sign in first. A source-control identity is stored against a user, and the "
					+ "development bypass has no user to store it against.",
			},
			{ status: 401 },
		);
	}

	const state = newState();
	const response = NextResponse.redirect(
		authorizeUrl({
			scopes: SCM_AUTHORSHIP_SCOPE,
			redirectUri: new URL("/api/auth/scm/callback", request.url).toString(),
			state,
		}),
	);
	response.cookies.set("harbor_scm_state", state, stateCookieOptions());
	return response;
}
