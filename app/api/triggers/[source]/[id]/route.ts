// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { NextResponse } from "next/server";
import { deliverEvent } from "../../../../triggers/inbound.js";

/**
 * The inbound endpoint for event-driven automations.
 *
 * Thin on purpose: read the raw body *first* (the signature is computed over
 * exactly these bytes), lower-case the headers into the shape the sources expect,
 * and hand the whole thing to `deliverEvent`, which owns the verify → gate → fire
 * pipeline and the status code. There is no session cookie here — the HMAC
 * signature over the body *is* the credential, and the `[id]` selects the one
 * automation whose secret can produce that signature.
 */
export async function POST(
	request: Request,
	{ params }: { params: Promise<{ source: string; id: string }> },
) {
	const { source, id } = await params;

	const raw = await request.text();

	const headers: Record<string, string | undefined> = {};
	request.headers.forEach((value, key) => {
		headers[key.toLowerCase()] = value;
	});

	const result = await deliverEvent({ source, automationId: id, raw, headers });

	// A bare 401 with no body, exactly like the connector route: an unauthenticated
	// caller learns only that it failed, not why.
	if (result.status === 401) return new NextResponse(null, { status: 401 });

	return NextResponse.json(
		{ ok: result.status < 400, fired: result.fired, reason: result.reason },
		{ status: result.status },
	);
}
