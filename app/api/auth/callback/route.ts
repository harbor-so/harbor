// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@core/schema/index.js";
import { orgs, users } from "@core/schema/schema.js";
import { storeUserScmToken } from "../../../git/credentials.js";
import {
	exchangeCode,
	grantsAuthorship,
	readCookie,
	readProfile,
	statesMatch,
} from "../../../lib/github-oauth.js";
import { oauthConfigured, sessionCookie, signSession } from "../../../lib/session.js";

/**
 * Who is allowed to become a member on first sign-in.
 *
 * This gate did not exist, and its absence was the most serious hole in the
 * product: any GitHub user on the internet who reached the deployed URL was
 * inserted into the first org and could then mint a permanent MCP API key from
 * the dashboard. Completing GitHub OAuth is unauthenticated by design, so
 * nothing upstream was stopping them.
 *
 * An allowlist rather than an invitations table because a pilot has one team and
 * a table is a schema, a UI and an email flow to maintain. An empty allowlist in
 * production is a refusal, never an open door — the failure mode of getting that
 * backwards is the hole this closes.
 */
function allowedLogins(): Set<string> {
	return new Set(
		(process.env.HARBOR_ALLOWED_GITHUB_LOGINS ?? "")
			.split(",")
			.map((login) => login.trim().toLowerCase())
			.filter(Boolean),
	);
}

export async function GET(request: Request) {
	if (!oauthConfigured()) {
		return NextResponse.json({ error: "GitHub OAuth is not configured." }, { status: 503 });
	}

	const url = new URL(request.url);
	const code = url.searchParams.get("code");
	if (!code) return NextResponse.redirect(new URL("/", request.url));

	// Reject a callback that did not start at /api/auth/login.
	const cookieState = readCookie(request.headers.get("cookie"), "harbor_oauth_state");
	if (!statesMatch(url.searchParams.get("state") ?? undefined, cookieState)) {
		return NextResponse.json({ error: "Invalid OAuth state." }, { status: 400 });
	}

	const exchange = await exchangeCode({
		code,
		redirectUri: new URL("/api/auth/callback", request.url).toString(),
	});
	if (exchange.kind === "refused") {
		return NextResponse.json({ error: exchange.message }, { status: 401 });
	}

	const profile = await readProfile(exchange.token.access_token);
	if (!profile) {
		return NextResponse.json({ error: "Could not read GitHub profile." }, { status: 401 });
	}

	let user = await db.query.users.findFirst({ where: eq(users.githubId, profile.id) });

	if (!user) {
		const allowed = allowedLogins();
		if (!allowed.has(profile.login.toLowerCase())) {
			return NextResponse.json(
				{
					error:
						"This GitHub account is not authorised for this Harbor instance. "
						+ "Ask an administrator to add it to HARBOR_ALLOWED_GITHUB_LOGINS.",
				},
				{ status: 403 },
			);
		}

		const [org] = await db.select().from(orgs).orderBy(asc(orgs.createdAt)).limit(1);
		if (!org) {
			return NextResponse.json(
				{ error: "No organisation exists yet. Run npm run db:seed." },
				{ status: 409 },
			);
		}
		[user] = await db
			.insert(users)
			.values({
				orgId: org.id,
				githubId: profile.id,
				name: profile.name ?? profile.login,
				email: profile.email ?? null,
			})
			.returning();
	}

	// The one-flow deployment: sign-in was configured to ask for `repo`, GitHub
	// actually granted it, so the same token becomes this user's authorship
	// identity. The check is on what came BACK, not on what was asked for — a
	// user can decline an organisation on the consent screen and still complete
	// sign-in, and storing that token as authorship-capable would produce a
	// deployment that believes attribution holds when it does not.
	if (grantsAuthorship(exchange.scopes)) {
		await storeUserScmToken({
			orgId: user!.orgId,
			userId: user!.id,
			login: profile.login,
			email: profile.email,
			scopes: exchange.scopes,
			token: exchange.token,
		});
	}

	const response = NextResponse.redirect(new URL("/", request.url));
	response.cookies.set(sessionCookie.name, signSession(user!.id), sessionCookie.options);
	response.cookies.delete("harbor_oauth_state");
	return response;
}
