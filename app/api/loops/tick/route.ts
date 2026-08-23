// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Drive the background loops from an external cron.
 *
 * The Next.js app starts no timers on purpose — it is serverless-shaped and may
 * have zero warm instances at any moment, so a `setInterval` there is a promise
 * the runtime cannot keep. That is the right call and it left a hole: a
 * deployment that runs *only* the dashboard has never swept an expired lease, a
 * deadline, or an event log. This is the hole's other half. Point a Kubernetes
 * CronJob, a line in crontab, or any hosted scheduler at it:
 *
 *     * / 5 * * * *  curl -fsS -XPOST -H "Authorization: Bearer $TOKEN" https://…/api/loops/tick
 *
 * Concurrent ticks are safe and deliberately not serialised. Every loop is
 * documented as safe on every replica — each takes an advisory lock, is a
 * compare-and-set over shared rows, or is idempotent by construction — so two
 * overlapping ticks double the timeliness, not the actions. Adding a lock here
 * would only convert a harmless overlap into a 409 an operator has to interpret.
 *
 * ## Why not an org API key
 *
 * The loops are global: `sweepExpiredClaims` with no org scope, `sweepDeadlines`,
 * `sweepProviderOrphans`. Accepting an org key would let any tenant trigger work
 * across every other tenant, which is a cross-org side effect granted by a
 * credential scoped to one org. This is an operator action, so it takes an
 * operator credential — a separate env var, absent by default.
 *
 * Absent means **503, not 401**. A deployment that never set the variable has not
 * refused the caller, it has not enabled the feature, and answering 401 sends the
 * operator to look for a wrong token instead of a missing one.
 */

import { NextResponse } from "next/server";
import { secretEquals } from "../../../lib/crypto.js";
import { runLoopsOnce } from "../../../lib/loops.js";

/** Never cached, never statically evaluated: this exists entirely for its effects. */
export const dynamic = "force-dynamic";

function presentedToken(headers: Headers): string | null {
	const authorization = headers.get("authorization");
	if (authorization?.toLowerCase().startsWith("bearer ")) {
		return authorization.slice("bearer ".length).trim() || null;
	}
	// Some cron products cannot set an Authorization header. A second accepted
	// header is cheaper than an operator putting the token in the query string,
	// where it lands in every access log between them and the app.
	return headers.get("x-harbor-maintenance-token")?.trim() || null;
}

export async function POST(request: Request): Promise<NextResponse> {
	const expected = process.env.HARBOR_MAINTENANCE_TOKEN?.trim();
	if (!expected) {
		return NextResponse.json(
			{
				error:
					"Maintenance ticks are not enabled. Set HARBOR_MAINTENANCE_TOKEN to a random "
					+ "secret and send it as `Authorization: Bearer <token>`. Deployments that run "
					+ "`npm run mcp` do not need this — that process runs the loops itself.",
				reason: "not_configured",
			},
			{ status: 503 },
		);
	}

	const presented = presentedToken(request.headers);
	// Compared even when absent, against a value that cannot match, so a missing
	// token and a wrong one take the same path and the same time.
	if (!presented || !secretEquals(presented, expected)) {
		return NextResponse.json(
			{ error: "Invalid maintenance token.", reason: "token_invalid" },
			{ status: 401 },
		);
	}

	const results = await runLoopsOnce();

	// 200 with per-loop verdicts rather than 500 on the first failure. A cron that
	// sees a 500 retries the whole tick including the five loops that worked; a
	// cron that sees this can alert on `ok: false` and name the loop.
	return NextResponse.json({
		ok: results.every((entry) => entry.ok),
		loops: results,
	});
}
