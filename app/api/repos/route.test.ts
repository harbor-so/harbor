// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The repository surface, and the property it exists to preserve.
 *
 * The property lives in one function: `verifyRepoAccess`, asked with the
 * **requesting user's own** token, so that a shared app installation does not
 * become "everyone can reach everything the app can reach". That function was
 * written, documented and tested — and
 * `connectRepo`, its only caller, had no caller of its own. Repositories arrived
 * by direct insert, which is to say the check ran in zero production paths.
 *
 * These tests drive the HTTP doors and assert the check is on the path, that it
 * fails CLOSED on an unreadable answer, and that a viewer with no source-control
 * identity is refused with a reason they can act on rather than a 500.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, sql } from "@core/schema/index.js";
import { orgs, repos, users } from "@core/schema/schema.js";
import { clearRepoAccessCache } from "../../git/github.js";
import { forgetUserScmToken, storeUserScmToken } from "../../git/credentials.js";
import { signSession } from "../../lib/session.js";

process.env.HARBOR_ENCRYPTION_KEY ??= Buffer.alloc(32, 11).toString("base64");
process.env.AUTH_SECRET ??= "test-auth-secret-at-least-32-characters-long";

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

const { GET: getRepos, POST: postRepo } = await import("./route.js");
const { GET: getMetadata } = await import("./[owner]/[name]/metadata/route.js");
const { POST: postArchive } = await import("./[owner]/[name]/archive/route.js");

let orgId: string;
let userId: string;

/** GitHub, reduced to the two endpoints these routes touch. */
function stubGitHub(handlers: {
	repo?: (owner: string, name: string) => Response;
	list?: () => Response;
}) {
	vi.stubGlobal("fetch", async (url: string | URL | Request) => {
		const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
		const single = /\/repos\/([^/?]+)\/([^/?]+)/.exec(href);
		if (single && handlers.repo) return handlers.repo(single[1]!, single[2]!);
		if (href.includes("/user/repos") && handlers.list) return handlers.list();
		throw new Error(`unexpected fetch to ${href}`);
	});
}

const okRepo = (defaultBranch = "main") =>
	new Response(
		JSON.stringify({ default_branch: defaultBranch, permissions: { pull: true, push: true } }),
		{ status: 200 },
	);

const json = async (response: Response) => (await response.json()) as Record<string, never>;

beforeEach(async () => {
	await sql`truncate table cost_events, circuit_breakers, automation_runs, automations, artifacts, session_events, sandboxes, session_repos, secrets, user_scm_tokens, environment_repos, environments, repos, activity, session_prompts, session_participants, sessions, runs, agent_presence, events, claims, tasks, projects, api_keys, digests, connectors, users, orgs cascade`;
	const [org] = await db.insert(orgs).values({ name: "Repo Org" }).returning();
	orgId = org!.id;
	const [user] = await db
		.insert(users)
		.values({ orgId, githubId: "77", name: "Rin", email: "rin@example.com" })
		.returning();
	userId = user!.id;

	cookieJar.clear();
	cookieJar.set("harbor_session", signSession(userId));
	process.env.GITHUB_CLIENT_ID = "client-abc";
	process.env.GITHUB_CLIENT_SECRET = "secret-abc";
	await storeUserScmToken({
		orgId,
		userId,
		login: "rin",
		scopes: "repo",
		token: { access_token: "gho_viewer" },
	});

	clearRepoAccessCache();
	vi.unstubAllGlobals();
});

afterAll(async () => {
	vi.unstubAllGlobals();
	await sql.end();
});

describe("POST /api/repos — connecting", () => {
	const connect = (owner: string, name: string) =>
		postRepo(
			new Request("http://harbor.test/api/repos", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ owner, name }),
			}),
		);

	it("checks access with the viewer's own token and stores the real default branch", async () => {
		let sawAuthorization: string | null = null;
		vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
			sawAuthorization = new Headers(init?.headers).get("authorization");
			void url;
			return okRepo("develop");
		});

		const response = await connect("acme", "api");
		expect(response.status).toBe(200);

		// The user's token, not an installation token. This is the whole
		// multi-tenancy argument, asserted at the wire.
		expect(sawAuthorization).toContain("gho_viewer");

		const [row] = await db.select().from(repos).where(eq(repos.orgId, orgId));
		expect(row).toMatchObject({ owner: "acme", name: "api" });
		// Read from the API rather than defaulted to `main`, or every session on a
		// `develop` repo branches from a ref that does not exist.
		expect(row!.defaultBranch).toBe("develop");
	});

	it("refuses a repository the viewer cannot see, and writes nothing", async () => {
		// GitHub answers 404 rather than 403 for a private repo a token cannot see.
		stubGitHub({ repo: () => new Response("{}", { status: 404 }) });

		const response = await connect("someone-else", "secret");
		expect(response.status).toBe(403);
		expect((await json(response)).error).toContain("not visible");
		expect(await db.select().from(repos)).toHaveLength(0);
	});

	it("fails CLOSED when GitHub cannot answer", async () => {
		// Authority, not liveness: an answer we could not obtain is not an answer we
		// may assume. The opposite rule governs sandbox liveness, deliberately.
		stubGitHub({ repo: () => new Response("{}", { status: 500 }) });

		const response = await connect("acme", "api");
		expect(response.status).toBe(403);
		expect((await json(response)).error).toContain("500");
		expect(await db.select().from(repos)).toHaveLength(0);
	});

	it("refuses a viewer with no source-control identity, naming where to get one", async () => {
		await forgetUserScmToken(userId);

		const response = await connect("acme", "api");
		expect(response.status).toBe(403);
		const body = await json(response);
		expect(body.reason).toBe("no_scm_identity");
		expect(body.error).toContain("/api/auth/scm");
		expect(await db.select().from(repos)).toHaveLength(0);
	});

	it("distinguishes 'you have not connected one' from 'this deployment cannot'", async () => {
		// Both are `absent` and both refuse, but they are different problems with
		// different owners: one is fixed by the person clicking connect, the other
		// by whoever configures the deployment. Reporting the second as the first
		// sends a user to a button that cannot work.
		await forgetUserScmToken(userId);
		delete process.env.GITHUB_CLIENT_ID;

		const response = await connect("acme", "api");
		expect(response.status).toBe(403);
		expect((await json(response)).reason).toBe("deployment_has_no_scm_oauth");
	});

	it("rejects a malformed name before it reaches GitHub", async () => {
		const response = await connect("acme/../etc", "api");
		expect(response.status).toBe(403);
	});
});

describe("GET /api/repos", () => {
	it("lists what the org has connected", async () => {
		stubGitHub({ repo: () => okRepo() });
		await postRepo(
			new Request("http://harbor.test/api/repos", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ owner: "acme", name: "api" }),
			}),
		);

		const response = await getRepos(new Request("http://harbor.test/api/repos"));
		const body = (await response.json()) as { repos: Array<{ owner: string; name: string }> };
		expect(body.repos).toHaveLength(1);
		expect(body.repos[0]).toMatchObject({ owner: "acme", name: "api", default_branch: "main" });
	});

	it("?available=1 reads GitHub with the viewer's token and states truncation", async () => {
		stubGitHub({
			list: () =>
				new Response(
					JSON.stringify([
						{
							name: "api",
							owner: { login: "acme" },
							default_branch: "trunk",
							description: "The API",
							private: true,
							permissions: { pull: true, push: true },
						},
						// Unreadable entries are skipped rather than fabricated.
						{ name: "nameless" },
					]),
					{ status: 200, headers: { link: '<https://api.github.com/x?page=2>; rel="next"' } },
				),
		});

		const response = await getRepos(new Request("http://harbor.test/api/repos?available=1"));
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			repositories: Array<Record<string, unknown>>;
			truncated: boolean;
			listed_as: string;
		};
		expect(body.repositories).toEqual([
			{
				owner: "acme",
				name: "api",
				default_branch: "trunk",
				description: "The API",
				private: true,
				permission: "write",
			},
		]);
		// Stated, never hidden: a silently short list reads as "these are all my
		// repositories" to the person whose repository is missing.
		expect(body.truncated).toBe(true);
		expect(body.listed_as).toBe("rin");
	});

	it("?available=1 tells a person to reconnect on 401 and to retry on 503", async () => {
		stubGitHub({ list: () => new Response("{}", { status: 401 }) });
		const rejected = await getRepos(new Request("http://harbor.test/api/repos?available=1"));
		expect(rejected.status).toBe(403);
		expect((await json(rejected)).reason).toBe("token_invalid");

		stubGitHub({ list: () => new Response("{}", { status: 502 }) });
		const down = await getRepos(new Request("http://harbor.test/api/repos?available=1"));
		expect(down.status).toBe(503);
		expect((await json(down)).reason).toBe("upstream_unavailable");
	});
});

describe("GET /api/repos/[owner]/[name]/metadata", () => {
	it("reports both halves: our row, and whether this viewer may use it", async () => {
		stubGitHub({ repo: () => okRepo("develop") });
		await postRepo(
			new Request("http://harbor.test/api/repos", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ owner: "acme", name: "api" }),
			}),
		);
		clearRepoAccessCache();

		const response = await getMetadata(new Request("http://harbor.test/x"), {
			params: Promise.resolve({ owner: "acme", name: "api" }),
		});
		const body = (await response.json()) as {
			connected: { default_branch: string; archived: boolean } | null;
			access: { allowed: boolean; default_branch: string | null };
		};
		expect(body.connected).toMatchObject({ default_branch: "develop", archived: false });
		expect(body.access.allowed).toBe(true);
	});

	it("returns connected: null for a repository this org has not connected", async () => {
		stubGitHub({ repo: () => okRepo() });
		const response = await getMetadata(new Request("http://harbor.test/x"), {
			params: Promise.resolve({ owner: "acme", name: "unconnected" }),
		});
		const body = (await response.json()) as { connected: unknown; access: { allowed: boolean } };
		expect(body.connected).toBeNull();
		expect(body.access.allowed).toBe(true);
	});
});

describe("POST /api/repos/[owner]/[name]/archive", () => {
	async function connected() {
		stubGitHub({ repo: () => okRepo() });
		await postRepo(
			new Request("http://harbor.test/api/repos", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ owner: "acme", name: "api" }),
			}),
		);
	}

	const archiveRequest = (archived?: boolean) =>
		postArchive(
			new Request("http://harbor.test/x", {
				method: "POST",
				...(archived === undefined
					? {}
					: {
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ archived }),
						}),
			}),
			{ params: Promise.resolve({ owner: "acme", name: "api" }) },
		);

	it("hides it from the list and brings it back, keeping the row", async () => {
		await connected();

		expect((await archiveRequest()).status).toBe(200);
		const afterArchive = (await (
			await getRepos(new Request("http://harbor.test/api/repos"))
		).json()) as { repos: unknown[] };
		expect(afterArchive.repos).toHaveLength(0);
		// Archived, not deleted — `session_repos` is the record of what a session
		// actually worked on.
		expect(await db.select().from(repos)).toHaveLength(1);

		expect((await archiveRequest(false)).status).toBe(200);
		const afterRestore = (await (
			await getRepos(new Request("http://harbor.test/api/repos"))
		).json()) as { repos: unknown[] };
		expect(afterRestore.repos).toHaveLength(1);
	});

	it("is a 404 for a repository in another org, not a refusal that confirms it exists", async () => {
		const [other] = await db.insert(orgs).values({ name: "Other" }).returning();
		await db
			.insert(repos)
			.values({ orgId: other!.id, provider: "github", owner: "acme", name: "api" });

		const response = await archiveRequest();
		expect(response.status).toBe(404);
	});
});
