// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The viewer's own source-control token, and the two different ways it can be
 * missing.
 *
 * Every repository question Harbor asks GitHub on a user's behalf — can you see
 * this, what can you see, connect this one — is asked with **that user's** token
 * rather than the App installation's. That is the whole multi-tenancy argument
 * in `src/lib/repos.ts`, and it means each of those routes needs the same three
 * lines and the same two refusals.
 *
 * The refusals are separate on purpose and mirror `PrAuthority`:
 *
 *  - **absent** → 403. There is no identity. Retrying will not produce one; the
 *    person has to connect an account, and the message says where.
 *  - **indeterminate** → 503 with `retry_after`. GitHub or the database was
 *    briefly unreachable. Reporting this as "you have no identity" would tell
 *    somebody to reconnect an account that is already connected and working.
 *
 * Collapsing them is one line and it is the same mistake `openPullRequest`
 * refuses to make.
 */

import { userScmToken } from "../git/credentials.js";
import { assertNever } from "../git/provider.js";
import type { Session } from "./session.js";

export type ViewerScm =
	| { kind: "available"; token: string; login: string }
	| { kind: "refused"; status: number; error: string; reason: string };

export async function viewerScmToken(session: Session): Promise<ViewerScm> {
	if (!session.userId) {
		return {
			kind: "refused",
			status: 403,
			reason: "no_signed_in_user",
			error:
				"Repository access is checked against your own GitHub account, and this request "
				+ "has no signed-in user — you are on the development bypass. Configure GitHub "
				+ "OAuth and sign in.",
		};
	}

	const outcome = await userScmToken(session.userId);
	switch (outcome.kind) {
		case "available":
			return { kind: "available", token: outcome.token, login: outcome.login };
		case "absent":
			return {
				kind: "refused",
				status: 403,
				reason: outcome.reason,
				error:
					`${outcome.message} Harbor checks repository access with your own token rather `
					+ "than the shared app installation, because otherwise every user of this "
					+ "deployment could reach every repository the app can. Connect an account at "
					+ "/api/auth/scm.",
			};
		case "indeterminate":
			return {
				kind: "refused",
				status: 503,
				reason: outcome.reason,
				error:
					`Harbor could not read your source-control identity just now (${outcome.detail}). `
					+ "This is not a permission problem and nothing needs reconnecting — try again "
					+ "in a moment.",
			};
	}
	return assertNever(outcome, "viewerScmToken");
}
