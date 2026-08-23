// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * What this is costing, and where the money went.
 *
 * A background agent platform spends money while nobody is watching — that is
 * the product — so this page exists to make the bill legible *before* it arrives
 * rather than after. It answers four questions in the order somebody actually
 * asks them:
 *
 *   1. How close am I to today's cap?          (the banner)
 *   2. What is the trend?                       (the last fourteen days)
 *   3. Which repository is expensive?           (by repo)
 *   4. Which piece of work was expensive?       (by lease, with its intent)
 *
 * The fourth is the one no other tool answers, and it is the reason spend is
 * attributed to a lease rather than to a session. "Lease 8fda cost $4.20" means
 * nothing on its own; "$4.20 — 'reduce p99 on the search endpoint after Tuesday's
 * incident'" is a sentence somebody can make a decision from.
 */

import { and, desc, eq, gte, isNotNull, sql as raw } from "drizzle-orm";
import { db } from "@core/schema/index.js";
import { claims, costEvents, repos, sessions } from "@core/schema/schema.js";
import { currentSession } from "../lib/session.js";
import { Badge, Card, Empty, SectionLabel, Stat } from "../components/ui.js";

export const dynamic = "force-dynamic";

/** Micro-USD to a string somebody can read. Never a float in the database. */
function usd(microUsd: number): string {
	if (microUsd === 0) return "$0";
	if (microUsd < 10_000) return `$${(microUsd / 1_000_000).toFixed(4)}`;
	return `$${(microUsd / 1_000_000).toFixed(2)}`;
}

export default async function UsagePage() {
	const session = await currentSession();
	if (!session) {
		return <Empty title="Not signed in." hint="Sign in to see what this deployment is spending." />;
	}
	const orgId = session.orgId;

	const { budgetStatus } = await import("../lib/cost").catch(() => ({
		budgetStatus: null as never,
	}));

	const [budget, byDay, byRepo, byLease, totals] = await Promise.all([
		budgetStatus
			? budgetStatus(orgId).catch(() => null)
			: Promise.resolve(null),
		db.execute(raw`
			select date_trunc('day', created_at at time zone 'utc')::date::text as day,
				coalesce(sum(micro_usd), 0)::bigint as micro
			from cost_events
			where org_id = ${orgId} and created_at > now() - interval '14 days'
			group by 1 order by 1
		`),
		db
			.select({
				name: raw<string>`coalesce(${repos.owner} || '/' || ${repos.name}, 'unattributed')`,
				micro: raw<string>`coalesce(sum(${costEvents.microUsd}), 0)::bigint`,
				runs: raw<number>`count(distinct ${costEvents.sessionId})::int`,
			})
			.from(costEvents)
			.leftJoin(repos, eq(costEvents.repoId, repos.id))
			.where(
				and(
					eq(costEvents.orgId, orgId),
					gte(costEvents.createdAt, new Date(Date.now() - 14 * 86_400_000)),
				),
			)
			.groupBy(raw`1`)
			.orderBy(raw`2 desc`)
			.limit(12),
		db
			.select({
				claimId: costEvents.claimId,
				intent: claims.intent,
				agentId: claims.agentId,
				micro: raw<string>`coalesce(sum(${costEvents.microUsd}), 0)::bigint`,
			})
			.from(costEvents)
			.innerJoin(claims, eq(costEvents.claimId, claims.id))
			.where(and(eq(costEvents.orgId, orgId), isNotNull(costEvents.claimId)))
			.groupBy(costEvents.claimId, claims.intent, claims.agentId)
			.orderBy(raw`4 desc`)
			.limit(15),
		db.execute(raw`
			select
				coalesce(sum(case when kind = 'tokens' then quantity else 0 end), 0)::bigint as tokens,
				coalesce(sum(case when kind = 'sandbox_spawn' then 1 else 0 end), 0)::int as spawns,
				coalesce(sum(micro_usd), 0)::bigint as micro
			from cost_events
			where org_id = ${orgId} and created_at > now() - interval '30 days'
		`),
	]);

	const days = byDay as unknown as Array<{ day: string; micro: string }>;
	const total = (totals as unknown as Array<{ tokens: string; spawns: number; micro: string }>)[0];
	const peak = Math.max(1, ...days.map((d) => Number(d.micro)));

	/**
	 * How many sessions produced a MERGED pull request — the headline metric.
	 *
	 * The filter is `merged_at is not null`, not `kind = 'pull_request'`. Counting
	 * opened pull requests under a "merged" label is the flattering version of this
	 * number and it measures the wrong thing: an agent that opens forty pull
	 * requests nobody merges is not producing value, and the whole reason to prefer
	 * this metric over sessions-run or tokens-spent is that it cannot be moved by
	 * activity alone. `merged_at` is only ever written from a verified webhook.
	 */
	const [merged] = (await db.execute(raw`
		select
			count(distinct s.id) filter (
				where a.kind = 'pull_request' and a.merged_at is not null
			)::int as with_merged_pr,
			count(distinct s.id)::int as total
		from sessions s
		left join artifacts a on a.session_id = s.id
		where s.org_id = ${orgId} and s.created_at > now() - interval '30 days'
	`)) as unknown as Array<{ with_merged_pr: number; total: number }>;

	return (
		<div className="space-y-8">
			{budget ? (
				<Card
					className={
						budget.exhausted
							? "border-destructive/40 bg-destructive/5"
							: budget.spentMicroUsd / Math.max(1, budget.capMicroUsd) > 0.8
								? "border-primary/40 bg-primary/5"
								: undefined
					}
				>
					<div className="flex items-baseline justify-between">
						<span className="text-sm text-foreground">
							{usd(budget.spentMicroUsd)} of {usd(budget.capMicroUsd)} today
						</span>
						<span className="text-xs text-muted-foreground">
							UTC day · {usd(budget.remainingMicroUsd)} remaining
						</span>
					</div>
					<div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
						<div
							className={budget.exhausted ? "h-full bg-destructive" : "h-full bg-primary"}
							style={{
								width: `${Math.min(100, (budget.spentMicroUsd / Math.max(1, budget.capMicroUsd)) * 100)}%`,
							}}
						/>
					</div>
					{budget.exhausted ? (
						<p className="mt-2 text-xs text-destructive">
							The cap is reached. New claims are refused until the UTC day rolls over.
							Work already running continues — killing a turn mid-flight would waste
							everything already spent on it.
						</p>
					) : null}
				</Card>
			) : null}

			<div className="flex gap-3">
				<Stat value={usd(Number(total?.micro ?? 0))} label="spent, last 30 days" />
				<Stat value={Number(total?.spawns ?? 0)} label="sandboxes booted" />
				<Stat
					value={Number(total?.tokens ?? 0).toLocaleString()}
					label="tokens, agent-reported"
				/>
				<Stat
					value={`${merged?.with_merged_pr ?? 0}/${merged?.total ?? 0}`}
					label="sessions with a merged PR"
				/>
			</div>

			<section>
				<SectionLabel>Last fourteen days</SectionLabel>
				{days.length === 0 ? (
					<Empty
						title="Nothing spent yet."
						hint="Every sandbox boot and every token an agent reports is recorded here, attributed to the lease it was spent under."
					/>
				) : (
					<Card>
						<div className="flex h-24 items-end gap-1">
							{days.map((day) => (
								<div className="flex flex-1 flex-col items-center gap-1" key={day.day}>
									<div
										className="w-full rounded-sm bg-primary/60"
										style={{ height: `${Math.max(2, (Number(day.micro) / peak) * 100)}%` }}
										title={`${day.day} — ${usd(Number(day.micro))}`}
									/>
									<span className="text-[10px] text-muted-foreground">
										{day.day.slice(8)}
									</span>
								</div>
							))}
						</div>
					</Card>
				)}
			</section>

			<section>
				<SectionLabel>By repository</SectionLabel>
				{byRepo.length === 0 ? (
					<Empty title="No repository-attributed spend yet." />
				) : (
					<Card className="p-0">
						<table className="w-full text-sm">
							<tbody>
								{byRepo.map((row) => (
									<tr className="border-b border-border last:border-0" key={row.name}>
										<td className="px-4 py-2 text-foreground">{row.name}</td>
										<td className="px-4 py-2 text-right text-xs text-muted-foreground">
											{row.runs} session{row.runs === 1 ? "" : "s"}
										</td>
										<td className="nums px-4 py-2 text-right text-foreground">
											{usd(Number(row.micro))}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</Card>
				)}
			</section>

			<section>
				<SectionLabel>By lease — what the money was for</SectionLabel>
				{byLease.length === 0 ? (
					<Empty
						title="No lease-attributed spend yet."
						hint="Spend is attributed to the claim it happened under, so this list answers 'what did we pay for' rather than 'what did we pay'."
					/>
				) : (
					<Card className="p-0">
						<table className="w-full text-sm">
							<tbody>
								{byLease.map((row) => (
									<tr className="border-b border-border last:border-0" key={row.claimId}>
										<td className="px-4 py-2">
											<div className="text-foreground">
												{row.intent ?? (
													<span className="text-muted-foreground">
														no intent recorded
													</span>
												)}
											</div>
											<div className="mt-0.5 text-xs text-muted-foreground">
												<Badge tone="claimed">{row.agentId}</Badge>
											</div>
										</td>
										<td className="nums px-4 py-2 text-right align-top text-foreground">
											{usd(Number(row.micro))}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</Card>
				)}
			</section>
		</div>
	);
}
