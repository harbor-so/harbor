// SPDX-License-Identifier: Apache-2.0
/**
 * Org API keys.
 *
 * `hbr_<32 bytes base64url>`. The database stores only a SHA-256 digest, so a
 * leaked table dump grants nothing and a lost key can only be replaced, never
 * recovered — which is the correct trade for a credential that lets an agent
 * claim work on a team's behalf.
 *
 * Unsalted, deliberately: bcrypt exists to make an offline search expensive and
 * a search needs a space small enough to walk, which 256 bits of CSPRNG output
 * does not have. A salt would also make the column unindexable and turn every
 * MCP call into a table scan.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function mintApiKey(): string {
	return `hbr_${randomBytes(32).toString("base64url")}`;
}

export function hashApiKey(key: string): string {
	return createHash("sha256").update(key).digest("hex");
}

/** Constant-time compare of two hex digests of equal length. */
export function digestsMatch(a: string, b: string): boolean {
	const left = Buffer.from(a, "hex");
	const right = Buffer.from(b, "hex");
	if (left.length !== right.length || left.length === 0) return false;
	return timingSafeEqual(left, right);
}
