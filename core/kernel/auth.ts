// SPDX-License-Identifier: Apache-2.0
/**
 * Resolve a bearer token to an org.
 *
 * The key names no org; the org is read off the row the digest matched. That
 * ordering is the point — a request cannot assert which tenant it belongs to,
 * it can only prove which key it holds.
 */

import { and, eq, isNull } from "drizzle-orm";
import { db } from "../schema/index.js";
import { apiKeys } from "../schema/schema.js";
import { hashApiKey } from "./keys.js";

export async function orgIdForKey(rawKey: string | undefined): Promise<string | null> {
	if (!rawKey) return null;
	const key = rawKey.replace(/^Bearer\s+/i, "").trim();
	if (!key) return null;

	const row = await db.query.apiKeys.findFirst({
		where: and(eq(apiKeys.keyHash, hashApiKey(key)), isNull(apiKeys.revokedAt)),
	});
	return row?.orgId ?? null;
}
