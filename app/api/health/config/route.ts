// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { NextResponse } from "next/server";
import { describeConfig } from "@core/kernel/config.js";
import { scmOAuthConfig } from "../../../git/credentials.js";
import { startupAttributionWarning } from "../../../git/provider.js";
import { currentSession } from "../../../lib/session.js";

/**
 * What this deployment is actually running with, and why.
 *
 * Every tunable, its resolved value, whether that came from a repository
 * override, an environment variable or the default, and the prose derivation of
 * why the default is what it is. The alternative to this endpoint is an
 * archaeology exercise across a Helm chart, a Dockerfile and src/config.ts, which
 * is what an operator does at 2am when sandboxes are dying and they suspect a
 * timeout.
 *
 * Signed-in only. The values are not secret, but they are a precise description
 * of how to make the deployment misbehave.
 */
export const dynamic = "force-dynamic";

export async function GET() {
	const session = await currentSession();
	if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

	// The SCM attribution posture, in the SAME sentence the startup warning uses.
	// credentials.ts promised "a health endpoint can show the same text" while no
	// endpoint did — and this is the degradation an operator most needs to see on
	// a dashboard, because its symptom (PRs that never open) presents days later
	// and nowhere near its cause. The pure text builder, not the console-warning
	// wrapper: a health poll every ten seconds must not spam the log.
	const oauth = scmOAuthConfig();
	return NextResponse.json({
		settings: describeConfig(),
		scm_attribution: {
			configured: oauth.configured,
			warning: startupAttributionWarning(oauth.configured),
		},
	});
}
