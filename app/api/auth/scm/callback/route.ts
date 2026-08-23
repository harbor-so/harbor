// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@core/schema/index.js";
import { users } from "@core/schema/schema.js";
import { storeUserScmToken } from "../../../../git/credentials.js";
import {
	SCM_AUTHORSHIP_SCOPE,
	exchangeCode,
	grantsAuthorship,
	readCookie,
	readProfile,
	statesMatch,
} from "../../../../lib/github-oauth.js";
import { currentSession, oauthConfigured } from "../../../../lib/session.js";

/**
 * Finish connecting a source-control identity.
 *
 * Three refusals here, and each one is a property that would otherwise be lost
 * quietly:
 *
 *  - **State mismatch.** Same CSRF argument as sign-in, on its own cookie so a
 *    sign-in callback cannot be replayed into this one.
 *  - **A different GitHub account than the one signed in.** Harbor's guarantee is
 *    that a pull request is authored by *the person who asked for the work*. If
 *    Ana signs in as `ana` and connects `shared-bot`, every PR from her prompts
 *    is authored by `shared-bot` and she can approve it — the self-approval
 *    guarantee is gone and nothing anywhere records that it went. So the
 *    connected account must be the signed-in account.
 *  - **A grant that came back without `repo`.** GitHub lets a user complete the
 *    consent screen having declined the organisation that actually matters.
 *    Storing that token would make `prAuthorityForUser` return `user`, and the
 *    PR attempt would fail at the API instead of degrading loudly here.
 */
export async function GET(request: Request) {
	if (!oauthConfigured()) {
		return NextResponse.json({ error: "GitHub OAuth is not configured." }, { status: 503 });
	}

	const session = await currentSession();
	if (!session || !session.userId) {
		return NextResponse.json({ error: "Sign in first." }, { status: 401 });
	}

	const url = new URL(request.url);
	const code = url.searchParams.get("code");
	if (!code) return NextResponse.redirect(new URL("/settings", request.url));

	const cookieState = readCookie(request.headers.get("cookie"), "harbor_scm_state");
	if (!statesMatch(url.searchParams.get("state") ?? undefined, cookieState)) {
		return NextResponse.json({ error: "Invalid OAuth state." }, { status: 400 });
	}

	const exchange = await exchangeCode({
		code,
		redirectUri: new URL("/api/auth/scm/callback", request.url).toString(),
	});
	if (exchange.kind === "refused") {
		return NextResponse.json({ error: exchange.message }, { status: 401 });
	}

	const profile = await readProfile(exchange.token.access_token);
	if (!profile) {
		return NextResponse.json({ error: "Could not read GitHub profile." }, { status: 401 });
	}

	const user = await db.query.users.findFirst({ where: eq(users.id, session.userId) });
	if (!user) {
		return NextResponse.json({ error: "Sign in first." }, { status: 401 });
	}

	if (user.githubId !== profile.id) {
		return NextResponse.json(
			{
				error:
					`You are signed in to Harbor as a different GitHub account than the one you just `
					+ `authorised (${profile.login}). Harbor opens pull requests as the person who asked `
					+ "for the work, so the connected account has to be the signed-in account — "
					+ "otherwise the requester could approve their own agent's changes. Sign out of "
					+ "GitHub, or sign in to Harbor as that account, and try again.",
			},
			{ status: 409 },
		);
	}

	if (!grantsAuthorship(exchange.scopes)) {
		return NextResponse.json(
			{
				error:
					`GitHub returned the scopes "${exchange.scopes || "(none)"}" and Harbor needs `
					+ `"${SCM_AUTHORSHIP_SCOPE}" to open a pull request as you. Nothing was stored. `
					+ "This usually means an organisation was left un-approved on the consent screen; "
					+ "an organisation owner has to grant access before it can be ticked.",
			},
			{ status: 403 },
		);
	}

	await storeUserScmToken({
		orgId: user.orgId,
		userId: user.id,
		login: profile.login,
		email: profile.email,
		scopes: exchange.scopes,
		token: exchange.token,
	});

	const response = NextResponse.redirect(new URL("/settings", request.url));
	response.cookies.delete("harbor_scm_state");
	return response;
}
