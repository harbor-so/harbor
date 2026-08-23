// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { NextResponse } from "next/server";
import { liveness, readiness } from "../../lib/metrics.js";

/**
 * `GET /api/health` is readiness; `GET /api/health?probe=live` is liveness.
 *
 * One route rather than two because the distinction is a query parameter's worth
 * of difference and two routes invites somebody to point the liveness probe at
 * the readiness one — which is the mistake that turns a database blip into a
 * fleet-wide restart. See src/lib/metrics.ts for why they must differ.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	const probe = new URL(request.url).searchParams.get("probe");
	if (probe === "live") return NextResponse.json(liveness());

	const result = await readiness();
	return NextResponse.json(result, { status: result.ok ? 200 : 503 });
}
