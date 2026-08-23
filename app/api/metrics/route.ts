// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { collectMetrics } from "../../lib/metrics.js";

/**
 * Prometheus scrape endpoint.
 *
 * Guarded by a bearer token when `HARBOR_METRICS_TOKEN` is set, and open when it
 * is not. Open-by-default is the right choice here and is worth defending: the
 * overwhelmingly common deployment is a single instance on a private network
 * where the scraper is a sidecar, and a metrics endpoint that requires
 * configuration before it emits anything is a metrics endpoint nobody wires up.
 *
 * What it exposes is counts and latencies — no prompts, no code, no secrets, no
 * repository names. Org ids appear as labels, which are opaque UUIDs. The worst
 * an unauthenticated reader learns is how busy the deployment is.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	const required = process.env.HARBOR_METRICS_TOKEN;
	if (required) {
		const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
		const { secretEquals } = await import("../../lib/crypto");
		if (!supplied || !secretEquals(supplied, required)) {
			return new Response("Unauthorized", { status: 401 });
		}
	}

	const body = await collectMetrics();
	return new Response(body, {
		headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
	});
}
