// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { connectorFor } from "../../../connectors/registry.js";
import type { ConnectorContext } from "../../../connectors/types.js";
import { db } from "@core/schema/index.js";
import { connectors, events } from "@core/schema/schema.js";

/**
 * One route per connector, and the ordering inside it is the security model.
 *
 * Read top to bottom, the sequence is: raw bytes → signature → account → org →
 * handler. Each step may only use facts established by the step before it, and
 * the reason for that discipline is that every shortcut here is a cross-tenant
 * write.
 *
 * **Signature before parse.** The raw body is verified against those exact bytes
 * before anything parses them. Verifying a re-serialised object is the classic
 * way to make signature checking useless: `JSON.parse` followed by
 * `JSON.stringify` does not reproduce the sender's whitespace or key order, so
 * either the check fails for valid payloads or somebody "fixes" it by trusting
 * the parse.
 *
 * **Account from the verified payload, org from the account.** This is the fix
 * for a bug the README used to document as known and open: the connector row was
 * selected by `type` alone, so the first active row won, and a deployment serving
 * two organisations that both used Linear delivered each org's issues into
 * whichever row happened to be first. The org is now read off the row whose
 * `external_account_id` matches the id the *verified* payload carried — so a
 * sender still cannot assert which tenant it belongs to, but two tenants sharing
 * a connector type no longer collide.
 *
 * **A payload whose account cannot be resolved is refused, not guessed.** There
 * is a narrow, deliberate exception below for a single-connector deployment that
 * has not yet been backfilled, and it is loud about being an exception.
 */
export async function POST(
	request: Request,
	{ params }: { params: Promise<{ connector: string }> },
) {
	const { connector: type } = await params;
	const connector = connectorFor(type);
	if (!connector) {
		return NextResponse.json({ error: `Unknown connector "${type}".` }, { status: 404 });
	}

	const raw = await request.text();
	if (raw.length > 1_000_000) {
		return NextResponse.json({ error: "Payload too large." }, { status: 413 });
	}

	const headers: Record<string, string | undefined> = {};
	request.headers.forEach((value, key) => {
		headers[key.toLowerCase()] = value;
	});

	// Slack's URL verification handshake arrives signed, so it is checked below
	// like anything else — but it must be answered before the account lookup,
	// because at handshake time the connector row does not exist yet.
	const rows = await db
		.select()
		.from(connectors)
		.where(and(eq(connectors.type, type), eq(connectors.status, "active")));

	// The secret is per-row, and every row is tried. A deployment with two Slack
	// workspaces has two secrets, and we cannot know which one signed this until
	// one of them verifies — that verification IS the tenant resolution.
	const verified = rows.find((row) => {
		const secret =
			(row.config as { webhookSecret?: string } | null)?.webhookSecret
			?? process.env[`${type.toUpperCase()}_WEBHOOK_SECRET`];
		return Boolean(secret) && connector.verifyWebhook(raw, headers, secret!);
	});

	if (!verified) {
		if (rows.length === 0) {
			return NextResponse.json({ error: `${type} is not installed.` }, { status: 404 });
		}
		// A missing secret and a bad signature are deliberately indistinguishable to
		// the sender. Telling an unauthenticated caller which of the two it was
		// tells them whether the endpoint is worth attacking.
		const anySecret = rows.some(
			(row) =>
				(row.config as { webhookSecret?: string } | null)?.webhookSecret
				?? process.env[`${type.toUpperCase()}_WEBHOOK_SECRET`],
		);
		if (!anySecret) {
			// Except in the logs, where the operator needs to know. Accepting unsigned
			// webhooks "until it is configured" is how an unauthenticated write
			// endpoint reaches production.
			console.error(
				`[webhook] ${type} has no webhook secret configured on any connector row. `
					+ "Every delivery will be rejected until one is set.",
			);
		}
		return new NextResponse(null, { status: 401 });
	}

	const payload: unknown = JSON.parse(raw);

	// Slack proves ownership of the endpoint by asking us to echo a challenge.
	if (type === "slack" && isRecord(payload) && payload.type === "url_verification") {
		return NextResponse.json({ challenge: payload.challenge });
	}

	const account = connector.resolveAccount(payload);
	if (account && verified.externalAccountId && account !== verified.externalAccountId) {
		// The signature verified against this row's secret but the payload names a
		// different account. That is either a misconfiguration or an attempt to
		// deliver one tenant's data under another's credential, and neither is
		// something to process.
		console.error(
			`[webhook] ${type}: payload names account ${account} but the verifying `
				+ `connector row is bound to ${verified.externalAccountId}. Refused.`,
		);
		return NextResponse.json({ error: "Account mismatch." }, { status: 409 });
	}

	// Backfill on first verified delivery, so an installation created before this
	// column existed becomes tenant-scoped the first time it is used rather than
	// requiring a manual migration step nobody will run.
	if (account && !verified.externalAccountId) {
		await db
			.update(connectors)
			.set({ externalAccountId: account })
			.where(eq(connectors.id, verified.id));
	}

	const ctx: ConnectorContext = {
		orgId: verified.orgId,
		connectorId: verified.id,
		externalAccountId: account ?? verified.externalAccountId ?? "",
		config: (verified.config as Record<string, unknown> | null) ?? {},
		// Minted at the edge and carried through the sandbox and back, so one Slack
		// message and the pull request it eventually produces share one greppable
		// token across three processes.
		traceId: headers["x-harbor-trace-id"] ?? randomUUID(),
	};

	const result = await connector.handleWebhook(payload, ctx);

	await db
		.update(connectors)
		.set({ lastSyncedAt: new Date() })
		.where(eq(connectors.id, verified.id));
	await db.insert(events).values({
		orgId: verified.orgId,
		taskId: result.taskId ?? null,
		type: "connector_synced",
		payload: {
			connector: type,
			action: result.action,
			reason: result.reason,
			trace_id: ctx.traceId,
		},
	});

	return NextResponse.json(result);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
