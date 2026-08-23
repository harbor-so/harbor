// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@core/schema/index.js";
import { devinSessions, tasks } from "@core/schema/schema.js";
import { orgIdForKey } from "@core/kernel/auth.js";
import { createSession } from "../../../lib/sessions.js";
import { createDevinSession, DevinApiError } from "../../../devin/client.js";
import { devinTokenFor } from "../../../devin/token.js";

/**
 * Register a Devin session for tracking — the one thing Devin cannot do for
 * itself, because it has no hook to fire on Harbor's behalf and no webhook to
 * announce it started.
 *
 * Authenticated by the same Harbor API key the activity hooks and the MCP server
 * use: the org is read off the key, never asserted by the body, so a caller can
 * only register a session into the org it holds the key for — the same tenancy
 * rule as everything else that ingests.
 *
 * Two modes on one endpoint:
 *   - Observe: `{ devinSessionId }` — track a Devin session that already exists.
 *   - Spawn:   `{ prompt }` — start a Devin session from a prompt and track it, so
 *              Harbor can kick off Devin work, not only watch it.
 *
 * Registration is idempotent: a `devin_sessions` row is unique per
 * `(org, devinSessionId)`, and re-registering an already-tracked session returns
 * the existing mapping rather than minting a second Harbor session for it.
 */

// harbor-lint-allow-constant: an input-validation bound on a display field, not an
// operational tunable — it mirrors the automations route's own MAX_NAME, and nothing
// downstream reads it. A self-hoster does not need per-repo control over how long a
// session title may be.
const MAX_TITLE = 200;

function bad(message: string, status = 400) {
	return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
	const orgId = await orgIdForKey(request.headers.get("authorization") ?? undefined);
	if (!orgId) return new NextResponse(null, { status: 401 });

	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return bad("Invalid JSON body.");
	}

	const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : "Devin session";
	if (title.length > MAX_TITLE) return bad(`Title is too long (max ${MAX_TITLE}).`);

	// An optional link to the Harbor task this Devin session is doing, verified to
	// belong to this org so a task id from another tenant misses rather than links.
	const taskId = typeof body.taskId === "string" && body.taskId.trim() ? body.taskId.trim() : undefined;
	if (taskId) {
		const task = await db.query.tasks.findFirst({
			where: and(eq(tasks.id, taskId), eq(tasks.orgId, orgId)),
		});
		if (!task) return bad("No such task in this org.", 404);
	}

	const providedId =
		typeof body.devinSessionId === "string" && body.devinSessionId.trim()
			? body.devinSessionId.trim()
			: undefined;
	const prompt = typeof body.prompt === "string" && body.prompt.trim() ? body.prompt.trim() : undefined;

	if (!providedId && !prompt) {
		return bad("Provide either devinSessionId (to observe) or prompt (to spawn).");
	}

	// Spawn mode needs a credential; resolve it before minting anything so a missing
	// token fails cleanly rather than leaving an orphan Harbor session behind.
	let devinSessionId = providedId;
	if (!devinSessionId && prompt) {
		const token = await devinTokenFor(orgId);
		if (!token) {
			return bad(
				"No Devin API token for this org. Add a `devin` connector with config.apiToken, "
					+ "or set DEVIN_API_TOKEN.",
				400,
			);
		}
		try {
			const created = await createDevinSession(token, prompt);
			devinSessionId = created.session_id;
		} catch (error) {
			const status = error instanceof DevinApiError ? error.status : 502;
			return bad(`Could not start a Devin session (HTTP ${status}).`, 502);
		}
	}

	// Idempotent: an already-tracked session returns its existing mapping. Checked
	// before minting a session so re-registration cannot leave orphan sessions.
	const existing = await db.query.devinSessions.findFirst({
		where: and(eq(devinSessions.orgId, orgId), eq(devinSessions.devinSessionId, devinSessionId!)),
	});
	if (existing) {
		return NextResponse.json(
			{ status: "already_tracked", devinSessionId, sessionId: existing.sessionId },
			{ status: 200 },
		);
	}

	const session = await createSession({ orgId, title, createdBy: "devin", taskId });

	// onConflictDoNothing is the backstop for two registrations racing between the
	// check above and here; the unique index is the real guarantee.
	const [inserted] = await db
		.insert(devinSessions)
		.values({ orgId, devinSessionId: devinSessionId!, sessionId: session.id })
		.onConflictDoNothing({ target: [devinSessions.orgId, devinSessions.devinSessionId] })
		.returning({ id: devinSessions.id });

	return NextResponse.json(
		{
			status: inserted ? "tracking" : "already_tracked",
			devinSessionId,
			sessionId: session.id,
			sessionKey: session.key,
		},
		{ status: inserted ? 201 : 200 },
	);
}
