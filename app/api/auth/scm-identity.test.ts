// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The doors that put a token into `user_scm_tokens`, and what they refuse.
 *
 * The table, the encryption, the refresh-under-a-row-lock and the three-arm
 * authority union were all written and tested long before this. What did not
 * exist was anything that ever wrote a row — so `prAuthorityForUser` returned
 * `absent` on every deployment, every session handed back a compare URL, and
 * the product's central guarantee ("the human authors it, so they cannot approve
 * it") was unreachable rather than untrue.
 *
 * These tests drive the two doors that exist now and assert the three refusals
 * that matter, each of which is a way the guarantee could be lost quietly:
 *
 *  - connecting a DIFFERENT GitHub account than the signed-in one, which makes
 *    every PR authored by somebody the requester can then approve as;
 *  - a consent that came back WITHOUT `repo`, which would store a token that
 *    reports `user` authority and 403s at the API instead of degrading here;
 *  - disconnecting, which must leave NO row — `absent`, degraded loudly — rather
 *    than an unreadable one, which is `indeterminate` and retried forever.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, sql } from "@core/schema/index.js";
import { orgs, users, userScmTokens } from "@core/schema/schema.js";
import { prAuthorityForUser, scmIdentitySummary } from "../../git/credentials.js";
import { signSession } from "../../lib/session.js";

process.env.HARBOR_ENCRYPTION_KEY ??= Buffer.alloc(32, 9).toString("base64");
process.env.AUTH_SECRET ??= "test-auth-secret-at-least-32-characters-long";

// The routes read the viewer from a cookie through next/headers, which only
// exists inside a Next request scope. `cookieJar` is what the stub serves, so a
// test can be signed in as a specific user by writing one entry.
const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
	cookies: async () => ({
		get: (name: string) => {
			const value = cookieJar.get(name);
			return value === undefined ? undefined : { name, value };
		},
		set: () => {},
		delete: () => {},
	}),
}));

const { GET: startConnect } = await import("./scm/route.js");
const { GET: finishConnect } = await import("./scm/callback/route.js");
const { POST: disconnect } = await import("./scm/disconnect/route.js");

let orgId: string;
let userId: string;

const SIGNED_IN_GITHUB_ID = "4242";

/**
 * GitHub, as far as these routes can tell: one token exchange and one profile
 * read, in that order.
 */
function stubGitHub(input: { scope: string; githubId: string; login: string }) {
	vi.stubGlobal("fetch", async (url: string | URL | Request) => {
		const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
		if (href.includes("login/oauth/access_token")) {
			return new Response(
				JSON.stringify({ access_token: "gho_test", scope: input.scope, expires_in: 28_800 }),
				{ status: 200 },
			);
		}
		if (href.includes("api.github.com/user")) {
			return new Response(
				JSON.stringify({ id: Number(input.githubId), login: input.login, email: null }),
				{ status: 200 },
			);
		}
		throw new Error(`unexpected fetch to ${href}`);
	});
}

const callbackRequest = (state: string) =>
	new Request(`http://harbor.test/api/auth/scm/callback?code=abc&state=${state}`, {
		headers: { cookie: `harbor_scm_state=${state}` },
	});

const storedRows = async () =>
	db.select().from(userScmTokens).where(eq(userScmTokens.userId, userId));

beforeEach(async () => {
	await sql`truncate table cost_events, circuit_breakers, automation_runs, automations, artifacts, session_events, sandboxes, session_repos, secrets, user_scm_tokens, environment_repos, environments, repos, activity, session_prompts, session_participants, sessions, runs, agent_presence, events, claims, tasks, projects, api_keys, digests, connectors, users, orgs cascade`;
	const [org] = await db.insert(orgs).values({ name: "Attribution Org" }).returning();
	orgId = org!.id;
	const [user] = await db
		.insert(users)
		.values({ orgId, githubId: SIGNED_IN_GITHUB_ID, name: "Rin", email: "rin@example.com" })
		.returning();
	userId = user!.id;

	cookieJar.clear();
	cookieJar.set("harbor_session", signSession(userId));
	process.env.GITHUB_CLIENT_ID = "client-abc";
	process.env.GITHUB_CLIENT_SECRET = "secret-abc";
	vi.unstubAllGlobals();
});

afterAll(async () => {
	vi.unstubAllGlobals();
	delete process.env.GITHUB_CLIENT_ID;
	delete process.env.GITHUB_CLIENT_SECRET;
	await sql.end();
});

describe("GET /api/auth/scm — starting the consent", () => {
	it("asks for repo, on its own state cookie", async () => {
		const response = await startConnect(new Request("http://harbor.test/api/auth/scm"));
		expect(response.status).toBe(307);

		const authorize = new URL(response.headers.get("location")!);
		expect(authorize.searchParams.get("scope")).toBe("repo");
		expect(authorize.searchParams.get("redirect_uri")).toBe(
			"http://harbor.test/api/auth/scm/callback",
		);
		// Its own cookie, so a sign-in callback cannot be replayed into this flow.
		expect(response.headers.get("set-cookie")).toContain("harbor_scm_state=");
	});

	it("refuses when there is no signed-in user to store an identity against", async () => {
		cookieJar.clear();
		const response = await startConnect(new Request("http://harbor.test/api/auth/scm"));
		expect(response.status).toBe(401);
	});

	it("refuses when the deployment has no OAuth app at all", async () => {
		delete process.env.GITHUB_CLIENT_ID;
		const response = await startConnect(new Request("http://harbor.test/api/auth/scm"));
		expect(response.status).toBe(503);
	});
});

describe("GET /api/auth/scm/callback — finishing it", () => {
	it("stores the token and makes the user authority available", async () => {
		stubGitHub({ scope: "repo", githubId: SIGNED_IN_GITHUB_ID, login: "rin" });

		const response = await finishConnect(callbackRequest("state-ok"));
		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe("http://harbor.test/settings");

		const rows = await storedRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]!.login).toBe("rin");
		expect(rows[0]!.scopes).toBe("repo");
		// Never the token itself: the column is an encrypted envelope.
		expect(rows[0]!.ciphertext).not.toContain("gho_test");

		const authority = await prAuthorityForUser(userId);
		expect(authority.kind).toBe("user");

		const summary = await scmIdentitySummary(userId);
		expect(summary).toMatchObject({ connected: true, login: "rin", scopes: "repo" });
		expect(summary.expires_at).not.toBeNull();
	});

	it("refuses a different GitHub account than the signed-in one, storing nothing", async () => {
		stubGitHub({ scope: "repo", githubId: "9999", login: "shared-bot" });

		const response = await finishConnect(callbackRequest("state-mismatch"));
		expect(response.status).toBe(409);
		expect(((await response.json()) as { error: string }).error).toContain("shared-bot");
		expect(await storedRows()).toHaveLength(0);
	});

	it("refuses a grant that came back without repo, and says why", async () => {
		stubGitHub({ scope: "read:user", githubId: SIGNED_IN_GITHUB_ID, login: "rin" });

		const response = await finishConnect(callbackRequest("state-narrow"));
		expect(response.status).toBe(403);
		expect(((await response.json()) as { error: string }).error).toContain("read:user");
		expect(await storedRows()).toHaveLength(0);
	});

	it("refuses a state that did not come from /api/auth/scm", async () => {
		stubGitHub({ scope: "repo", githubId: SIGNED_IN_GITHUB_ID, login: "rin" });

		const forged = new Request("http://harbor.test/api/auth/scm/callback?code=abc&state=theirs", {
			headers: { cookie: "harbor_scm_state=ours" },
		});
		const response = await finishConnect(forged);
		expect(response.status).toBe(400);
		expect(await storedRows()).toHaveLength(0);
	});
});

describe("POST /api/auth/scm/disconnect", () => {
	it("removes the row entirely, so authority is absent rather than indeterminate", async () => {
		stubGitHub({ scope: "repo", githubId: SIGNED_IN_GITHUB_ID, login: "rin" });
		await finishConnect(callbackRequest("state-ok"));
		expect(await storedRows()).toHaveLength(1);

		const response = await disconnect();
		expect(response.status).toBe(200);
		const body = (await response.json()) as { disconnected: boolean; consequence: string };
		expect(body.disconnected).toBe(true);
		// The person clicking this should read what it costs before the first pull
		// request quietly fails to appear.
		expect(body.consequence).toContain("compare URL");

		expect(await storedRows()).toHaveLength(0);
		const authority = await prAuthorityForUser(userId);
		expect(authority.kind).toBe("absent");
		if (authority.kind !== "absent") return;
		expect(authority.reason).toBe("no_scm_identity");
	});

	it("is idempotent — a second click is not an error", async () => {
		const response = await disconnect();
		expect(response.status).toBe(200);
		expect(((await response.json()) as { disconnected: boolean }).disconnected).toBe(false);
	});
});
