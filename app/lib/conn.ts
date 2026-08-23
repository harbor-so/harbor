// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Who is on the other end of a chat request, and which tenant they proved.
 *
 * The chat endpoints serve two callers over the same routes — a browser with a
 * signed session cookie, and an agent with an org API key — and both need the one
 * thing every query is scoped by: the org. Resolving it in one place keeps the
 * rule ("the connection proves the tenant; the body never asserts it") from being
 * re-implemented, and re-implemented slightly differently, on each route.
 *
 * A bearer key wins over a cookie when both are present: an explicit credential is
 * a stronger statement of intent than an ambient one, and it is the agent path.
 */

import { orgIdForKey } from "@core/kernel/auth.js";
import { currentSession } from "./session.js";

export interface Conn {
	orgId: string;
	via: "key" | "session";
	/** The signed-in user's id, when the caller is a browser session. */
	userId?: string;
	userName?: string;
}

export async function resolveConn(request: Request): Promise<Conn | null> {
	const auth = request.headers.get("authorization");
	if (auth) {
		const orgId = await orgIdForKey(auth);
		return orgId ? { orgId, via: "key" } : null;
	}

	const session = await currentSession();
	if (session) {
		return {
			orgId: session.orgId,
			via: "session",
			userId: session.userId ?? undefined,
			userName: session.userName ?? undefined,
		};
	}
	return null;
}
