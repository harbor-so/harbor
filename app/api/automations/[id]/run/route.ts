// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@core/schema/index.js";
import { automations } from "@core/schema/schema.js";
import { currentSession } from "../../../../lib/session.js";
import { runAutomation } from "../../../../triggers/automations.js";

/**
 * Fire an automation now.
 *
 * The org check is a lookup scoped by orgId before the id is used, not a filter
 * applied afterwards — an automation id from another tenant must miss, and the
 * only way to guarantee that is to never load the row without the scope.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	const session = await currentSession();
	if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

	const { id } = await params;
	const automation = await db.query.automations.findFirst({
		where: and(eq(automations.id, id), eq(automations.orgId, session.orgId)),
	});
	if (!automation) return NextResponse.json({ error: "No such automation." }, { status: 404 });

	const outcome = await runAutomation(automation.id);
	return NextResponse.json({ outcome });
}
