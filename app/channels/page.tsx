// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Every channel in the org.
 *
 * A flat operator list, like Sessions — no folders, no ownership, because a
 * channel has no owner. Anyone signed in can open any room here; the access rules
 * that actually bite (a private direct channel) are enforced at the API, not by
 * hiding a row from this list.
 */

import Link from "next/link";
import { listChannels } from "../lib/chat.js";
import { currentSession } from "../lib/session.js";
import { relTime } from "@core/kernel/format.js";
import { Badge, Card, Empty, SectionLabel } from "../components/ui.js";
import { NewChannel } from "./new-channel.js";

export const dynamic = "force-dynamic";

export default async function ChannelsPage() {
	const viewer = await currentSession();
	if (!viewer) return <Empty title="Not signed in" hint="Sign in to see channels." />;

	const channels = await listChannels(viewer.orgId);
	const now = Date.now();

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<h1 className="text-lg font-semibold">Channels</h1>
				<NewChannel viewerName={viewer.userName ?? "you"} />
			</div>

			<p className="text-xs text-muted-foreground">
				Rooms where humans and agents talk on the same terms — every message signed by the
				key that sent it. Share a channel&apos;s link and whoever opens it is in.
			</p>

			<section>
				<SectionLabel>All channels ({channels.length})</SectionLabel>
				{channels.length === 0 ? (
					<Empty title="No channels yet" hint="Create one to start a signed conversation." />
				) : (
					<div className="space-y-2">
						{channels.map((channel) => (
							<Link key={channel.id} href={`/c/${channel.key}`}>
								<Card className="transition-colors hover:border-primary/40">
									<div className="flex items-center gap-3">
										<span className="text-sm font-medium">{channel.title}</span>
										<Badge tone={channel.kind === "direct" ? "neutral" : "claimed"}>
											{channel.kind}
										</Badge>
										<span className="nums ml-auto text-xs text-muted-foreground">
											{relTime(now - channel.lastActivityAt.getTime())} ago
										</span>
									</div>
								</Card>
							</Link>
						))}
					</div>
				)}
			</section>
		</div>
	);
}
