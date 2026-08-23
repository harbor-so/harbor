// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * A cheap, advisory budget read for the automation scheduler.
 *
 * This is deliberately **not** the enforcement point, and the distinction is the
 * whole reason the file exists.
 *
 * Enforcement is `reserveBudget` in `src/lib/cost.ts`, which takes a lock and
 * inserts a reservation in one transaction, so concurrent admissions serialise
 * and cannot collectively exceed the cap. That is the check that must be right.
 *
 * What this does is a read-only pre-check so an automation firing into an
 * exhausted budget costs one query rather than a session row, a queued prompt and
 * a spawn attempt that is refused a moment later. It is an optimisation, and it
 * is allowed to be wrong at the margin.
 *
 * Because it is advisory, it **fails open**: if the read itself fails, the
 * automation proceeds and hits the real, transactional check downstream. Failing
 * closed here would mean a transient database error silently stops every
 * scheduled job in the deployment, and the symptom — "our nightly automations
 * stopped running" — would be traced back to a budget module that was working
 * correctly.
 *
 * This is the same fail-open/fail-closed asymmetry as ADR 0003, applied one level
 * down: an advisory read fails open because something authoritative is behind it.
 */

export interface BudgetView {
	capMicroUsd: number;
	spentMicroUsd: number;
	remainingMicroUsd: number;
	exhausted: boolean;
}

export async function budgetStatusSafe(orgId: string): Promise<BudgetView> {
	try {
		const { budgetStatus } = await import("../lib/cost.js");
		return await budgetStatus(orgId);
	} catch (error) {
		console.error(
			"[automations] advisory budget read failed; proceeding to the transactional "
				+ "check in reserveBudget:",
			error,
		);
		return {
			capMicroUsd: 0,
			spentMicroUsd: 0,
			remainingMicroUsd: Number.MAX_SAFE_INTEGER,
			exhausted: false,
		};
	}
}
