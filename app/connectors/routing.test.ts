// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Routing tests, run with NO model key configured.
 *
 * That is the point of the suite, not an incidental detail. The claim this
 * design makes is that a deployment with no LLM account still routes most
 * traffic correctly, and the only way to keep that claim honest is to prove the
 * deterministic paths in an environment where the classifier physically cannot
 * run. `ANTHROPIC_API_KEY` is deleted in `beforeEach` for exactly that reason.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, sql } from "@core/schema/index.js";
import { environments, orgs, repos } from "@core/schema/schema.js";
import { resolveTarget } from "./routing.js";

let orgId: string;
let apiRepo: string;
let webRepo: string;
let stagingEnv: string;
let savedKey: string | undefined;

beforeEach(async () => {
	await sql`truncate table cost_events, circuit_breakers, automation_runs, automations, artifacts, session_events, sandboxes, session_repos, secrets, user_scm_tokens, environment_repos, environments, repos, activity, session_prompts, session_participants, sessions, runs, agent_presence, events, claims, tasks, projects, api_keys, digests, connectors, users, orgs cascade`;

	savedKey = process.env.ANTHROPIC_API_KEY;
	delete process.env.ANTHROPIC_API_KEY;

	const [org] = await db.insert(orgs).values({ name: "Routing Org" }).returning();
	orgId = org!.id;

	const inserted = await db
		.insert(repos)
		.values([
			{ orgId, owner: "acme", name: "api", description: "Billing and payments service" },
			{ orgId, owner: "acme", name: "web", description: "Customer-facing dashboard" },
		])
		.returning();
	apiRepo = inserted.find((r) => r.name === "api")!.id;
	webRepo = inserted.find((r) => r.name === "web")!.id;

	const [env] = await db
		.insert(environments)
		.values({ orgId, name: "staging", description: "api plus web together" })
		.returning();
	stagingEnv = env!.id;
});

afterAll(async () => {
	if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
	await sql.end();
});

describe("explicit targets beat everything", () => {
	it("matches `in owner/repo`", async () => {
		const target = await resolveTarget({
			orgId,
			text: "please fix the retry cap in acme/api",
			config: {},
		});
		expect(target).toMatchObject({ kind: "repo", repo_id: apiRepo, confidence: "explicit" });
	});

	it("matches a bare owner/name anywhere in the message", async () => {
		const target = await resolveTarget({ orgId, text: "acme/web is broken", config: {} });
		expect(target).toMatchObject({ kind: "repo", repo_id: webRepo });
	});

	it("matches an environment named outright", async () => {
		const target = await resolveTarget({ orgId, text: "redeploy staging please", config: {} });
		expect(target).toMatchObject({ kind: "environment", environment_id: stagingEnv });
	});

	/**
	 * The behaviour this asserts is the one that makes a routing layer feel
	 * trustworthy rather than infuriating: a person who took the trouble to name
	 * the repository has told us the answer, and no mapping may overrule them.
	 */
	it("overrules a channel mapping that says otherwise", async () => {
		const target = await resolveTarget({
			orgId,
			text: "fix the login page in acme/web",
			channelRef: "C_API",
			config: { channelMap: { C_API: { kind: "repo", id: apiRepo } } },
		});
		expect(target).toMatchObject({ repo_id: webRepo, confidence: "explicit" });
	});
});

describe("channel mappings", () => {
	it("routes by channel when nothing explicit is named", async () => {
		const target = await resolveTarget({
			orgId,
			text: "the checkout flow is throwing 500s",
			channelRef: "C_API",
			channelName: "team-billing",
			config: { channelMap: { C_API: { kind: "repo", id: apiRepo } } },
		});
		expect(target).toMatchObject({ repo_id: apiRepo, confidence: "mapping" });
	});

	/**
	 * A mapping can outlive the repository it points at. Trusting it blindly sends
	 * a session to a repo that no longer exists, and that failure surfaces deep
	 * inside sandbox boot where the error is least legible to the person who asked.
	 */
	it("falls through when the mapping points at a deleted repository", async () => {
		await db.delete(repos).where(eq(repos.id, apiRepo));
		const target = await resolveTarget({
			orgId,
			text: "something is wrong",
			channelRef: "C_API",
			config: { channelMap: { C_API: { kind: "repo", id: apiRepo } } },
		});
		expect(target.kind).toBe("unknown");
	});
});

describe("keyword rules", () => {
	it("routes on an operator-written keyword", async () => {
		const target = await resolveTarget({
			orgId,
			text: "checkout is timing out for some users",
			config: { keywordRules: [{ match: ["checkout", "billing"], kind: "repo", id: apiRepo }] },
		});
		expect(target).toMatchObject({ repo_id: apiRepo, confidence: "keyword" });
	});

	it("requires a whole-word match rather than a substring", async () => {
		const target = await resolveTarget({
			orgId,
			text: "the checkoutflow module is slow",
			config: { keywordRules: [{ match: ["checkout"], kind: "repo", id: apiRepo }] },
		});
		expect(target.kind).toBe("unknown");
	});
});

describe("asking rather than guessing", () => {
	/**
	 * The single most important assertion in this file. With no explicit target,
	 * no mapping, no keyword and no model key, the only safe answer is to ask —
	 * and it must come back with candidates so the picker has something to render.
	 * A router that returns a confident guess here starts an agent against a
	 * stranger's repository.
	 */
	it("returns unknown with candidates when nothing matches and no model is configured", async () => {
		const target = await resolveTarget({ orgId, text: "it is broken", config: {} });
		expect(target.kind).toBe("unknown");
		if (target.kind !== "unknown") throw new Error("unreachable");
		expect(target.candidates.length).toBe(3);
		expect(target.candidates.map((c) => c.label).sort()).toEqual([
			"acme/api",
			"acme/web",
			"staging",
		]);
	});

	/**
	 * Asking when there is only one possible answer is the kind of pedantry that
	 * makes a tool feel hostile on the first day of a new deployment, which is
	 * exactly when it has connected precisely one repository.
	 */
	it("does not ask when there is only one candidate", async () => {
		await db.delete(environments).where(eq(environments.orgId, orgId));
		await db.delete(repos).where(eq(repos.id, webRepo));
		const target = await resolveTarget({ orgId, text: "anything at all", config: {} });
		expect(target).toMatchObject({ kind: "repo", repo_id: apiRepo });
	});

	it("returns unknown with no candidates when nothing is connected", async () => {
		await db.delete(environments).where(eq(environments.orgId, orgId));
		await db.delete(repos).where(eq(repos.orgId, orgId));
		const target = await resolveTarget({ orgId, text: "anything", config: {} });
		expect(target).toEqual({ kind: "unknown", candidates: [] });
	});
});
