// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { NextResponse } from "next/server";
import { normalizerFor } from "../../../activity/registry.js";
import { recordActivity } from "../../../lib/activity.js";
import { orgIdForKey } from "@core/kernel/auth.js";

/**
 * The passive-tracking counterpart to the connector webhook route.
 *
 * The webhook route authenticates a *sender* by HMAC because the connector has no
 * Harbor key; this route authenticates an *agent host* by the same Harbor API key
 * the MCP server uses, so the org is read off the key — never asserted by the
 * payload — exactly as it is for a tool call. A host cannot claim to be an org it
 * does not hold the key for.
 *
 * Command-hook tools (Codex, Cursor) run one script per event and cannot always
 * name the event in the body, so the forwarder passes it as `?event=` alongside an
 * optional `?agent=`; both are handed to the normalizer as context. Claude Code
 * and opencode name the event in the body themselves and need neither.
 */
export async function POST(request: Request, { params }: { params: Promise<{ runtime: string }> }) {
	const { runtime } = await params;
	const normalizer = normalizerFor(runtime);
	if (!normalizer) {
		return NextResponse.json({ error: `Unknown runtime "${runtime}".` }, { status: 404 });
	}

	const orgId = await orgIdForKey(request.headers.get("authorization") ?? undefined);
	if (!orgId) return new NextResponse(null, { status: 401 });

	const raw = await request.text();
	if (raw.length > 1_000_000) {
		return NextResponse.json({ error: "Payload too large." }, { status: 413 });
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return NextResponse.json({ error: "Body is not JSON." }, { status: 400 });
	}

	const url = new URL(request.url);
	const ctx = {
		event: url.searchParams.get("event") ?? undefined,
		agent: url.searchParams.get("agent") ?? undefined,
	};

	// A batch of events arrives as an array; a single hook fire as one object. Both
	// flatten to the same row list — high-frequency hosts can coalesce without a
	// second code path here.
	const items = Array.isArray(parsed) ? parsed : [parsed];
	const rows = items.flatMap((item) => normalizer.normalize(item, ctx));

	// Nothing recognised (an observability-only event we do not store) is a 200 with
	// zero rows, not an error: the host fired a hook we simply do not track, and a
	// non-2xx would show up as a failed hook in its UI.
	const result = await recordActivity(orgId, runtime, rows);
	return NextResponse.json(result);
}
