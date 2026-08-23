// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { NextResponse } from "next/server";
import { generateAndStoreDigest } from "../../../lib/digest.js";
import { currentSession } from "../../../lib/session.js";

/**
 * Generate the last seven days.
 *
 * The error message is passed through verbatim rather than replaced with a
 * generic failure, because the overwhelmingly likely cause is a missing
 * ANTHROPIC_API_KEY and the message names it. Hiding that would turn a
 * ten-second fix into a support conversation.
 */
export async function POST() {
	const session = await currentSession();
	if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

	const until = new Date();
	const since = new Date(until.getTime() - 7 * 86_400_000);

	try {
		const digest = await generateAndStoreDigest(session.orgId, since, until);
		return NextResponse.json({ ok: true, digest });
	} catch (error) {
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : "Digest generation failed." },
			{ status: 500 },
		);
	}
}
