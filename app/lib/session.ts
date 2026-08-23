// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Who is looking at the dashboard.
 *
 * GitHub OAuth, because the target user already has a GitHub account and
 * building email infrastructure for a pilot is work that teaches you nothing.
 *
 * There is a development bypass, and it is deliberate and narrow. Without it the
 * dashboard cannot be opened at all until someone registers an OAuth app, which
 * means `docker compose up && npm run dev` — the ten-minute path the README
 * promises — would not actually show anything. So: when `GITHUB_CLIENT_ID` is
 * unset AND `NODE_ENV` is not production, the dashboard resolves to the first
 * org in the database and says so in the header.
 *
 * The bypass refuses to engage in production even if the env var is missing,
 * because the failure mode of getting that backwards is an unauthenticated
 * dashboard on the internet. A missing client id in production is a
 * misconfiguration and is treated as one.
 */

import { cookies } from "next/headers";
import { createHmac, timingSafeEqual } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { setting } from "@core/kernel/config.js";
import { db } from "@core/schema/index.js";
import { orgs, users } from "@core/schema/schema.js";

const COOKIE = "harbor_session";

export interface Session {
	orgId: string;
	orgName: string;
	/** The signed-in user's id, or null under the dev bypass. Lets a human's chat
	 * principal (a keypair) be tied back to who registered it. */
	userId: string | null;
	userName: string | null;
	/**
	 * The viewer's email from their GitHub sign-in, when the profile exposes
	 * one. This is what makes an `attributed-user` prompt possible: the commands
	 * route can only claim a commit's authorship when there is an identity to
	 * claim it FOR. Null degrades the viewer's prompts to `agent-only` — bot
	 * commits, honestly labelled — never to a refusal.
	 */
	userEmail: string | null;
	/** True when this session came from the dev bypass rather than a real login. */
	unauthenticated: boolean;
}

const DEV_SECRET = "harbor-dev-secret-not-for-production";
// harbor-lint-allow-constant: a security floor, not a tunable — the only
// direction an operator would ever move it is down, and 32 bytes is the
// minimum for the HMAC key to be as strong as the HMAC.
const MIN_SECRET_LENGTH = 32;

/**
 * The HMAC key for session cookies.
 *
 * This used to be `process.env.AUTH_SECRET ?? DEV_SECRET`, which is wrong twice.
 * `??` does not catch the empty string, and `.env.example` shipped a bare
 * `AUTH_SECRET=` — so the common case was signing with the empty key, which any
 * reader of this public repo can reproduce byte for byte. Falling back to the
 * constant is no better: it is also published here. A forged cookie is a full
 * dashboard session, and the dashboard can mint permanent MCP credentials.
 *
 * So: in production a real secret is required and its absence is fatal at the
 * first request rather than silently insecure. Outside production the dev
 * constant is used, but only when the variable is genuinely unset — a short or
 * blank value is a misconfiguration and is rejected everywhere.
 */
function secret(): string {
	const configured = process.env.AUTH_SECRET?.trim();

	if (configured) {
		if (configured.length < MIN_SECRET_LENGTH) {
			throw new Error(
				`AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters. `
					+ "Generate one with: openssl rand -base64 32",
			);
		}
		return configured;
	}

	if (process.env.NODE_ENV === "production") {
		throw new Error(
			"AUTH_SECRET is required in production. Generate one with: openssl rand -base64 32",
		);
	}
	return DEV_SECRET;
}

/** `<userId>.<hmac>` — signed, not encrypted; it carries no secret of its own. */
export function signSession(userId: string): string {
	const mac = createHmac("sha256", secret()).update(userId).digest("base64url");
	return `${userId}.${mac}`;
}

export function verifySession(token: string | undefined): string | null {
	if (!token) return null;
	const cut = token.lastIndexOf(".");
	if (cut <= 0) return null;
	const userId = token.slice(0, cut);
	const supplied = Buffer.from(token.slice(cut + 1));
	const expected = Buffer.from(
		createHmac("sha256", secret()).update(userId).digest("base64url"),
	);
	if (supplied.length !== expected.length) return null;
	return timingSafeEqual(supplied, expected) ? userId : null;
}

export const sessionCookie = {
	name: COOKIE,
	options: {
		httpOnly: true,
		sameSite: "lax" as const,
		secure: process.env.NODE_ENV === "production",
		path: "/",
		maxAge: setting("sessionCookieMaxAgeSeconds"),
	},
};

export function oauthConfigured(): boolean {
	return Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
}

export async function currentSession(): Promise<Session | null> {
	const token = (await cookies()).get(COOKIE)?.value;
	const userId = verifySession(token);

	if (userId) {
		const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
		if (user) {
			const org = await db.query.orgs.findFirst({ where: eq(orgs.id, user.orgId) });
			if (org) {
				return {
					orgId: org.id,
					orgName: org.name,
					userId: user.id,
					userName: user.name,
					userEmail: user.email,
					unauthenticated: false,
				};
			}
		}
	}

	if (oauthConfigured() || process.env.NODE_ENV === "production") return null;

	const [org] = await db.select().from(orgs).orderBy(asc(orgs.createdAt)).limit(1);
	if (!org) return null;
	return {
		orgId: org.id,
		orgName: org.name,
		userId: null,
		userName: null,
		userEmail: null,
		unauthenticated: true,
	};
}
