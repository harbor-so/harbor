// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { channelByKey, mayRead } from "../../../../lib/chat.js";
import { resolveConn } from "../../../../lib/conn.js";
import { subscribe } from "@core/kernel/bus.js";

/**
 * A live feed for one channel, over Server-Sent Events.
 *
 * The same shape as the dashboard's /api/stream — SSE over Postgres LISTEN/NOTIFY,
 * no new infrastructure — but on the `harbor_chat` channel and filtered to a
 * single room.
 *
 * The access check happens BEFORE the LISTEN, and that ordering is the point. A
 * stream that subscribes first and filters later has already attached the caller
 * to the fan-out before deciding whether they were allowed — so the window
 * between the two is a private-room leak, and it is a window that widens every
 * time someone adds an `await` to the check. Here a non-member of a direct
 * channel is refused with a 403 and never reaches the LISTEN at all.
 *
 * Durable events are announced by `{seq}` only; the client fetches the body from
 * the events endpoint. Ephemeral events (typing/presence) carry their small actor
 * inline, because there is no row to fetch.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ key: string }> }) {
	const conn = await resolveConn(request);
	if (!conn) return new Response("Not authenticated.", { status: 401 });

	const { key } = await params;
	const channel = await channelByKey(conn.orgId, key);
	if (!channel) return new Response("No such channel.", { status: 404 });

	const as = new URL(request.url).searchParams.get("as") ?? undefined;
	if (!(await mayRead(channel, as))) return new Response("Not a member.", { status: 403 });

	const encoder = new TextEncoder();

	const stream = new ReadableStream({
		async start(controller) {
			const send = (event: string, data: unknown) => {
				try {
					controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
				} catch {
					// Client went away between the notify and the write.
				}
			};

			send("ready", { channelId: channel.id });

			const unsubscribe = await subscribe("harbor_chat", (payload) => {
				try {
					const change = JSON.parse(payload) as {
						orgId?: string;
						channelId?: string;
						kind?: string;
						seq?: number;
						actor?: { pubkey: string; displayName: string };
					};
					// One shared NOTIFY channel for all chat, so the room filter is here.
					if (change.orgId === conn.orgId && change.channelId === channel.id) {
						send("event", { kind: change.kind, seq: change.seq, actor: change.actor });
					}
				} catch {
					// A malformed payload is not worth killing the stream over.
				}
			});

			const keepAlive = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(": keep-alive\n\n"));
				} catch {
					/* closed */
				}
			}, 25_000);

			request.signal.addEventListener("abort", () => {
				clearInterval(keepAlive);
				void unsubscribe().catch(() => {});
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			});
		},
	});

	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
			"x-accel-buffering": "no",
		},
	});
}
