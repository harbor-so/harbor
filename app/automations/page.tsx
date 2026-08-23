// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Automations — work that happens while nobody is watching.
 *
 * The design job of this page is to make a paused automation impossible to miss.
 * An automation that has switched itself off after three failures is the single
 * most likely thing to be silently wrong in a deployment: it stopped doing its
 * job, nobody was watching by definition, and the only signal is a row that looks
 * slightly different from its neighbours. So paused rows are pulled to the top,
 * carry the last error verbatim, and have the one button that fixes them.
 *
 * The second job is to show the last few runs inline rather than behind a click.
 * "Did the nightly job work" is the question, and a page that answers it in one
 * glance is a page people check; one that needs a click per automation is a page
 * people stop opening.
 */

import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@core/schema/index.js";
import { automationRuns, automations, environments, repos } from "@core/schema/schema.js";
import { currentSession } from "../lib/session.js";
import { AGENT_RUNTIMES } from "../contracts/agent.js";
import { nextRun } from "../triggers/cron.js";
import { Badge, Card, Empty, SectionLabel } from "../components/ui.js";
import { ResumeButton, RunNowButton } from "./buttons.js";
import { CreateForm } from "./create-form.js";

export const dynamic = "force-dynamic";

function describeSource(automation: typeof automations.$inferSelect): string {
	const spec = (automation.spec as Record<string, unknown> | null) ?? {};
	if (automation.source === "cron") {
		const expression = typeof spec.expression === "string" ? spec.expression : "?";
		const timezone = typeof spec.timezone === "string" ? spec.timezone : "UTC";
		return `${expression} · ${timezone}`;
	}
	const conditions = Array.isArray(spec.conditions) ? spec.conditions.length : 0;
	return conditions > 0
		? `${automation.source} · ${conditions} condition${conditions === 1 ? "" : "s"}`
		: `${automation.source} · unfiltered`;
}

function nextRunLabel(automation: typeof automations.$inferSelect): string {
	if (automation.pausedReason) return "paused";
	if (automation.source !== "cron") return "on event";
	const spec = (automation.spec as { expression?: string; timezone?: string } | null) ?? {};
	if (!spec.expression) return "no schedule";
	try {
		const next = nextRun(spec.expression, new Date(), spec.timezone ?? "UTC");
		// A schedule that is valid but can never fire — the 30th of February — is
		// worth saying outright. It presents otherwise as an automation that simply
		// never runs, which reads as a Harbor bug rather than as a typo.
		return next ? next.toISOString().replace("T", " ").slice(0, 16) : "never fires";
	} catch (error) {
		return `invalid: ${(error as Error).message.slice(0, 60)}`;
	}
}

export default async function AutomationsPage() {
	const session = await currentSession();
	if (!session) return <Empty title="Not signed in." />;

	const [rows, repoRows, envRows] = await Promise.all([
		db
			.select()
			.from(automations)
			.where(eq(automations.orgId, session.orgId))
			.orderBy(automations.name),
		db.select().from(repos).where(eq(repos.orgId, session.orgId)),
		db.select().from(environments).where(eq(environments.orgId, session.orgId)),
	]);

	// Targets and runtimes for the create form, built regardless of whether any
	// automations exist yet — the form is the only way to create the first one, so
	// it cannot live behind the "you have automations" branch.
	const targets = [
		...repoRows.map((repo) => ({
			id: repo.id,
			kind: "repo" as const,
			label: `${repo.owner}/${repo.name}`,
		})),
		...envRows.map((environment) => ({
			id: environment.id,
			kind: "environment" as const,
			label: environment.name,
		})),
	];
	const createForm = <CreateForm targets={targets} runtimes={[...AGENT_RUNTIMES]} />;

	if (rows.length === 0) {
		return (
			<div className="space-y-6">
				<SectionLabel>Automations</SectionLabel>
				{createForm}
				<Empty
					title="No automations yet."
					hint="An automation starts a session on a schedule or on an event — triage new Sentry errors, sweep dependency updates on Monday morning, review every pull request that touches src/api."
				/>
			</div>
		);
	}

	const runs = await db
		.select()
		.from(automationRuns)
		.where(
			inArray(
				automationRuns.automationId,
				rows.map((row) => row.id),
			),
		)
		.orderBy(desc(automationRuns.startedAt))
		.limit(rows.length * 6);

	const targetName = (automation: typeof automations.$inferSelect): string => {
		if (automation.targetKind === "repo") {
			const repo = repoRows.find((row) => row.id === automation.targetId);
			return repo ? `${repo.owner}/${repo.name}` : "deleted repository";
		}
		const environment = envRows.find((row) => row.id === automation.targetId);
		return environment ? environment.name : "deleted environment";
	};

	// Paused first, then by name. See the header: a paused automation is the thing
	// most likely to be silently wrong, and sorting it into alphabetical order with
	// everything else is how it stays unnoticed for a month.
	const ordered = [...rows].sort((a, b) => {
		if (Boolean(a.pausedReason) !== Boolean(b.pausedReason)) return a.pausedReason ? -1 : 1;
		return a.name.localeCompare(b.name);
	});

	return (
		<div className="space-y-6">
			<SectionLabel>Automations</SectionLabel>
			{createForm}

			{ordered.map((automation) => {
				const mine = runs.filter((run) => run.automationId === automation.id).slice(0, 6);
				return (
					<Card
						className={automation.pausedReason ? "border-destructive/40 bg-destructive/5" : undefined}
						key={automation.id}
					>
						<div className="flex items-start justify-between gap-4">
							<div className="min-w-0">
								<div className="flex items-center gap-2">
									<span className="font-medium text-foreground">{automation.name}</span>
									{automation.pausedReason ? (
										<Badge tone="expired">paused</Badge>
									) : automation.enabled ? (
										<Badge tone="claimed">enabled</Badge>
									) : (
										<Badge tone="neutral">disabled</Badge>
									)}
								</div>
								<div className="mt-1 text-xs text-muted-foreground">
									{describeSource(automation)} → {targetName(automation)}
								</div>
								{automation.source !== "cron" ? (
									<div className="mt-1 font-mono text-xs text-muted-foreground/80">
										POST /api/triggers/{automation.source}/{automation.id}
									</div>
								) : null}
								<p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
									{automation.prompt}
								</p>
							</div>

							<div className="shrink-0 text-right">
								<div className="nums text-xs text-muted-foreground">
									{nextRunLabel(automation)}
								</div>
								<div className="mt-2 flex justify-end gap-2">
									<RunNowButton automationId={automation.id} />
									{automation.pausedReason ? (
										<ResumeButton automationId={automation.id} />
									) : null}
								</div>
							</div>
						</div>

						{automation.pausedReason ? (
							<p className="mt-3 rounded border border-destructive/30 bg-background/60 px-3 py-2 text-xs text-destructive">
								{automation.pausedReason}
							</p>
						) : null}

						{mine.length > 0 ? (
							<div className="mt-3 flex flex-wrap gap-1.5 border-t border-border pt-3">
								{mine.map((run) => (
									<span
										className="text-xs text-muted-foreground"
										key={run.id}
										title={run.error ?? run.status}
									>
										<Badge
											tone={
												run.status === "succeeded"
													? "completed"
													: run.status === "failed"
														? "conflict"
														: "claimed"
											}
										>
											{run.startedAt.toISOString().slice(5, 16).replace("T", " ")}
										</Badge>
									</span>
								))}
							</div>
						) : null}
					</Card>
				);
			})}
		</div>
	);
}
