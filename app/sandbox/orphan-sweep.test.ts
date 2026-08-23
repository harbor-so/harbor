// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The provider-orphan sweep: containers traced back to rows, and the rule that
 * it may only stop what it can PROVE is abandoned.
 *
 * The population under test is the one no row-driven mechanism can see: a
 * container whose row is gone, whose conclusion was raced, or whose control
 * plane died between create and record. The fake provider here maintains a real
 * ledger of running boxes — `listManaged` answers from it, `stop` removes from
 * it — so idempotence ("the second pass acts on nothing") is a property of the
 * interaction, not a stubbed return value.
 *
 * The fail-closed cases are the important ones. This sweep is the single most
 * dangerous loop in the product — its success case is destroying containers —
 * and every ambiguity must resolve to "not this pass": an unreadable row
 * defers, an unreadable lease defers, an unattributable container is kept, and
 * a `listManaged` that cannot answer aborts the pass rather than reading an
 * empty daemon as an empty fleet.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, sql } from "@core/schema/index.js";
import { orgs, sandboxes, sessions } from "@core/schema/schema.js";
import { claim, createTask } from "@core/kernel/work.js";
import { createSession } from "../lib/sessions.js";
import { sweepProviderOrphans } from "./orphans.js";
import type { SandboxInspection, SandboxProvider } from "./provider.js";

let orgId: string;

function inspection(externalId: string, attemptId: string | null): SandboxInspection {
	return {
		externalId,
		provider: "fake",
		state: "running",
		rawState: "running",
		attemptId,
		sessionId: null,
		sandboxId: null,
		startedAt: new Date().toISOString(),
		exitCode: null,
	};
}

/**
 * A provider whose `listManaged` answers from a live ledger `stop` mutates.
 * `failListing` makes the population unreadable, which is the abort case.
 */
function fakeFleet(initial: Array<{ externalId: string; attemptId: string | null }>) {
	const running = new Map(initial.map((box) => [box.externalId, box.attemptId]));
	let failListing = false;
	let stopCalls = 0;

	const provider = {
		kind: "ephemeral",
		name: "fake",
		capabilities: {
			supportsSandboxTimeout: true,
			supportsSnapshots: false,
			supportsRestore: false,
		},
		async create() {
			throw new Error("this suite never spawns through the provider");
		},
		async findByAttemptId() {
			return null;
		},
		async inspect(externalId: string) {
			return running.has(externalId)
				? inspection(externalId, running.get(externalId) ?? null)
				: null;
		},
		async listManaged(): Promise<SandboxInspection[]> {
			if (failListing) throw new Error("daemon unreachable");
			return [...running.entries()].map(([externalId, attemptId]) =>
				inspection(externalId, attemptId),
			);
		},
		async stop(externalId: string) {
			stopCalls += 1;
			running.delete(externalId);
			return "stopped" as const;
		},
		supportedFeatures: [],
	} as unknown as SandboxProvider;

	return {
		provider,
		running,
		setFailListing(value: boolean) {
			failListing = value;
		},
		get stopCalls() {
			return stopCalls;
		},
	};
}

/** A sandbox row in the given status, attached to a fresh session. */
async function rowInStatus(
	status: string,
	options: { taskId?: string | null; externalId?: string } = {},
) {
	const session = await createSession({
		orgId,
		title: `Session for ${status}`,
		createdBy: "rin",
		...(options.taskId ? { taskId: options.taskId } : {}),
	});
	const [row] = await db
		.insert(sandboxes)
		.values({
			orgId,
			sessionId: session.id,
			provider: "fake",
			status,
			externalId: options.externalId ?? null,
		})
		.returning();
	return { session, row: row! };
}

beforeEach(async () => {
	await sql`truncate table cost_events, circuit_breakers, automation_runs, automations, artifacts, session_events, sandboxes, session_repos, secrets, user_scm_tokens, environment_repos, environments, repos, activity, session_prompts, session_participants, sessions, runs, agent_presence, events, claims, tasks, projects, api_keys, digests, connectors, users, orgs cascade`;
	const [org] = await db.insert(orgs).values({ name: "Orphan Org" }).returning();
	orgId = org!.id;
});

afterAll(async () => {
	await sql.end();
});

describe("sweepProviderOrphans", () => {
	it("stops a container whose row is dead, and leaves a live row's container alone", async () => {
		const dead = await rowInStatus("stopped");
		const alive = await rowInStatus("ready");
		const fleet = fakeFleet([
			{ externalId: "ext-dead", attemptId: dead.row.id },
			{ externalId: "ext-live", attemptId: alive.row.id },
		]);

		const report = await sweepProviderOrphans(new Date(), { provider: fleet.provider });

		expect(report.listed).toBe(2);
		expect(report.stopped).toEqual(["ext-dead"]);
		expect(report.kept).toEqual(["ext-live"]);
		expect(fleet.running.has("ext-live")).toBe(true);
		expect(fleet.running.has("ext-dead")).toBe(false);
	});

	it("stops a container whose row is definitively ABSENT — the true orphan", async () => {
		// No row anywhere: the control plane died between the provider's create
		// and the attach. This container is invisible to findByAttemptId-driven
		// reconciliation forever; this sweep is the only thing that ever finds it.
		const fleet = fakeFleet([
			{ externalId: "ext-ghost", attemptId: "00000000-0000-4000-8000-000000000000" },
		]);

		const report = await sweepProviderOrphans(new Date(), { provider: fleet.provider });
		expect(report.stopped).toEqual(["ext-ghost"]);
		expect(fleet.running.size).toBe(0);
	});

	it("keeps a managed container that carries no attempt id — unattributable is not killable", async () => {
		const fleet = fakeFleet([{ externalId: "ext-unlabelled", attemptId: null }]);

		const report = await sweepProviderOrphans(new Date(), { provider: fleet.provider });
		expect(report.kept).toEqual(["ext-unlabelled"]);
		expect(report.stopped).toEqual([]);
		expect(fleet.running.has("ext-unlabelled")).toBe(true);
	});

	it("DEFERS a dead-row container whose lease cannot be read — never destroys on a guess", async () => {
		const task = await createTask(orgId, { title: "Unreadable lease" });
		const dead = await rowInStatus("failed", { taskId: task.id });
		const fleet = fakeFleet([{ externalId: "ext-maybe", attemptId: dead.row.id }]);

		const report = await sweepProviderOrphans(new Date(), {
			provider: fleet.provider,
			readLease: async () => {
				throw new Error("claims unreachable");
			},
		});

		expect(report.deferred).toEqual(["ext-maybe"]);
		expect(report.stopped).toEqual([]);
		expect(fleet.running.has("ext-maybe")).toBe(true);
		expect(fleet.stopCalls).toBe(0);
	});

	it("defers a dead-row container while its task's lease is HELD, then stops after release", async () => {
		const task = await createTask(orgId, { title: "Held lease" });
		const dead = await rowInStatus("failed", { taskId: task.id });
		const claimed = await claim(orgId, task.id, "agent-a", { intent: "Hold this task for the sandbox test." });
		if (!claimed.ok) throw new Error("expected claim");
		const fleet = fakeFleet([{ externalId: "ext-held", attemptId: dead.row.id }]);

		const held = await sweepProviderOrphans(new Date(), { provider: fleet.provider });
		expect(held.deferred).toEqual(["ext-held"]);
		expect(fleet.running.has("ext-held")).toBe(true);

		const { release } = await import("@core/kernel/work");
		await release(orgId, task.id, "agent-a", "done");
		const after = await sweepProviderOrphans(new Date(), { provider: fleet.provider });
		expect(after.stopped).toEqual(["ext-held"]);
	});

	it("aborts the whole pass when the provider cannot enumerate — a dead daemon is not an empty fleet", async () => {
		const dead = await rowInStatus("stopped");
		const fleet = fakeFleet([{ externalId: "ext-x", attemptId: dead.row.id }]);
		fleet.setFailListing(true);

		await expect(
			sweepProviderOrphans(new Date(), { provider: fleet.provider }),
		).rejects.toThrow(/daemon unreachable/);
		expect(fleet.stopCalls).toBe(0);

		// Recovery: the next pass, against a healthy daemon, completes the work.
		fleet.setFailListing(false);
		const report = await sweepProviderOrphans(new Date(), { provider: fleet.provider });
		expect(report.stopped).toEqual(["ext-x"]);
	});

	it("defers when the stop itself fails, and the container survives to the next pass", async () => {
		const dead = await rowInStatus("stopped");
		const fleet = fakeFleet([{ externalId: "ext-stubborn", attemptId: dead.row.id }]);
		const stubborn = {
			...fleet.provider,
			async stop() {
				throw new Error("stop refused");
			},
		} as SandboxProvider;

		const report = await sweepProviderOrphans(new Date(), { provider: stubborn });
		expect(report.deferred).toEqual(["ext-stubborn"]);
		expect(fleet.running.has("ext-stubborn")).toBe(true);
	});

	it("is idempotent: the second pass lists fewer and stops nothing", async () => {
		const dead = await rowInStatus("stale");
		const alive = await rowInStatus("busy");
		const fleet = fakeFleet([
			{ externalId: "ext-1", attemptId: dead.row.id },
			{ externalId: "ext-2", attemptId: alive.row.id },
		]);

		const first = await sweepProviderOrphans(new Date(), { provider: fleet.provider });
		expect(first.stopped).toEqual(["ext-1"]);

		const second = await sweepProviderOrphans(new Date(), { provider: fleet.provider });
		expect(second.listed).toBe(1);
		expect(second.stopped).toEqual([]);
		expect(second.kept).toEqual(["ext-2"]);
		expect(fleet.stopCalls).toBe(1);
	});

	it("respects an org scope: other orgs' containers and unattributable ones are kept", async () => {
		const [otherOrg] = await db.insert(orgs).values({ name: "Other Org" }).returning();
		const mine = await rowInStatus("stopped");
		const theirsSession = await createSession({
			orgId: otherOrg!.id,
			title: "Theirs",
			createdBy: "sam",
		});
		const [theirsRow] = await db
			.insert(sandboxes)
			.values({
				orgId: otherOrg!.id,
				sessionId: theirsSession.id,
				provider: "fake",
				status: "stopped",
			})
			.returning();

		const fleet = fakeFleet([
			{ externalId: "ext-mine", attemptId: mine.row.id },
			{ externalId: "ext-theirs", attemptId: theirsRow!.id },
			{ externalId: "ext-ghost", attemptId: "00000000-0000-4000-8000-000000000001" },
		]);

		const report = await sweepProviderOrphans(new Date(), {
			provider: fleet.provider,
			orgId,
		});

		expect(report.stopped).toEqual(["ext-mine"]);
		// The ghost is kept under an org scope: with no row there is no org, and a
		// scoped sweep must not destroy what it cannot attribute to its org.
		expect(new Set(report.kept)).toEqual(new Set(["ext-theirs", "ext-ghost"]));
	});
});
