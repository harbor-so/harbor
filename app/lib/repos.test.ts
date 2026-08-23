// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Repository access, which is the multi-tenancy fix.
 *
 * With one shared App installation and no per-user check, any user of the
 * deployment reaches any repository the App is installed on. These tests are the
 * assertion that Harbor does not do that — and
 * in particular that the check fails CLOSED, because a check that fails open under
 * load is worse than none: it works in every test and grants access in exactly the
 * conditions somebody is looking for a way in.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, sql } from "@core/schema/index.js";
import { orgs, repos, sessionRepos, sessions } from "@core/schema/schema.js";
import { createSession } from "./sessions.js";
import {
	archiveRepo,
	assertRepoAccess,
	connectRepo,
	createEnvironment,
	listRepos,
	snapshotSessionRepos,
	verifyRepoAccess,
} from "./repos.js";

let orgId: string;

/** A fabricated GitHub. No network, so the suite survives CI being offline. */
const github = (
	status: number,
	body: Record<string, unknown> = {},
): typeof fetch =>
	(async () =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		})) as unknown as typeof fetch;

const ok = github(200, { default_branch: "trunk", permissions: { pull: true } });

beforeEach(async () => {
	await sql`truncate table cost_events, circuit_breakers, automation_runs, automations, artifacts, session_events, sandboxes, session_repos, secrets, user_scm_tokens, environment_repos, environments, repos, activity, session_prompts, session_participants, sessions, runs, agent_presence, events, claims, tasks, projects, api_keys, digests, connectors, users, orgs cascade`;
	const [org] = await db.insert(orgs).values({ name: "Repo Org" }).returning();
	orgId = org!.id;
});

afterAll(async () => {
	await sql.end();
});

describe("verifyRepoAccess", () => {
	it("allows a repository the user can pull", async () => {
		const result = await verifyRepoAccess("tok", "acme", "api", ok);
		expect(result.allowed).toBe(true);
		expect(result.defaultBranch).toBe("trunk");
	});

	/**
	 * GitHub returns 404 rather than 403 for a private repository a token cannot
	 * see, so that the existence of a private repo is not leaked. Both mean the
	 * same thing here and neither is worth retrying.
	 */
	it("denies on 404 and on 403", async () => {
		expect((await verifyRepoAccess("tok", "acme", "api", github(404))).allowed).toBe(false);
		expect((await verifyRepoAccess("tok", "acme", "api", github(403))).allowed).toBe(false);
	});

	/**
	 * The most important assertion in the file. A 5xx is an answer we could not
	 * obtain, and an answer we could not obtain is not an answer we may assume.
	 * The opposite rule governs sandbox liveness, and the asymmetry is the subject
	 * of ADR 0003.
	 */
	it("FAILS CLOSED on a 5xx, and says so in the reason", async () => {
		const result = await verifyRepoAccess("tok", "acme", "api", github(503));
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("treats an unreadable permission as denied");
	});

	it("fails closed when the request throws", async () => {
		const throwing = (async () => {
			throw new Error("ECONNRESET");
		}) as unknown as typeof fetch;
		const result = await verifyRepoAccess("tok", "acme", "api", throwing);
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("Treated as denied");
	});

	/**
	 * `permissions.pull` is only present on a user token. Its absence means we were
	 * handed something else — an App installation token, most likely — and that is a
	 * programming error rather than a permission grant.
	 */
	it("denies when the token can see the repo but cannot pull", async () => {
		const result = await verifyRepoAccess(
			"tok",
			"acme",
			"api",
			github(200, { default_branch: "main", permissions: { pull: false } }),
		);
		expect(result.allowed).toBe(false);
	});
});

describe("connectRepo", () => {
	it("stores the default branch reported by the API rather than guessing main", async () => {
		const repo = await connectRepo(
			{ orgId, owner: "acme", name: "api", userToken: "tok" },
			ok,
		);
		// A repository whose default is `master` or `develop` would otherwise have
		// every session branch from a ref that does not exist, and the failure
		// surfaces inside sandbox boot where it is least legible.
		expect(repo.defaultBranch).toBe("trunk");
	});

	it("refuses a repository the user cannot access", async () => {
		await expect(
			connectRepo({ orgId, owner: "acme", name: "secret", userToken: "tok" }, github(404)),
		).rejects.toThrow(/not visible to your account/);
		expect(await listRepos(orgId)).toHaveLength(0);
	});

	it("is idempotent and un-archives on reconnect", async () => {
		const first = await connectRepo({ orgId, owner: "acme", name: "api", userToken: "tok" }, ok);
		await archiveRepo(orgId, first.id);
		expect(await listRepos(orgId)).toHaveLength(0);

		const second = await connectRepo({ orgId, owner: "acme", name: "api", userToken: "tok" }, ok);
		expect(second.id).toBe(first.id);
		expect(await listRepos(orgId)).toHaveLength(1);
	});

	it("rejects something that is not a repository name", async () => {
		await expect(
			connectRepo({ orgId, owner: "acme/../etc", name: "api", userToken: "tok" }, ok),
		).rejects.toThrow(/is not a repository name/);
	});
});

describe("assertRepoAccess", () => {
	/**
	 * Access is not permanent — people leave teams, repositories are made private,
	 * installations are removed. Checking only at connect time means a user keeps
	 * access to a repository they were removed from for as long as the row lives.
	 */
	it("re-checks at session creation and denies a revoked user", async () => {
		const repo = await connectRepo({ orgId, owner: "acme", name: "api", userToken: "tok" }, ok);
		await expect(assertRepoAccess(orgId, repo.id, "tok", ok)).resolves.toBeUndefined();
		await expect(assertRepoAccess(orgId, repo.id, "tok", github(404))).rejects.toThrow(
			/not visible/,
		);
	});

	/**
	 * The refusal names the consequence of the alternative, because somebody hitting
	 * this will be tempted to make it fall back to the app token, and that single
	 * change reproduces exactly the design this file exists to avoid.
	 */
	it("refuses a user with no source-control identity rather than using the app token", async () => {
		const repo = await connectRepo({ orgId, owner: "acme", name: "api", userToken: "tok" }, ok);
		await expect(assertRepoAccess(orgId, repo.id, null, ok)).rejects.toThrow(
			/every user of this deployment can reach every repository/,
		);
	});

	it("misses on a repository id from another org", async () => {
		const [other] = await db.insert(orgs).values({ name: "Other" }).returning();
		const [theirs] = await db
			.insert(repos)
			.values({ orgId: other!.id, owner: "other", name: "svc" })
			.returning();
		await expect(assertRepoAccess(orgId, theirs!.id, "tok", ok)).rejects.toThrow(
			/No such repository in this organisation/,
		);
	});
});

describe("snapshotting a session's repositories", () => {
	it("records position and per-repo base branch, first repo primary", async () => {
		const api = await connectRepo({ orgId, owner: "acme", name: "api", userToken: "t" }, ok);
		const web = await connectRepo(
			{ orgId, owner: "acme", name: "web", userToken: "t" },
			github(200, { default_branch: "main", permissions: { pull: true } }),
		);
		const session = await createSession({ orgId, title: "Cross-repo", createdBy: "rin" });

		await snapshotSessionRepos({
			orgId,
			sessionId: session.id,
			repoIds: [api.id, web.id],
			baseBranch: "release/2026-03",
		});

		const rows = await db
			.select()
			.from(sessionRepos)
			.where(eq(sessionRepos.sessionId, session.id))
			.orderBy(sessionRepos.position);

		expect(rows).toHaveLength(2);
		// The explicit base branch applies to the primary only; the secondary takes
		// its own default, because a release branch in one repo rarely exists in another.
		expect(rows[0]!.baseBranch).toBe("release/2026-03");
		expect(rows[1]!.baseBranch).toBe("main");
	});

	/**
	 * Beyond ten, the agent's context is spent on directory listings rather than on
	 * the task.
	 */
	it("refuses more than ten repositories", async () => {
		const session = await createSession({ orgId, title: "Too many", createdBy: "rin" });
		await expect(
			snapshotSessionRepos({
				orgId,
				sessionId: session.id,
				repoIds: Array.from({ length: 11 }, (_, i) => `id-${i}`),
			}),
		).rejects.toThrow(/at most 10 repositories/);
	});

	/**
	 * The snapshot is what makes editing an environment safe. If a session resolved
	 * its repositories through the environment on every read, emptying that
	 * environment would change the workspace under a running agent.
	 */
	it("survives the environment it came from being emptied", async () => {
		const api = await connectRepo({ orgId, owner: "acme", name: "api", userToken: "t" }, ok);
		const environment = await createEnvironment({
			orgId,
			name: "staging",
			repoIds: [api.id],
		});
		const session = await createSession({ orgId, title: "In staging", createdBy: "rin" });
		await db
			.update(sessions)
			.set({ environmentId: environment.id })
			.where(eq(sessions.id, session.id));
		await snapshotSessionRepos({ orgId, sessionId: session.id, repoIds: [api.id] });

		await sql`delete from environment_repos where environment_id = ${environment.id}`;

		const rows = await db
			.select()
			.from(sessionRepos)
			.where(eq(sessionRepos.sessionId, session.id));
		expect(rows).toHaveLength(1);
		expect(rows[0]!.repoId).toBe(api.id);
	});
});
