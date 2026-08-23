// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { setting } from "@core/kernel/config.js";
import { subscribe } from "@core/kernel/bus.js";
import { currentSession } from "../../lib/session.js";

/**
 * A live feed of changes for this org, over Server-Sent Events.
 *
 * SSE rather than websockets: the traffic is one-directional — the server tells
 * the browser something moved — and SSE reconnects on its own, needs no protocol
 * upgrade through whatever proxy sits in front, and is about twenty lines.
 *
 * Fan-out goes through `src/lib/bus.ts` rather than reaching for a socket service,
 * because the default backend reuses the one piece of infrastructure Harbor
 * already requires: the same DATABASE_URL that runs the product runs the live
 * layer. There is nothing extra to deploy and nothing extra to pay for, and the
 * route does not know or care which backend is behind `subscribe`.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	const session = await currentSession();
	if (!session) return new Response("Not signed in.", { status: 401 });

	const encoder = new TextEncoder();

	const stream = new ReadableStream({
		async start(controller) {
			const send = (event: string, data: unknown) => {
				try {
					controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
				} catch {
					// The client went away between the notify and the write.
				}
			};

			send("ready", { orgId: session.orgId });

			const unsubscribe = await subscribe("harbor_changes", (payload) => {
				try {
					const change = JSON.parse(payload) as { orgId?: string; verb?: string };
					// Every org shares the one channel, so the filter happens here. A
					// channel per org would mean a LISTEN per org per connection and no
					// way to clean them up.
					if (change.orgId === session.orgId) send("change", { verb: change.verb ?? "unknown" });
				} catch {
					// A malformed payload is not worth killing the stream over.
				}
			});

			// Proxies and load balancers close a silent connection. A comment line is
			// the cheapest thing that counts as traffic and is ignored by EventSource.
			const keepAlive = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(": keep-alive\n\n"));
				} catch {
					/* closed */
				}
				// The same knob the other two SSE routes use: one keep-alive cadence
				// for every stream, not an inline 25s that drifts from them.
			}, setting("sandboxHeartbeatIntervalMs"));

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
			// Nginx buffers SSE into uselessness without this.
			"x-accel-buffering": "no",
		},
	});
}
