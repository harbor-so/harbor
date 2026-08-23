// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * A trigger source — the inbound half of an event-driven automation.
 *
 * This is deliberately a *separate* interface from `Connector` (src/connectors),
 * not a reuse of it, and the difference is the tenant model. A connector resolves
 * its tenant *from the verified payload* (`resolveAccount`) because one connector
 * URL is shared across every org and the sender must not be able to assert which
 * org it belongs to. A trigger is delivered to `POST /api/triggers/<source>/<id>`
 * where `<id>` already names one automation row, so the org is read off that row
 * and there is nothing to resolve from the payload. Each automation carries its
 * own signing secret; knowing an id (they appear in the dashboard) buys nothing
 * without it.
 *
 * A source therefore needs only three things — prove the delivery is authentic,
 * name it so a retry is deduplicable, and turn it into the two shapes the shared
 * machinery already understands: a `ConditionSubject` the existing evaluator
 * gates on, and a human context block appended to the automation's prompt. It has
 * no `outboundWrites`, no `route`, no `postActivity`: a trigger is inbound only,
 * and forcing it through the connector's seven bidirectional members would be six
 * dead stubs and two phantom rows on `/connectors`.
 */

import type { ConditionSubject } from "../conditions.js";

export interface TriggerSource {
	/** The `automations.source` value this handler owns: `"webhook"` | `"sentry"`. */
	type: string;

	/**
	 * True iff `raw` was signed by `secret`. Verifies the HMAC over the **raw
	 * bytes**, never a re-serialised object — `JSON.parse` then `JSON.stringify`
	 * does not reproduce the sender's whitespace or key order, so a check against
	 * the re-serialised form either rejects valid payloads or gets "fixed" into
	 * trusting the parse. `now` is injectable so a replay-window test is
	 * deterministic.
	 */
	verify(
		raw: string,
		headers: Record<string, string | undefined>,
		secret: string,
		now?: Date,
	): boolean;

	/** Normalise the payload into the facts the shared condition evaluator gates on. */
	normalize(payload: unknown): ConditionSubject;

	/**
	 * A stable identity for this delivery, for idempotency — a provider event id,
	 * a delivery header. `null` when the source cannot name one, in which case the
	 * caller falls back to a hash of the raw body.
	 */
	deliveryId(
		payload: unknown,
		headers: Record<string, string | undefined>,
	): string | null;

	/**
	 * A short, human-readable block describing what fired, appended to the
	 * automation's prompt so the agent sees the triggering event. Labelled as
	 * untrusted input, because it is.
	 */
	describe(payload: unknown): string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
