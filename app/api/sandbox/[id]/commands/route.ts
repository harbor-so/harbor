// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { setting } from "@core/kernel/config.js";
import type { BridgeCommand } from "../../../../contracts/index.js";
import { db } from "@core/schema/index.js";
import { subscribe } from "@core/kernel/bus.js";
import { sandboxes, sessionPrompts, sessions } from "@core/schema/schema.js";
import { resolvePushBranch } from "../../../../git/working-branch.js";
import { isReconnectBlockedStatus } from "../../../../sandbox/decisions.js";
import { validateFence } from "../../../../sandbox/manager.js";
import {
	authenticateSandbox,
	describeFenceRefusal,
	fencingTokenFrom,
} from "../../../../lib/session-runner.js";

/**
 * The downlink: four verbs, delivered to one sandbox over Server-Sent Events.
 *
 * The asymmetry with the uplink is the point. Thousands of events go up and a
 * handful of commands come down, so a duplex channel would buy a protocol upgrade
 * — the thing proxies mangle — in exchange for traffic that fits comfortably in
 * one direction of SSE. This is the same reasoning as `src/app/api/stream/route.ts`
 * and it reuses the same mechanism: Postgres LISTEN/NOTIFY on a dedicated
 * connection, because it is infrastructure Harbor already requires.
 *
 * **Commands are derived from persisted state, never from an in-memory queue.**
 * There is no `bridge_commands` table and there deliberately is not one yet: a
 * command queue that lives in a process dies with that process, and a bridge that
 * reconnects to a different replica would silently never receive the prompt that
 * was handed to it. Instead the runner marks a prompt `delivered` in Postgres and
 * every replica derives the same command from the same row. The cost is that a
 * reconnecting bridge may be sent a prompt it already has, which is why
 * `BridgeCommand.prompt.id` exists: **the bridge deduplicates by prompt id**, and
 * a redelivered command is a no-op rather than a second turn.
 *
 * Fenced like the uplink. A superseded box must not be handed a prompt: it would
 * work on it in good faith, push a branch, and produce exactly the two-writer
 * outcome the fence exists to prevent.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;

	const auth = await authenticateSandbox(id, request.headers);
	if (!auth.ok) {
		return NextResponse.json({ error: auth.message, reason: auth.reason }, { status: 401 });
	}

	const header = fencingTokenFrom(request.headers);
	if (!header.ok) {
		return NextResponse.json({ error: header.message, reason: header.reason }, { status: 409 });
	}
	const fence = await validateFence(auth.sandbox.id, header.token);
	if (!fence.valid) {
		return NextResponse.json(
			{ error: describeFenceRefusal(fence), reason: fence.reason },
			{ status: 409 },
		);
	}

	const { orgId, sessionId } = auth.sandbox;
	const sandboxId = auth.sandbox.id;

	const encoder = new TextEncoder();

	const stream = new ReadableStream({
		async start(controller) {
			let closed = false;

			const send = (event: string, data: unknown) => {
				if (closed) return;
				try {
					controller.enqueue(
						encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
					);
				} catch {
					// The bridge went away between the notify and the write.
				}
			};

			/** Prompt ids already sent on THIS connection. Redelivery across a reconnect
			 * is expected and handled by the bridge's own dedupe; resending on the same
			 * open socket every time anything in the org changes is just noise. */
			const sent = new Set<string>();
			let shutdownSent = false;
			let pauseSent: string | null = null;

			/**
			 * Release everything this connection holds, exactly once.
			 *
			 * The keep-alive timer and the dedicated LISTEN connection are torn down
			 * HERE rather than only in the abort handler, because `finish()` is reached
			 * from inside `drain()` — a reaped box, a vanished row, a refused fence —
			 * and that path closes the response without the client necessarily ever
			 * dropping its socket. A zombie bridge is precisely a process that has
			 * stopped behaving, so waiting for it to hang up before returning a
			 * connection to Postgres means one leaked backend per stale box that
			 * reconnects, forever, until the control plane cannot open a connection at
			 * all. The pieces are captured through mutable slots because the timer is
			 * created after the first drain, and the drain can finish before it exists.
			 */
			let keepAlive: ReturnType<typeof setInterval> | null = null;
			let releaseListener: (() => void) | null = null;

			const finish = () => {
				if (closed) return;
				closed = true;
				if (keepAlive !== null) {
					clearInterval(keepAlive);
					keepAlive = null;
				}
				if (releaseListener !== null) {
					releaseListener();
					releaseListener = null;
				}
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			};

			/**
			 * Read the world and emit whatever it implies.
			 *
			 * Serialised behind `draining`/`dirty` rather than run concurrently. Two
			 * overlapping drains both read the same `delivered` prompt before either
			 * records it in `sent`, and the bridge receives the same command twice on
			 * one socket — harmless, since it dedupes, but it makes the stream's own
			 * logs a poor witness to what was actually sent.
			 */
			let draining = false;
			let dirty = false;

			const drain = async () => {
				if (closed) return;
				if (draining) {
					dirty = true;
					return;
				}
				draining = true;
				try {
					do {
						dirty = false;

						// THE FENCE IS RE-CHECKED ON EVERY DRAIN, never once at connect.
						//
						// A fence validated only at the handshake is a fence this box keeps for
						// as long as its socket stays open — and an open socket is exactly what
						// a zombie has. The concrete sequence: a slow boot outruns
						// `sandboxBootTimeoutMs`, `onConnectingTimeout` marks the row `failed`
						// and the best-effort provider stop does not land; `failed` is
						// deliberately NOT reconnect-blocking (see `isReconnectBlockedStatus`)
						// yet it IS dead for spawn admission, so a second box is created and
						// takes fence 2 while this one sits here still streaming — and is handed
						// the next prompt. Two agents on one branch, arriving through the one
						// verb that starts paid work.
						//
						// Authority fails CLOSED, so any verdict other than valid ends the
						// stream, `state_unknown` included: a privileged delivery allowed on an
						// unreadable fence is the same as having no fence at all.
						const current = await validateFence(sandboxId, header.token);
						if (!current.valid) {
							if (!shutdownSent) {
								shutdownSent = true;
								const command: BridgeCommand = { type: "shutdown", session_id: sessionId };
								send("command", command);
							}
							finish();
							return;
						}

						const [box] = await db
							.select({ status: sandboxes.status })
							.from(sandboxes)
							.where(eq(sandboxes.id, sandboxId))
							.limit(1);

						// LIFECYCLE STATE IS AUTHORITATIVE OVER TRANSPORT. A box Harbor has
						// already reaped is told to shut down even though its socket is
						// perfectly healthy — the open socket is precisely what makes a
						// zombie dangerous, so it cannot also be the thing that proves it
						// is alive. A vanished row is treated the same way: we cannot
						// establish that this box is still authorised, and authority fails
						// closed.
						if (!box || isReconnectBlockedStatus(box.status)) {
							if (!shutdownSent) {
								shutdownSent = true;
								const command: BridgeCommand = { type: "shutdown", session_id: sessionId };
								send("command", command);
							}
							finish();
							return;
						}

						const [session] = await db
							.select({ pausedReason: sessions.pausedReason })
							.from(sessions)
							.where(and(eq(sessions.id, sessionId), eq(sessions.orgId, orgId)))
							.limit(1);

						// `stop` interrupts the turn and leaves the box up, which is what a
						// budget pause wants: killing the container throws away a warm
						// workspace the moment the cap resets. `shutdown` above is the one
						// that ends the box.
						if (session?.pausedReason && pauseSent !== session.pausedReason) {
							pauseSent = session.pausedReason;
							const command: BridgeCommand = { type: "stop", session_id: sessionId };
							send("command", command);
						}
						if (!session?.pausedReason) pauseSent = null;

						const delivered = await db
							.select()
							.from(sessionPrompts)
							.where(
								and(
									eq(sessionPrompts.sessionId, sessionId),
									eq(sessionPrompts.orgId, orgId),
									eq(sessionPrompts.status, "delivered"),
								),
							)
							.orderBy(asc(sessionPrompts.deliveredAt), asc(sessionPrompts.seq))
							.limit(setting("maxQueueDepth"));

						// Resolved once per drain rather than once per prompt: it is two
						// indexed reads, and every prompt in this batch belongs to the same
						// session and therefore the same branch.
						const target = delivered.length > 0
							? await resolvePushBranch(orgId, sessionId)
							: null;

						for (const prompt of delivered) {
							if (sent.has(prompt.id)) continue;
							sent.add(prompt.id);
							// The identity mode is DECIDED HERE, explicitly, because only the
							// control plane can make the statement. A human author with an
							// email on file is `attributed-user` — the bridge sets `git config
							// user.*` and the commit is authored by the person who asked. A
							// human with no email, or an agent author, is `agent-only`: the
							// turn runs with bot-attributed commits, honestly labelled. Before
							// this field went down, every prompt carried a null email and no
							// mode, and `identityForPrompt` refused every attributed turn in
							// the product — the sandbox correctly declined to guess.
							const attributed = prompt.authorKind === "human" && prompt.authorEmail !== null;
							const command: BridgeCommand = {
								type: "prompt",
								session_id: sessionId,
								...(prompt.traceId ? { trace_id: prompt.traceId } : {}),
								prompt: {
									id: prompt.id,
									seq: prompt.seq,
									body: prompt.body,
									author: prompt.author,
									author_email: attributed ? prompt.authorEmail : null,
									mode: attributed ? "attributed-user" : "agent-only",
									// Sent per turn for the same reason `mode` is: only the control
									// plane knows the answer, and the answer changes between turns
									// of one session. Null is a statement — "nothing to push to" —
									// not an omission the sandbox should fill in.
									push_branch: target?.branch ?? null,
									base_branch: target?.base ?? null,
								},
							};
							send("command", command);
						}
					} while (dirty && !closed);
				} catch (error) {
					// A failed read is not a reason to drop the bridge's only downlink. The
					// next NOTIFY re-runs this, and the keep-alive holds the socket open in
					// the meantime.
					console.error("[commands] drain failed:", error);
				} finally {
					draining = false;
				}
			};

			// Subscribe BEFORE the first read, the same ordering the client stream
			// argues for at length: a command that becomes true between the read and
			// the subscription would otherwise wait for the next unrelated NOTIFY,
			// which on a quiet session is indefinitely.
			const unsubscribe = await subscribe("harbor_changes", (payload) => {
				try {
					const change = JSON.parse(payload) as { orgId?: string };
					if (change.orgId === orgId) void drain();
				} catch {
					// A malformed payload is not worth killing the stream over.
				}
			});
			releaseListener = () => {
				void unsubscribe().catch(() => {});
			};

			send("ready", { sandbox_id: sandboxId, session_id: sessionId, fencing_token: fence.token });
			await drain();
			// The first drain can shut the stream down — a box already reaped, a fence
			// already superseded — and `finish()` has then already released everything.
			// Registering a timer afterwards would leave one running on a closed stream
			// with nobody to clear it.
			if (closed) return;

			// Proxies and load balancers close a silent connection. The interval is the
			// bridge's own heartbeat period rather than an invented number, so the box
			// judges this socket dead on exactly the clock it already runs — and
			// `sandboxStaleHeartbeatMs`, validated at startup to be at least twice this,
			// is the threshold on both ends.
			keepAlive = setInterval(() => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(": keep-alive\n\n"));
				} catch {
					/* closed */
				}
			}, setting("sandboxHeartbeatIntervalMs"));

			// One cleanup path, so an abort after a drain-initiated close is a no-op
			// rather than a second `unlisten` on an ended connection.
			request.signal.addEventListener("abort", finish);
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
