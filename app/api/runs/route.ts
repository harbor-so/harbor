// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { NextResponse } from "next/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@core/schema/index.js";
import { apiKeys, runs } from "@core/schema/schema.js";
import { hashApiKey, mintApiKey } from "@core/kernel/keys.js";
import { launchRun, RunnerDisabledError, RUNTIME_IDS, type Runtime } from "../../lib/runner.js";
import { currentSession } from "../../lib/session.js";

export async function GET() {
	const session = await currentSession();
	if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
	const rows = await db
		.select()
		.from(runs)
		.where(eq(runs.orgId, session.orgId))
		.orderBy(desc(runs.startedAt))
		.limit(20);
	return NextResponse.json({ runs: rows });
}

/**
 * Launch an agent.
 *
 * The launched process needs a Harbor key to coordinate through, and it gets a
 * fresh one rather than a reused human key: a run is a separate principal, and
 * the day this needs revoking it should be revocable without logging anybody out.
 */
export async function POST(request: Request) {
	const session = await currentSession();
	if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

	const body = (await request.json().catch(() => ({}))) as {
		runtime?: string;
		prompt?: string;
		taskId?: string;
		agentId?: string;
	};

	const runtime = body.runtime as Runtime | undefined;
	if (!runtime || !RUNTIME_IDS.includes(runtime)) {
		return NextResponse.json(
			{ error: `runtime must be one of: ${RUNTIME_IDS.join(", ")}` },
			{ status: 400 },
		);
	}
	const prompt = body.prompt?.trim();
	if (!prompt || prompt.length > 8000) {
		return NextResponse.json({ error: "prompt is required, max 8000 chars." }, { status: 400 });
	}

	const key = mintApiKey();
	await db.insert(apiKeys).values({
		orgId: session.orgId,
		keyHash: hashApiKey(key),
		label: `run:${runtime}`,
	});

	try {
		const { runId } = await launchRun({
			orgId: session.orgId,
			runtime,
			prompt,
			agentId: body.agentId?.trim() || `${runtime}:harbor-${Date.now().toString(36)}`,
			taskId: body.taskId,
			apiKey: key,
		});
		return NextResponse.json({ ok: true, runId });
	} catch (error) {
		if (error instanceof RunnerDisabledError) {
			return NextResponse.json({ error: error.message }, { status: 503 });
		}
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : "Launch failed." },
			{ status: 500 },
		);
	}
}
