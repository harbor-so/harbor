// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { NextResponse } from "next/server";
import { forgetUserScmToken } from "../../../../git/credentials.js";
import { currentSession } from "../../../../lib/session.js";

/**
 * Disconnect a source-control identity.
 *
 * POST rather than GET, because it deletes something and a link a browser can
 * prefetch should not. What it costs is stated in the response rather than only
 * in the UI: after this, pull requests for this user's prompts stop being opened
 * and come back as compare URLs. That is the honest degradation, and somebody
 * clicking "disconnect" should see the sentence before they wonder where their
 * pull requests went.
 */
export async function POST() {
	const session = await currentSession();
	if (!session || !session.userId) {
		return NextResponse.json({ error: "Sign in first." }, { status: 401 });
	}

	const forgotten = await forgetUserScmToken(session.userId);
	return NextResponse.json({
		disconnected: forgotten,
		consequence:
			"Harbor will no longer open pull requests for your prompts. Branches are still "
			+ "pushed and you will get a compare URL to open one by hand. Reconnect at any time "
			+ "from Settings.",
	});
}
