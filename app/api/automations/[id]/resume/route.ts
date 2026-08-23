// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { NextResponse } from "next/server";
import { currentSession } from "../../../../lib/session.js";
import { resumeAutomation } from "../../../../triggers/automations.js";

/**
 * Clear an auto-pause.
 *
 * Deliberately manual. An automation that paused itself after three consecutive
 * failures has told you something, and clearing that automatically after a
 * cooldown would re-enter the loop it exists to break — twenty-four failing
 * sandboxes a day, each billed, until somebody notices the invoice rather than
 * the dashboard.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	const session = await currentSession();
	if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

	const { id } = await params;
	await resumeAutomation(session.orgId, id);
	return NextResponse.json({ outcome: "resumed" });
}
