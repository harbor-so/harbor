// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Metrics, not just logs.
 *
 * Every number below is already computed somewhere in Harbor as a side effect of
 * doing the work — a sandbox row knows when it was requested and when it became
 * ready, the event log knows every claim conflict, the circuit breaker table
 * knows every trip. Computing those facts and then throwing them away leaves
 * "read the logs" as the operations posture for a system whose critical
 * dependencies are external providers that fail in ways you cannot reproduce —
 * which is the posture this file exists to avoid.
 *
 * So this file does no new measurement. It reads what is already there and
 * renders it in a format a scrape can consume.
 *
 * ## Why these
 *
 * They are the six that tell you *which layer is broken* when somebody says
 * "Harbor is slow today", and between them they cover every external dependency:
 *
 *  - **Spawn success rate** and **provider error rate by type** — is the sandbox
 *    provider healthy, and is the failure transient or a misconfiguration? The
 *    split matters because the remedies are "wait" and "fix your config", and
 *    conflating them sends an operator looking in the wrong place.
 *  - **Time to ready, p50 and p99** — the number the whole latency argument rests
 *    on. The p99 is the one that matters: a p50 of nine seconds with a p99 of four
 *    minutes is a product that feels broken to one user in a hundred, which is
 *    enough for them to stop using it, and a mean would hide it entirely.
 *  - **Circuit breaker trips** — a step change here is a provider outage, and it
 *    is the earliest signal available.
 *  - **Claim conflict rate** — the number Harbor's coordination half is judged on.
 *    Every conflict is a duplicated piece of work that did not happen.
 *  - **Lease expiry and orphan rate** — a rise means agents are dying mid-task, or
 *    the default lease is too short for the work people are actually doing.
 *
 * ## The format
 *
 * Prometheus text exposition, because it is scrapeable by Prometheus and also by
 * every OTLP collector, Datadog agent and Grafana Alloy anyone is likely to
 * already run — which is the same reason the rest of the system uses Postgres and
 * SSE. Adding a vendor SDK would put a dependency in the observability path of a
 * product whose pitch is that it has no vendor dependencies.
 */

import { sql as raw } from "drizzle-orm";
import { setting } from "@core/kernel/config.js";
import { db } from "@core/schema/index.js";

interface Metric {
	name: string;
	help: string;
	type: "counter" | "gauge" | "histogram";
	samples: Array<{ labels?: Record<string, string>; value: number }>;
}

function render(metrics: Metric[]): string {
	const lines: string[] = [];
	for (const metric of metrics) {
		lines.push(`# HELP ${metric.name} ${metric.help}`);
		lines.push(`# TYPE ${metric.name} ${metric.type}`);
		for (const sample of metric.samples) {
			const labels = sample.labels
				? `{${Object.entries(sample.labels)
						.map(([key, value]) => `${key}="${escapeLabel(value)}"`)
						.join(",")}}`
				: "";
			lines.push(`${metric.name}${labels} ${sample.value}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

/** Prometheus label values escape backslash, quote and newline, and nothing else. */
function escapeLabel(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * The scrape.
 *
 * Deliberately org-labelled rather than org-filtered. A single deployment is one
 * organisation's trust boundary, but it may hold several org rows (a test org, a
 * demo org), and an operator wants to see them separately rather than added
 * together — a summed spawn success rate across a healthy production org and a
 * broken demo org is a number that means nothing.
 */
export async function collectMetrics(): Promise<string> {
	const [spawns, latency, providerErrors, breakers, trips, orphans, conflicts, expiries, spend, live, orgs] =
		await Promise.all([
			db.execute(raw`
				select org_id::text as org, provider, status, count(*)::int as n
				from sandboxes
				where created_at > now() - interval '24 hours'
				group by 1, 2, 3
			`),
			// Percentiles from Postgres rather than pulled into JS: the alternative
			// reads every sandbox row of the last day into memory on every scrape,
			// which turns the observability endpoint into the heaviest query in the
			// system exactly when the system is already struggling.
			db.execute(raw`
				select
					provider,
					percentile_disc(0.5) within group (
						order by extract(epoch from (ready_at - created_at))
					) as p50,
					percentile_disc(0.99) within group (
						order by extract(epoch from (ready_at - created_at))
					) as p99
				from sandboxes
				where ready_at is not null and created_at > now() - interval '24 hours'
				group by 1
			`),
			db.execute(raw`
				select provider, coalesce(failure_reason, 'unknown') as error_type, count(*)::int as n
				from sandboxes
				where status = 'failed' and created_at > now() - interval '24 hours'
				group by 1, 2
			`),
			db.execute(raw`
				select org_id::text as org, provider,
					case when opened_at is not null then 1 else 0 end as open,
					consecutive_failures
				from circuit_breakers
			`),
			db.execute(raw`
				select org_id::text as org, payload->>'provider' as provider, count(*)::int as n
				from events
				where type = 'circuit_opened' and created_at > now() - interval '24 hours'
				group by 1, 2
			`),
			db.execute(raw`
				select org_id::text as org, payload->>'outcome' as outcome, count(*)::int as n
				from events
				where type = 'orphan_reconciled' and created_at > now() - interval '24 hours'
				group by 1, 2
			`),
			db.execute(raw`
				select org_id::text as org, type, count(*)::int as n
				from events
				where type in ('claim_conflict', 'claimed', 'completed')
					and created_at > now() - interval '24 hours'
				group by 1, 2
			`),
			db.execute(raw`
				select org_id::text as org, count(*)::int as n
				from events
				where type = 'claim_expired' and created_at > now() - interval '24 hours'
				group by 1
			`),
			db.execute(raw`
				select org_id::text as org, coalesce(sum(micro_usd), 0)::bigint as micro
				from cost_events
				where created_at >= date_trunc('day', now() at time zone 'utc')
				group by 1
			`),
			db.execute(raw`
				select provider, count(*)::int as n
				from sandboxes
				where status in ('spawning', 'ready', 'busy', 'idle')
				group by 1
			`),
			db.execute(raw`select id::text as org from orgs`),
		]);

	const rows = <T,>(result: unknown): T[] => result as T[];

	const metrics: Metric[] = [
		{
			name: "harbor_sandbox_spawns_total",
			help: "Sandboxes created in the last 24h, by provider and terminal status.",
			type: "counter",
			samples: rows<{ org: string; provider: string; status: string; n: number }>(spawns).map(
				(row) => ({
					labels: { org: row.org, provider: row.provider, status: row.status },
					value: row.n,
				}),
			),
		},
		{
			name: "harbor_sandbox_time_to_ready_seconds",
			help: "Boot latency from request to bridge-ready, last 24h.",
			type: "gauge",
			samples: rows<{ provider: string; p50: string | null; p99: string | null }>(latency).flatMap(
				(row) => [
					{ labels: { provider: row.provider, quantile: "0.5" }, value: Number(row.p50 ?? 0) },
					{ labels: { provider: row.provider, quantile: "0.99" }, value: Number(row.p99 ?? 0) },
				],
			),
		},
		{
			name: "harbor_provider_errors_total",
			help: "Failed spawns by classified error type. Transient and permanent are different remedies.",
			type: "counter",
			samples: rows<{ provider: string; error_type: string; n: number }>(providerErrors).map(
				(row) => ({
					labels: { provider: row.provider, error_type: row.error_type },
					value: row.n,
				}),
			),
		},
		{
			name: "harbor_circuit_breaker_open",
			help: "1 when the shared circuit for a provider is open. A step change here is a provider outage.",
			type: "gauge",
			samples: rows<{ org: string; provider: string; open: number }>(breakers).map((row) => ({
				labels: { org: row.org, provider: row.provider },
				value: row.open,
			})),
		},
		{
			name: "harbor_circuit_breaker_consecutive_failures",
			help: "Failures counted towards the current window, per provider.",
			type: "gauge",
			samples: rows<{ org: string; provider: string; consecutive_failures: number }>(breakers).map(
				(row) => ({
					labels: { org: row.org, provider: row.provider },
					value: row.consecutive_failures,
				}),
			),
		},
		{
			name: "harbor_circuit_breaker_trips_total",
			help: "Breaker OPENINGS in the last 24h — the edge, not the state. A gauge misses a trip that opens and closes between scrapes; this is what rate() alerts on.",
			type: "counter",
			samples: rows<{ org: string; provider: string | null; n: number }>(trips).map((row) => ({
				labels: { org: row.org, provider: row.provider ?? "unknown" },
				value: row.n,
			})),
		},
		{
			name: "harbor_orphans_reconciled_total",
			help: "Orphaned containers adopted or stopped in the last 24h. Every one is an ambiguous failure that actually happened; a rising rate is a provider getting worse, visible before the bill.",
			type: "counter",
			samples: rows<{ org: string; outcome: string | null; n: number }>(orphans).map((row) => ({
				labels: { org: row.org, outcome: row.outcome ?? "unknown" },
				value: row.n,
			})),
		},
		{
			name: "harbor_claim_events_total",
			help: "Claims, completions and conflicts in the last 24h. Conflicts are duplicated work that did not happen.",
			type: "counter",
			samples: rows<{ org: string; type: string; n: number }>(conflicts).map((row) => ({
				labels: { org: row.org, type: row.type },
				value: row.n,
			})),
		},
		{
			name: "harbor_claim_expiries_total",
			help: "Leases that lapsed in the last 24h. A rise means agents dying mid-task, or a lease default that is too short.",
			type: "counter",
			samples: rows<{ org: string; n: number }>(expiries).map((row) => ({
				labels: { org: row.org },
				value: row.n,
			})),
		},
		{
			name: "harbor_spend_today_micro_usd",
			help: "Spend since the start of the UTC day, in millionths of a dollar.",
			type: "gauge",
			samples: rows<{ org: string; micro: string }>(spend).map((row) => ({
				labels: { org: row.org },
				value: Number(row.micro),
			})),
		},
		{
			name: "harbor_spend_cap_micro_usd",
			help: "The configured daily cap, per org, so spend/cap alerts divide two exported numbers instead of hardcoding the cap into the alert rule.",
			type: "gauge",
			samples: rows<{ org: string }>(orgs).map((row) => ({
				labels: { org: row.org },
				// The cap is deployment-global today; labelled per org so the shape
				// matches harbor_spend_today_micro_usd and survives a per-org cap later.
				value: setting("maxSpendPerDayMicroUsd"),
			})),
		},
		{
			name: "harbor_sandboxes_live",
			help: "Sandboxes currently spawning, ready, busy or idle. This is what you are paying for right now.",
			type: "gauge",
			samples: rows<{ provider: string; n: number }>(live).map((row) => ({
				labels: { provider: row.provider },
				value: row.n,
			})),
		},
	];

	return render(metrics);
}

/**
 * Liveness versus readiness, and the distinction is not pedantry.
 *
 * **Liveness** answers "should this process be restarted?" and must not depend on
 * anything external. If it checked Postgres, a database blip would make every
 * replica fail its liveness probe simultaneously, and the orchestrator would
 * restart the entire fleet in the middle of an incident — turning a recoverable
 * dependency failure into a total outage plus a cold start.
 *
 * **Readiness** answers "should traffic be sent here?" and *must* depend on
 * Postgres, because a replica that cannot reach the database cannot serve
 * anything useful and should be taken out of rotation until it can.
 */
export function liveness(): { ok: true } {
	return { ok: true };
}

export async function readiness(): Promise<{ ok: boolean; checks: Record<string, string> }> {
	const checks: Record<string, string> = {};
	let ok = true;

	try {
		await db.execute(raw`select 1`);
		checks.database = "ok";
	} catch (error) {
		checks.database = `unreachable: ${(error as Error).message}`;
		ok = false;
	}

	// Configuration is checked here rather than only at boot because a deployment
	// that starts with a valid config and is then given an incoherent one through
	// a rolling environment change should stop taking traffic, not serve requests
	// that will kill every sandbox they create.
	try {
		const { validateConfig } = await import("@core/kernel/config");
		validateConfig();
		checks.config = "ok";
	} catch (error) {
		checks.config = (error as Error).message;
		ok = false;
	}

	const { encryptionConfigured } = await import("./crypto.js");
	if (encryptionConfigured()) {
		checks.encryption = "ok";
	} else {
		// Not fatal for readiness: a deployment with no secrets and no connectors
		// works fine without a key, and refusing traffic would make the first-run
		// experience a failing health check rather than a working dashboard.
		checks.encryption = "no HARBOR_ENCRYPTION_KEY — secrets and connectors are unavailable";
	}

	return { ok, checks };
}
