// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The verifier record accumulates and the history query reads it back. Nothing
 * else depends on either yet; this pins the shape so the autonomy ramp has sane
 * numbers to build on later.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, sql } from "@core/schema/index.js";
import { orgs } from "@core/schema/schema.js";
import { verifierHistory, writeVerifierOutcome } from "./verifier.js";

let orgId: string;

beforeEach(async () => {
	await sql`truncate table events, orgs cascade`;
	const [org] = await db.insert(orgs).values({ name: "Verifier Org" }).returning();
	orgId = org!.id;
});

afterAll(async () => {
	await sql.end();
});

describe("verifierHistory", () => {
	it("returns a pass rate for a scope from accumulated outcomes", async () => {
		const scope = "github:acme/api#src/billing/**";
		for (const result of ["pass", "pass", "fail", "unavailable"] as const) {
			await writeVerifierOutcome({
				orgId,
				leaseId: crypto.randomUUID(),
				scope,
				verifier: "session-clean-exit",
				result,
				durationMs: 1200,
			});
		}

		const history = await verifierHistory(orgId, scope, 24 * 60 * 60 * 1000);
		expect(history.total).toBe(4);
		expect(history.passed).toBe(2);
		expect(history.failed).toBe(1);
		expect(history.unavailable).toBe(1);
		expect(history.passRate).toBeCloseTo(0.5);
	});

	it("is scoped: another scope's outcomes do not bleed in", async () => {
		await writeVerifierOutcome({
			orgId,
			leaseId: crypto.randomUUID(),
			scope: "linear:ENG-1",
			verifier: "tests",
			result: "fail",
			durationMs: 10,
		});
		const other = await verifierHistory(orgId, "linear:ENG-2", 24 * 60 * 60 * 1000);
		expect(other.total).toBe(0);
		expect(other.passRate).toBeNull();
	});

	it("ignores outcomes outside the window", async () => {
		const scope = "harbor:old";
		await writeVerifierOutcome({
			orgId,
			leaseId: crypto.randomUUID(),
			scope,
			verifier: "tests",
			result: "pass",
			durationMs: 10,
		});
		// Age the row two hours into the past so a one-hour window must exclude it —
		// deterministic, unlike racing a millisecond-wide window against insert time.
		await sql`update events set created_at = now() - interval '2 hours' where type = 'verifier_outcome'`;
		const history = await verifierHistory(orgId, scope, 60 * 60 * 1000);
		expect(history.total).toBe(0);
	});
});
