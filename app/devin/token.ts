// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Where a Devin API token comes from, resolved the same way Linear resolves its
 * credential (src/connectors/linear.ts): the per-org `connectors` row first, the
 * per-deployment environment variable only as a fallback.
 *
 * The ordering is the tenancy rule, not a preference. A deployment serving two
 * orgs must not poll one org's Devin sessions with the other's token, so a stored
 * per-org token always wins; `DEVIN_API_TOKEN` is the single-tenant convenience
 * for a deployment that has not connected Devin per org.
 *
 * Returns `null` rather than throwing when no token exists: one org without a
 * Devin credential must not be able to break the global poll tick for every other
 * org. The poller logs and skips that org's sessions.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@core/schema/index.js";
import { connectors } from "@core/schema/schema.js";

/** The `connectors.type` a Devin token is stored under. */
export const DEVIN_CONNECTOR_TYPE = "devin";

export async function devinTokenFor(orgId: string): Promise<string | null> {
	const row = await db.query.connectors.findFirst({
		where: and(eq(connectors.orgId, orgId), eq(connectors.type, DEVIN_CONNECTOR_TYPE)),
	});
	const config = (row?.config ?? {}) as Record<string, unknown>;
	const stored = typeof config.apiToken === "string" ? config.apiToken.trim() : "";
	if (stored) return stored;

	const fromEnv = process.env.DEVIN_API_TOKEN?.trim();
	return fromEnv || null;
}
