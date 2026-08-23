// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Artifact state that only an external system knows.
 *
 * Harbor opens a pull request and then stops being the authority on it. Whether
 * it merged, and when, is a fact that lives on the source-control host and
 * arrives here through a verified webhook — which is why this is a separate,
 * narrow entry point rather than a general artifact updater. The headline metric
 * is *sessions that resulted in a merged pull request*, and a number that can be
 * moved by anything other than a signed webhook is not measuring that.
 *
 * In particular, an agent cannot reach this. `record_artifact`'s `kind` enum
 * excludes `pull_request` for the same reason: an agent reporting that its own
 * work merged produces a metric that measures the agent's optimism.
 */

import { and, eq, isNull } from "drizzle-orm";
import { db } from "@core/schema/index.js";
import { artifacts } from "@core/schema/schema.js";

/**
 * Stamp a pull-request artifact as merged, matched on its URL.
 *
 * The URL is the join key because it is the only identifier both sides already
 * agree on: Harbor stored `html_url` when it opened the PR, and every webhook
 * about that PR carries the same string. A number-plus-repo composite would be
 * more normalised and would require a schema change plus a backfill to become
 * usable, and `artifacts_org_url_idx` already indexes exactly this lookup.
 *
 * Scoped by org even though a GitHub URL is globally unique, because the org is
 * established by webhook verification and every read in this codebase is scoped
 * to the tenant that proved it. A lookup that did not would let a webhook from a
 * repository one org connected mutate a row belonging to another.
 *
 * Idempotent by predicate, not by check-then-write: `merged_at IS NULL` is part
 * of the UPDATE, so a redelivered webhook — which GitHub does routinely — matches
 * zero rows rather than overwriting the original merge time with the retry's.
 * The first merge is the true one; a later one would silently move the row out of
 * whatever reporting window somebody was looking at.
 *
 * Returns how many rows it stamped, so a caller can tell "merged a PR Harbor
 * opened" from "merged a PR nobody here knows about" — the second is the common
 * case on a repository where humans also work, and it is not an error.
 */
export async function markPullRequestMerged(input: {
	orgId: string;
	url: string;
	mergedAt: Date;
}): Promise<number> {
	const stamped = await db
		.update(artifacts)
		.set({ mergedAt: input.mergedAt })
		.where(
			and(
				eq(artifacts.orgId, input.orgId),
				eq(artifacts.url, input.url),
				eq(artifacts.kind, "pull_request"),
				isNull(artifacts.mergedAt),
			),
		)
		.returning({ id: artifacts.id });

	return stamped.length;
}
