// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The metrics the docs promise are the metrics the scrape emits.
 *
 * Two of the documented six were never emitted at all: "circuit breaker trips"
 * shipped as a gauge of current state (a trip that opens and closes between
 * scrapes leaves no trace, and `rate()` alerting on a gauge of 0/1 is
 * impossible), and "orphan rate" was named in the file header and appeared
 * nowhere in the exposition. DEPLOY.md's spend alert divided by
 * `harbor_spend_cap`, a metric that did not exist, so the "approaching the
 * cap" alert silently never fired — the worst kind of alert, because it is
 * believed.
 *
 * These tests seed real rows, run the real collector, and parse the real
 * exposition text — the same artifact a Prometheus scrape sees.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, sql } from "@core/schema/index.js";
import { orgs } from "@core/schema/schema.js";
import { recordProviderFailure, recordProviderSuccess } from "../sandbox/circuit.js";
import { recordOrphanReconciled } from "../sandbox/manager.js";
import { collectMetrics } from "./metrics.js";

let orgId: string;

/** Parse `name{labels} value` samples for one metric out of the exposition. */
function samplesOf(text: string, name: string): Array<{ labels: string; value: number }> {
	return text
		.split("\n")
		.filter((line) => line.startsWith(`${name}{`) || line === name || line.startsWith(`${name} `))
		.map((line) => {
			const match = line.match(/^[a-z_]+(\{[^}]*\})?\s+(.+)$/);
			return { labels: match?.[1] ?? "", value: Number(match?.[2] ?? Number.NaN) };
		});
}

beforeEach(async () => {
	await sql`truncate table cost_events, circuit_breakers, automation_runs, automations, artifacts, session_events, sandboxes, session_repos, secrets, user_scm_tokens, environment_repos, environments, repos, activity, session_prompts, session_participants, sessions, runs, agent_presence, events, claims, tasks, projects, api_keys, digests, connectors, users, orgs cascade`;
	const [org] = await db.insert(orgs).values({ name: "Metrics Org" }).returning();
	orgId = org!.id;
});

afterAll(async () => {
	await sql.end();
});

describe("breaker trips are a counter of edges, not a gauge of state", () => {
	it("crossing the threshold emits exactly one trip; more failures in the streak add none", async () => {
		process.env.HARBOR_CIRCUIT_FAILURE_THRESHOLD = "2";
		try {
			const now = new Date();
			await recordProviderFailure(orgId, "docker", "transient", now);
			await recordProviderFailure(orgId, "docker", "transient", new Date(now.getTime() + 10));
			// Streak already open: a third failure is `still_open`, not a new trip.
			await recordProviderFailure(orgId, "docker", "transient", new Date(now.getTime() + 20));

			const text = await collectMetrics();
			const trips = samplesOf(text, "harbor_circuit_breaker_trips_total");
			expect(trips).toHaveLength(1);
			expect(trips[0]!.value).toBe(1);
			expect(trips[0]!.labels).toContain('provider="docker"');
		} finally {
			delete process.env.HARBOR_CIRCUIT_FAILURE_THRESHOLD;
		}
	});

	it("a recovery followed by a fresh streak trips again — two edges, value 2", async () => {
		process.env.HARBOR_CIRCUIT_FAILURE_THRESHOLD = "1";
		try {
			const now = new Date();
			await recordProviderFailure(orgId, "docker", "transient", now);
			await recordProviderSuccess(orgId, "docker");
			await recordProviderFailure(orgId, "docker", "transient", new Date(now.getTime() + 100));

			const text = await collectMetrics();
			const trips = samplesOf(text, "harbor_circuit_breaker_trips_total");
			expect(trips[0]!.value).toBe(2);
		} finally {
			delete process.env.HARBOR_CIRCUIT_FAILURE_THRESHOLD;
		}
	});

	it("an ignored error type neither counts nor trips", async () => {
		process.env.HARBOR_CIRCUIT_FAILURE_THRESHOLD = "1";
		try {
			// invalid_config is classified as not counting toward the breaker: a
			// typo'd image name is the user's error, not the provider's outage.
			await recordProviderFailure(orgId, "docker", "invalid_config", new Date());
			const text = await collectMetrics();
			expect(samplesOf(text, "harbor_circuit_breaker_trips_total")).toHaveLength(0);
		} finally {
			delete process.env.HARBOR_CIRCUIT_FAILURE_THRESHOLD;
		}
	});
});

describe("orphan reconciliations are emitted, by outcome", () => {
	it("adopted and stopped orphans count under their own labels", async () => {
		await recordOrphanReconciled(orgId, "sandbox-1", "ext-1", "adopted");
		await recordOrphanReconciled(orgId, "sandbox-2", "ext-2", "stopped");
		await recordOrphanReconciled(orgId, "sandbox-3", "ext-3", "stopped");

		const text = await collectMetrics();
		const samples = samplesOf(text, "harbor_orphans_reconciled_total");
		const adopted = samples.find((sample) => sample.labels.includes('outcome="adopted"'));
		const stopped = samples.find((sample) => sample.labels.includes('outcome="stopped"'));
		expect(adopted?.value).toBe(1);
		expect(stopped?.value).toBe(2);
	});
});

describe("the spend cap is exported, so the documented alert can actually divide", () => {
	it("emits harbor_spend_cap_micro_usd per org with the configured value", async () => {
		process.env.HARBOR_MAX_SPEND_PER_DAY_MICRO_USD = "123456789";
		try {
			const text = await collectMetrics();
			const caps = samplesOf(text, "harbor_spend_cap_micro_usd");
			expect(caps).toHaveLength(1);
			expect(caps[0]!.value).toBe(123_456_789);
			expect(caps[0]!.labels).toContain(`org="${orgId}"`);
		} finally {
			delete process.env.HARBOR_MAX_SPEND_PER_DAY_MICRO_USD;
		}
	});

	it("DEPLOY.md's alert expressions reference only metrics that exist", async () => {
		// The drift this suite exists to prevent: an alert dividing by a metric
		// nobody emits fires never, silently, forever. Every metric name in the
		// alerts table must appear in the exposition.
		const { readFileSync } = await import("node:fs");
		const deploy = readFileSync(new URL("../../DEPLOY.md", import.meta.url), "utf8");
		const text = await collectMetrics();
		const referenced = [...deploy.matchAll(/harbor_[a-z_]+/g)].map((match) => match[0]);
		expect(referenced.length).toBeGreaterThan(0);
		for (const name of new Set(referenced)) {
			expect(text, `${name} is referenced in DEPLOY.md but never emitted`).toContain(
				`# TYPE ${name}`,
			);
		}
	});
});

describe("exposition hygiene", () => {
	it("every emitted metric carries HELP and TYPE lines", async () => {
		const text = await collectMetrics();
		const names = new Set(
			text
				.split("\n")
				.filter((line) => /^harbor_[a-z_]+[{ ]/.test(line))
				.map((line) => line.match(/^([a-z_]+)/)![1]!),
		);
		for (const name of names) {
			expect(text).toContain(`# HELP ${name}`);
			expect(text).toContain(`# TYPE ${name}`);
		}
	});

	it("label values with quotes and newlines are escaped, not emitted raw", async () => {
		await db.insert(orgs).values({ name: 'Evil "Org"\nInjection' }).returning();
		// The org NAME is not a label today (ids are), but the escaper is the
		// guarantee this pins: nothing a tenant controls may corrupt the format.
		const text = await collectMetrics();
		for (const line of text.split("\n")) {
			if (line.startsWith("#") || line === "") continue;
			// A raw newline inside a label would have split the sample across
			// lines, producing a line that parses as neither comment nor sample.
			expect(line).toMatch(/^[a-z_]+(\{[^}]*\})?\s+[-0-9.e+]+$/i);
		}
	});
});
