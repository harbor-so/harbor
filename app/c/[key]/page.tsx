// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * A channel room.
 *
 * The room is deliberately a client island. Unlike a session (whose prompts the
 * server renders and refreshes), a chat message is authored by a key the browser
 * holds, so the composer has to sign locally before anything is sent — and once
 * the client is signing and streaming, it may as well own the message list too.
 * The server's job here is just to prove the viewer is in the org and hand the
 * room its key and title; everything live happens in `Room`.
 */

import { notFound } from "next/navigation";
import { channelByKey } from "../../lib/chat.js";
import { currentSession } from "../../lib/session.js";
import { Empty } from "../../components/ui.js";
import { Room } from "./room.js";

export const dynamic = "force-dynamic";

export default async function ChannelRoom({ params }: { params: Promise<{ key: string }> }) {
	const viewer = await currentSession();
	if (!viewer) return <Empty title="Not signed in" hint="Sign in to open this channel." />;

	const { key } = await params;
	const channel = await channelByKey(viewer.orgId, key);
	if (!channel) notFound();

	return (
		<Room
			channelKey={channel.key}
			channelId={channel.id}
			channelKind={channel.kind}
			title={channel.title}
			viewerName={viewer.userName ?? "you"}
		/>
	);
}
