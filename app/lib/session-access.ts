// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Resolving "which session is this request about, and may it be here".
 *
 * Every session route repeats the same three steps, and the order and the
 * shapes are load-bearing rather than incidental:
 *
 *  1. **A presented credential is judged on its own.** An `Authorization`
 *     header resolves an org through `orgIdForKey` and does NOT fall back to the
 *     browser's ambient cookie when it fails. A falling-back check means a
 *     request with a revoked key succeeds for whoever happens to be signed in on
 *     that browser.
 *  2. **The lookup is org-scoped.** A key belonging to another tenant returns
 *     the same 404 as a key that was never minted. A distinct "wrong org"
 *     response would turn the session key space into an oracle anybody could
 *     probe for valid keys, and the keys are the only credential a session has.
 *  3. **Possession of the key is the authorisation.** There is no owner column
 *     and no per-viewer check beyond the org, deliberately — see the note in
 *     `src/db/schema.ts`.
 *
 * Written once here because six routes doing this by hand is six chances for
 * one of them to compare without the org.
 */

import { orgIdForKey } from "@core/kernel/auth.js";
import { currentSession } from "./session.js";
import { sessionByKey } from "./sessions.js";

export type SessionAccess =
	| { ok: true; orgId: string; session: NonNullable<Awaited<ReturnType<typeof sessionByKey>>> }
	| { ok: false; status: number; error: string };

export async function resolveSession(request: Request, key: string): Promise<SessionAccess> {
	const authorization = request.headers.get("authorization");
	const orgId = authorization
		? await orgIdForKey(authorization)
		: ((await currentSession())?.orgId ?? null);
	if (!orgId) return { ok: false, status: 401, error: "Not signed in." };

	const session = await sessionByKey(orgId, key);
	if (!session) return { ok: false, status: 404, error: "No such session." };

	return { ok: true, orgId, session };
}
