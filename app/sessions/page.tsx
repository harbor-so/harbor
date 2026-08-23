// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import Link from "next/link";
import { relTime } from "@core/kernel/format.js";
import { currentSession } from "../lib/session.js";
import { listSessions } from "../lib/sessions.js";
import { Badge, Card, Empty, SectionLabel } from "../components/ui.js";
import { NewSessionButton } from "./new-session.js";
import { LiveRefresh } from "../live.js";

export const dynamic = "force-dynamic";

export default async function SessionsPage() {
	const viewer = await currentSession();
	if (!viewer) return <Empty title="No organisation yet" hint="Run npm run db:seed." />;

	const rows = await listSessions(viewer.orgId);
	const now = new Date();

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<SectionLabel>Sessions</SectionLabel>
				<div className="flex items-center gap-4">
					<LiveRefresh />
					<NewSessionButton />
				</div>
			</div>

			{rows.length === 0 ? (
				<Empty
					title="No sessions yet"
					hint="A session is a room with work in it. Anyone with the link can join and steer — there is no owner."
				/>
			) : (
				<div className="space-y-2">
					{rows.map((session) => (
						<Link
							className="block rounded-lg border border-border bg-card p-4 hover:border-primary/40"
							href={`/s/${session.key}`}
							key={session.id}
						>
							<div className="flex items-center gap-3">
								<span className="text-sm font-medium">{session.title}</span>
								<Badge tone={session.status === "open" ? "claimed" : "neutral"}>
									{session.status}
								</Badge>
								<span className="nums ml-auto text-xs text-muted-foreground">
									{relTime(now.getTime() - session.lastActivityAt.getTime())} ago
								</span>
							</div>
							<div className="mt-1 text-xs text-muted-foreground">
								opened by {session.createdBy}
								{session.taskTitle ? ` · ${session.taskTitle}` : ""}
							</div>
						</Link>
					))}
				</div>
			)}
		</div>
	);
}
