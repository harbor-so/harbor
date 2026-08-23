// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * A session room.
 *
 * Everything on this page follows from there being no owner: the participant
 * list is a flat list, every prompt is stamped with who wrote it, and the
 * composer is enabled for anybody who can see the page. If you have the link,
 * you are in the room on the same terms as whoever opened it.
 */

import { notFound } from "next/navigation";
import { relTime } from "@core/kernel/format.js";
import { currentSession } from "../../lib/session.js";
import { participantsOf, promptsOf, sessionByKey } from "../../lib/sessions.js";
import { Badge, Card, Empty, SectionLabel } from "../../components/ui.js";
import { LiveRefresh } from "../../live.js";
import { SessionComposer, ShareLink } from "./composer.js";

export const dynamic = "force-dynamic";

export default async function SessionRoom({ params }: { params: Promise<{ key: string }> }) {
	const viewer = await currentSession();
	if (!viewer) return <Empty title="Not signed in" hint="Sign in to open this session." />;

	const { key } = await params;
	const session = await sessionByKey(viewer.orgId, key);
	if (!session) notFound();

	const [people, prompts] = await Promise.all([
		participantsOf(session.id),
		promptsOf(session.id),
	]);
	const now = new Date();

	return (
		<div className="space-y-6">
			<div>
				<div className="flex items-center gap-3">
					<h1 className="text-lg font-semibold">{session.title}</h1>
					<Badge tone={session.status === "open" ? "claimed" : "neutral"}>
						{session.status}
					</Badge>
					<div className="ml-auto flex items-center gap-4">
						<LiveRefresh />
						<ShareLink sessionKey={session.key} />
					</div>
				</div>
				<p className="mt-1 text-xs text-muted-foreground">
					Opened by {session.createdBy} — who holds no special position here. Anyone with
					the link can steer.
				</p>
			</div>

			<section>
				<SectionLabel>In the room ({people.length})</SectionLabel>
				<div className="flex flex-wrap gap-2">
					{people.map((person) => (
						<span
							className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
							key={person.id}
						>
							{person.participant}
							{person.kind === "agent" ? " (agent)" : ""}
						</span>
					))}
				</div>
			</section>

			<section>
				<SectionLabel>Conversation</SectionLabel>
				{prompts.length === 0 ? (
					<Empty
						title="Nothing said yet"
						hint="Prompts queue in order. A second thought can arrive while an agent is still working on the first."
					/>
				) : (
					<div className="space-y-2">
						{prompts.map((prompt) => (
							<Card key={prompt.id}>
								<div className="flex items-baseline gap-2">
									<span className="nums text-xs text-muted-foreground">#{prompt.seq}</span>
									{/* Attribution is never derived or guessed — it is stored on the row. */}
									<span className="text-sm font-medium">{prompt.author}</span>
									{prompt.authorKind === "agent" ? (
										<Badge tone="neutral">agent</Badge>
									) : null}
									<Badge tone={prompt.status === "queued" ? "claimed" : "completed"}>
										{prompt.status}
									</Badge>
									<span className="nums ml-auto text-xs text-muted-foreground">
										{relTime(now.getTime() - prompt.createdAt.getTime())} ago
									</span>
								</div>
								<p className="mt-2 whitespace-pre-wrap text-sm">{prompt.body}</p>
							</Card>
						))}
					</div>
				)}
			</section>

			<SessionComposer sessionKey={session.key} />
		</div>
	);
}
