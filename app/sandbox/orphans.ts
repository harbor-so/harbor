// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The provider-orphan sweep: reconcile what the backend is running against what
 * the database believes exists.
 *
 * Every other mechanism in the spawn saga starts from a ROW — `findByAttemptId`
 * answers "did attempt X produce a box", the connecting watchdog revisits rows
 * still in `requested`. None of them can find a container whose row is
 * unreachable: a control plane that died between the provider's create and the
 * attach, a conclusion that was raced, a row deleted by an operator's cleanup.
 * That container bills until somebody reads an invoice, which is the failure
 * ADR 0002 accepts only because this sweep exists to bound it.
 *
 * This sweep starts from the CONTAINERS: `listManaged()` enumerates every live
 * box carrying Harbor's label, and each one is traced back to its row. The
 * dispositions:
 *
 *  - row exists and is live      → kept (it is somebody's sandbox);
 *  - row exists and is dead      → the lease behind its session decides, via
 *                                  `evaluateDestruction` — DESTRUCTION FAILS
 *                                  CLOSED, so an unreadable lease defers;
 *  - row definitively absent     → stopped: Postgres answered, and a container
 *                                  with no row is reachable by nothing else;
 *  - row lookup FAILED           → deferred — an error is not an absence, and
 *                                  stopping on one would kill a live sandbox
 *                                  every time the database blipped;
 *  - no attempt label at all     → kept and logged: a container we cannot
 *                                  attribute is not ours to kill.
 *
 * Idempotent by construction: stopped containers drop out of `listManaged()` on
 * the next pass, and a concurrent duplicate sweep double-stops, which `stop`
 * tolerates by contract.
 *
 * One assumption worth stating: one control plane per backend. Two Harbor
 * deployments sharing a Docker daemon would each read the other's containers as
 * rows-absent and reap them. That is the `harbor.managed` label's scope, and a
 * shared-daemon deployment must namespace it before pointing two control planes
 * at one socket.
 */

import { eq } from "drizzle-orm";
import { db } from "@core/schema/index.js";
import { sandboxes, sessions } from "@core/schema/schema.js";
import { evaluateDestruction, isDeadSandboxStatus } from "./decisions.js";
import { type SweepOptions, readDestructionAuthority, recordOrphanReconciled } from "./manager.js";
import type { SandboxInspection } from "./provider.js";
import { defaultProvider } from "./registry.js";

export interface OrphanReport {
	/** Containers the provider reported as live and managed. */
	listed: number;
	/** External ids this pass stopped. */
	stopped: string[];
	/** Containers left alone: live rows, other orgs, unattributable. */
	kept: string[];
	/** Containers this pass could not conclude: unreadable row or lease, failed stop. */
	deferred: string[];
}

/**
 * One pass. A `listManaged()` throw propagates — the caller's interval retries
 * — because acting on a partial population is worse than acting a pass late:
 * the containers we did not see would read as "no orphans" to whoever checks
 * the report.
 */
export async function sweepProviderOrphans(
	now: Date,
	options: SweepOptions = {},
): Promise<OrphanReport> {
	const provider = options.provider ?? defaultProvider();
	const inspections = await provider.listManaged();

	const report: OrphanReport = {
		listed: inspections.length,
		stopped: [],
		kept: [],
		deferred: [],
	};

	for (const inspection of inspections) {
		const disposition = await dispositionFor(inspection, now, options);
		switch (disposition.action) {
			case "keep":
				report.kept.push(inspection.externalId);
				if (disposition.log) console.error(disposition.log);
				break;
			case "defer":
				report.deferred.push(inspection.externalId);
				break;
			case "stop":
				try {
					await provider.stop(inspection.externalId);
					report.stopped.push(inspection.externalId);
					// The metric event, when there is an org to hang it on. A rowless
					// orphan has none; its stop is still in the report.
					if (disposition.orgId !== null) {
						await recordOrphanReconciled(
							disposition.orgId,
							inspection.attemptId ?? "unknown",
							inspection.externalId,
							"stopped",
						);
					}
				} catch (error) {
					// The container survives to the next pass; a throw here must not
					// abandon the rest of this one.
					console.error(
						`[orphans] stop failed for ${inspection.externalId}:`,
						(error as Error).message,
					);
					report.deferred.push(inspection.externalId);
				}
				break;
		}
	}

	return report;
}

type Disposition =
	| { action: "keep"; log?: string }
	| { action: "defer" }
	/** `orgId` null when the row was absent: there is no org to attribute to. */
	| { action: "stop"; orgId: string | null };

async function dispositionFor(
	inspection: SandboxInspection,
	now: Date,
	options: SweepOptions,
): Promise<Disposition> {
	// The attempt id IS the row's primary key — that identity is what makes a
	// label on a container a foreign key into the database. A managed container
	// without one cannot be attributed, and an unattributable container is not
	// ours to kill.
	if (inspection.attemptId === null) {
		return {
			action: "keep",
			log:
				`[orphans] container ${inspection.externalId} carries the managed label but no `
				+ "attempt id; it cannot be attributed to a sandbox row and was left alone.",
		};
	}

	let row: { status: string; orgId: string; taskId: string | null } | undefined;
	try {
		const rows = await db
			.select({
				status: sandboxes.status,
				orgId: sandboxes.orgId,
				taskId: sessions.taskId,
			})
			.from(sandboxes)
			.innerJoin(sessions, eq(sandboxes.sessionId, sessions.id))
			.where(eq(sandboxes.id, inspection.attemptId))
			.limit(1);
		row = rows[0];
	} catch {
		// An error is not an absence. Deferring costs one interval; guessing
		// "absent" kills a live sandbox every time the database blips.
		return { action: "defer" };
	}

	if (row === undefined) {
		// Postgres answered: no such row. Nothing else will ever find this
		// container — that is the definition of the orphan this sweep exists for.
		// Under an org scope it is kept instead: an unattributable container
		// cannot be proven to belong to the org being swept.
		return options.orgId === undefined ? { action: "stop", orgId: null } : { action: "keep" };
	}

	if (options.orgId !== undefined && row.orgId !== options.orgId) {
		return { action: "keep" };
	}

	if (!isDeadSandboxStatus(row.status)) {
		// A live row means a live sandbox. The deadline sweeps own its fate.
		return { action: "keep" };
	}

	// The row is dead, so nothing will revisit it — but destruction still defers
	// to the lease. A dead ROW with a held or unreadable lease is exactly the
	// case a tidy sweep gets wrong: the lease holder may be mid-respawn onto a
	// new attempt while this container is still flushing.
	const authority = await readDestructionAuthority(row.taskId, now, options.readLease);
	const decision = evaluateDestruction(authority);
	return decision.verdict === "destroy"
		? { action: "stop", orgId: row.orgId }
		: { action: "defer" };
}
