// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The execution glue, against the real database — the wire that turns an isolated
 * box that boots into an isolated box that clones the repositories and runs the
 * agent. The property that matters is that the environment a provider is handed
 * carries the session's *snapshotted* repositories as clone specs and its chosen
 * runtime, with no credential baked into a URL.
 */

process.env.HARBOR_ENCRYPTION_KEY = Buffer.from(
	"0123456789abcdef0123456789abcdef",
).toString("base64");

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, sql } from "@core/schema/index.js";
import { orgs, repos, secrets, sessionRepos, sessions } from "@core/schema/schema.js";
import { encrypt } from "../lib/crypto.js";
import { buildSandboxEnv, resumeTokenForBoot } from "./env.js";

let orgId: string;

beforeEach(async () => {
	await sql`truncate table cost_events, circuit_breakers, automation_runs, automations, artifacts, session_events, sandboxes, session_repos, secrets, user_scm_tokens, environment_repos, environments, repos, activity, session_prompts, session_participants, sessions, runs, agent_presence, events, claims, tasks, projects, api_keys, digests, connectors, users, orgs cascade`;
	const [org] = await db.insert(orgs).values({ name: "Env Test Org" }).returning();
	orgId = org!.id;
});

afterAll(async () => {
	await sql.end();
});

async function seedSession(runtime: string | null) {
	const [frontend] = await db
		.insert(repos)
		.values({ orgId, provider: "github", owner: "acme", name: "web", defaultBranch: "main" })
		.returning();
	const [api] = await db
		.insert(repos)
		.values({ orgId, provider: "gitlab", owner: "acme", name: "api", defaultBranch: "trunk" })
		.returning();
	const [session] = await db
		.insert(sessions)
		.values({ orgId, key: `k-${Math.abs(runtime?.length ?? 0)}-${orgId.slice(0, 8)}`, title: "s", createdBy: "u", runtime })
		.returning();
	await db.insert(sessionRepos).values([
		{ orgId, sessionId: session!.id, repoId: frontend!.id, position: 0, baseBranch: "main", workingBranch: "harbor/lse_1" },
		{ orgId, sessionId: session!.id, repoId: api!.id, position: 1, baseBranch: "trunk" },
	]);
	return { session: session!, frontend: frontend!, api: api! };
}

describe("buildSandboxEnv", () => {
	it("emits the snapshotted repos as clone specs, in order, with no token in the URL", async () => {
		const { session } = await seedSession("codex");
		const env = await buildSandboxEnv(session);

		const specs = JSON.parse(env.HARBOR_REPOS!) as { name: string; url: string; branch?: string }[];
		expect(specs).toEqual([
			{ name: "web", url: "https://github.com/acme/web.git", branch: "harbor/lse_1" },
			{ name: "api", url: "https://gitlab.com/acme/api.git", branch: "trunk" },
		]);
		// No credential ever travels in the URL — the in-box helper brokers it.
		expect(env.HARBOR_REPOS).not.toMatch(/@|x-access-token|:.*@/);
		expect(env.HARBOR_AGENT_RUNTIME).toBe("codex");
	});

	it("defaults an absent or unknown runtime to claude-code rather than emitting an invalid one", async () => {
		const { session } = await seedSession(null);
		expect((await buildSandboxEnv(session)).HARBOR_AGENT_RUNTIME).toBe("claude-code");
	});

	it("injects the session's secrets, which HARBOR_REPOS cannot be shadowed by", async () => {
		const { session, frontend } = await seedSession("claude-code");
		await db.insert(secrets).values([
			{ orgId, scope: "repo", scopeId: frontend.id, name: "DATABASE_URL", ciphertext: encrypt("postgres://x") },
			// A secret that tries to impersonate the repo list must not win.
			{ orgId, scope: "repo", scopeId: frontend.id, name: "HARBOR_REPOS", ciphertext: encrypt("[]") },
		]);
		const env = await buildSandboxEnv(session);
		expect(env.DATABASE_URL).toBe("postgres://x");
		expect(JSON.parse(env.HARBOR_REPOS!)).toHaveLength(2); // the real list, not the secret's "[]"
	});
});

/**
 * The rule: an agent's conversation may only be resumed into a box that still
 * has the transcript on disk.
 *
 * Both wrong answers are silent. Withhold a token that would have worked and the
 * agent quietly forgets a long conversation; hand one to a box that has never
 * seen the transcript and its first turn dies on a session id nobody recognises.
 */
describe("resumeTokenForBoot", () => {
	const stored = { storedToken: "sess_a91", storedRuntime: "claude-code", sessionRuntime: "claude-code" };

	it("resumes on a snapshot restore, which is the only boot that brings the disk back", () => {
		expect(resumeTokenForBoot({ ...stored, bootMode: "snapshot_restore" })).toEqual({
			resume: true,
			token: "sess_a91",
		});
	});

	it("withholds on a fresh boot and says so, rather than failing the first turn", () => {
		// `--resume` reads a transcript from the sandbox's own filesystem. On a fresh
		// box that file has never existed, so passing the id makes the agent fail to
		// start on a session that is not there.
		const verdict = resumeTokenForBoot({ ...stored, bootMode: "fresh" });
		expect(verdict.resume).toBe(false);
		if (verdict.resume) throw new Error("unreachable");
		expect(verdict.reason).toBe("fresh_boot");
		// And the user is told. A silent reset reads as the model having got worse.
		expect(verdict.notice).toContain("new conversation");
	});

	it("withholds when the session's agent was changed after the token was minted", () => {
		const verdict = resumeTokenForBoot({
			...stored,
			sessionRuntime: "opencode",
			bootMode: "snapshot_restore",
		});
		expect(verdict.resume).toBe(false);
		if (verdict.resume) throw new Error("unreachable");
		expect(verdict.reason).toBe("runtime_changed");
		expect(verdict.notice).toContain("opencode");
	});

	it("says nothing at all when there was never a token to lose", () => {
		// The ordinary first boot of every session. A notice here would put a scary
		// line on the timeline of a session that has lost nothing.
		for (const storedToken of [null, "", "   "]) {
			const verdict = resumeTokenForBoot({ ...stored, storedToken, bootMode: "fresh" });
			expect(verdict.resume).toBe(false);
			if (verdict.resume) throw new Error("unreachable");
			expect(verdict.reason).toBe("no_token");
			expect(verdict.notice).toBeNull();
		}
	});

	it("treats an unset stored runtime as the default rather than as a match for anything", () => {
		// Rows written before the column existed. Absent must resolve to the same
		// default `runtimeFor` uses, so it matches claude-code and nothing else.
		expect(
			resumeTokenForBoot({ ...stored, storedRuntime: null, bootMode: "snapshot_restore" }).resume,
		).toBe(true);
		expect(
			resumeTokenForBoot({
				...stored,
				storedRuntime: null,
				sessionRuntime: "codex",
				bootMode: "snapshot_restore",
			}).resume,
		).toBe(false);
	});
});
