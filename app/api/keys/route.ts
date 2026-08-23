// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { NextResponse } from "next/server";
import { db } from "@core/schema/index.js";
import { apiKeys } from "@core/schema/schema.js";
import { hashApiKey, mintApiKey } from "@core/kernel/keys.js";
import { currentSession } from "../../lib/session.js";

/**
 * Mint a key. The plaintext is returned exactly once, here, and never stored.
 */
export async function POST() {
	const session = await currentSession();
	if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

	const key = mintApiKey();
	await db.insert(apiKeys).values({
		orgId: session.orgId,
		keyHash: hashApiKey(key),
		label: "dashboard",
	});

	return NextResponse.json({ key });
}
