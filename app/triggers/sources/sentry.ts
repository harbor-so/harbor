// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The Sentry source — auto-triage from an alert without a human present.
 *
 * Sentry signs each delivery with an HMAC-SHA256 of the raw body keyed by the
 * integration's client secret (`sentry-hook-signature`), which is exactly the
 * per-automation secret model this endpoint already uses. Some deliveries also
 * carry `sentry-hook-timestamp`; when they do, a stale one is rejected on the
 * same ±window as the Slack connector, so a captured alert is not replayable into
 * a fresh sandbox forever.
 *
 * The design decision worth stating: rather than add a `sentry.eventType` field
 * to the schema and a second gate beside the shared condition evaluator, the
 * event type is folded into `labels`. `normalize` emits `action:created`,
 * `level:error`, `resource:issue`, `project:<slug>` and so on, and an operator who
 * wants "only new issues, only errors" writes an ordinary
 * `label any_of ["action:created", "level:error"]` condition. One evaluator gates
 * every source, deliberately: a bespoke per-source filter registry is the easy
 * thing to grow into, and its cost shows up later as five slightly different
 * condition languages an operator has to learn one at a time.
 */

import { createHmac } from "node:crypto";
import { setting } from "@core/kernel/config.js";
import { secretEquals } from "../../lib/crypto.js";
import type { ConditionSubject } from "../conditions.js";
import { isRecord, type TriggerSource } from "./types.js";

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A project slug whether Sentry sent a nested object or a bare string. */
function projectSlug(value: unknown): string | undefined {
	if (isRecord(value)) return str(value.slug) ?? str(value.name);
	return str(value);
}

/** The issue record, across Sentry's `data.issue` and legacy `data.event` shapes. */
function issueOf(payload: Record<string, unknown>): Record<string, unknown> | undefined {
	const data = isRecord(payload.data) ? payload.data : undefined;
	if (data && isRecord(data.issue)) return data.issue;
	if (isRecord(payload.issue)) return payload.issue;
	return undefined;
}

function metricAlertOf(payload: Record<string, unknown>): Record<string, unknown> | undefined {
	const data = isRecord(payload.data) ? payload.data : undefined;
	if (data && isRecord(data.metric_alert)) return data.metric_alert;
	return undefined;
}

export const sentrySource: TriggerSource = {
	type: "sentry",

	verify(raw, headers, secret, now = new Date()) {
		const supplied = headers["sentry-hook-signature"];
		if (!supplied || !/^[0-9a-f]{64}$/i.test(supplied)) return false;

		// Replay window only when a timestamp is signed over — Sentry does not send
		// one on every resource, and inventing a rejection for a header that was
		// never part of the signed material would reject valid deliveries.
		const ts = headers["sentry-hook-timestamp"];
		if (ts !== undefined) {
			const sent = Number(ts);
			if (!Number.isFinite(sent)) return false;
			if (Math.abs(now.getTime() / 1000 - sent) > setting("triggerReplayWindowSeconds")) {
				return false;
			}
		}

		const expected = createHmac("sha256", secret).update(raw).digest("hex");
		return secretEquals(expected, supplied.toLowerCase());
	},

	normalize(payload) {
		if (!isRecord(payload)) return {};
		const labels: string[] = [];

		const action = str(payload.action);
		if (action) labels.push(`action:${action}`);

		const issue = issueOf(payload);
		const metric = metricAlertOf(payload);
		let title: string | undefined;
		let author: string | undefined;

		if (issue) {
			labels.push("resource:issue");
			const level = str(issue.level);
			if (level) labels.push(`level:${level}`);
			const project = projectSlug(issue.project);
			if (project) labels.push(`project:${project}`);
			title = str(issue.title) ?? (isRecord(issue.metadata) ? str(issue.metadata.value) : undefined);
			author = str(issue.culprit);
		} else if (metric) {
			labels.push("resource:metric_alert");
			title = str(metric.title);
		}

		const environment = str(payload.environment)
			?? (isRecord(payload.data) ? str(payload.data.environment) : undefined);
		if (environment) labels.push(`environment:${environment}`);

		return {
			labels,
			title: title ?? null,
			author: author ?? null,
		};
	},

	deliveryId(payload, headers) {
		if (isRecord(payload)) {
			const data = isRecord(payload.data) ? payload.data : undefined;
			const event = data && isRecord(data.event) ? data.event : undefined;
			const fromEvent = event && str(event.event_id);
			if (fromEvent) return fromEvent;
			const issue = issueOf(payload);
			const fromIssue = issue && str(issue.id);
			if (fromIssue) return fromIssue;
			const topId = str(payload.id);
			if (topId) return topId;
		}
		return str(headers["request-id"]) ?? null;
	},

	describe(payload) {
		if (!isRecord(payload)) return "Triggered by a Sentry alert.";
		const issue = issueOf(payload);
		const metric = metricAlertOf(payload);
		const lines: string[] = ["Triggered by a Sentry alert."];
		if (issue) {
			const title = str(issue.title);
			if (title) lines.push(`Issue: ${title}`);
			const level = str(issue.level);
			if (level) lines.push(`Level: ${level}`);
			const culprit = str(issue.culprit);
			if (culprit) lines.push(`Culprit: ${culprit}`);
			const permalink = str(issue.permalink) ?? str(issue.web_url);
			if (permalink) lines.push(`Link: ${permalink}`);
		} else if (metric) {
			const title = str(metric.title);
			if (title) lines.push(`Metric alert: ${title}`);
		}
		return lines.join("\n");
	},
};
