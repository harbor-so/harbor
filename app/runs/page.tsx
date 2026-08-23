// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { desc, eq } from "drizzle-orm";
import { db } from "@core/schema/index.js";
import { runs } from "@core/schema/schema.js";
import { relTime } from "@core/kernel/format.js";
import { runnerEnabled } from "../lib/runner.js";
import { currentSession } from "../lib/session.js";
import { Badge, Card, Empty, SectionLabel, type Tone } from "../components/ui.js";
import { LaunchPanel } from "./launch.js";
import { LiveRefresh } from "../live.js";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, Tone> = {
	starting: "claimed",
	running: "claimed",
	completed: "completed",
	failed: "conflict",
};

export default async function RunsPage() {
	const session = await currentSession();
	if (!session) return <Empty title="No organisation yet" hint="Run npm run db:seed." />;

	const rows = await db
		.select()
		.from(runs)
		.where(eq(runs.orgId, session.orgId))
		.orderBy(desc(runs.startedAt))
		.limit(20);

	const now = new Date();

	return (
		<div className="space-y-8">
			<div className="flex items-center justify-between">
				<SectionLabel>Launch an agent</SectionLabel>
				<LiveRefresh />
			</div>

			<LaunchPanel enabled={runnerEnabled()} />

			<section>
				<SectionLabel>Runs</SectionLabel>
				{rows.length === 0 ? (
					<Empty
						title="Nothing launched yet"
						hint="A launched agent connects back through Harbor's own MCP endpoint, so it claims and releases like any other."
					/>
				) : (
					<div className="space-y-3">
						{rows.map((run) => (
							<Card key={run.id}>
								<div className="flex items-center gap-3">
									<Badge tone={STATUS_TONE[run.status] ?? "neutral"}>{run.status}</Badge>
									<span className="text-sm font-medium">{run.agentId}</span>
									<span className="text-xs text-muted-foreground">{run.runtime}</span>
									<span className="nums ml-auto text-xs text-muted-foreground">
										{relTime(now.getTime() - run.startedAt.getTime())} ago
									</span>
								</div>
								<p className="mt-2 text-xs text-muted-foreground">{run.prompt}</p>
								{run.output ? (
									<pre className="mt-3 max-h-64 overflow-auto rounded bg-muted/40 p-3 text-xs leading-relaxed">
										{run.output.slice(-4000)}
									</pre>
								) : null}
							</Card>
						))}
					</div>
				)}
			</section>
		</div>
	);
}
