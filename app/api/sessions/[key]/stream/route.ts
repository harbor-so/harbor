// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { and, asc, eq, gt } from "drizzle-orm";
import { NextResponse } from "next/server";
import { setting } from "@core/kernel/config.js";
import type { SessionEvent, SessionEventType } from "../../../../contracts/index.js";
import { db } from "@core/schema/index.js";
import { sessionEvents } from "@core/schema/schema.js";
import { orgIdForKey } from "@core/kernel/auth.js";
import { subscribe } from "@core/kernel/bus.js";
import { currentSession } from "../../../../lib/session.js";
import { retainedFromSeq, snapshotSession } from "../../../../lib/session-events.js";
import { sessionByKey } from "../../../../lib/sessions.js";

/**
 * A session's live timeline: one snapshot, then every event after it.
 *
 * The shape is `src/app/api/stream/route.ts` — Postgres LISTEN/NOTIFY over SSE on
 * a dedicated connection, keep-alive comment lines, `x-accel-buffering: no` — for
 * the reasons argued there: it reuses the one piece of infrastructure Harbor
 * already requires, it survives whatever proxy an adopter runs, and it reconnects
 * on its own. What is added here is ordering, and the ordering is the entire
 * correctness argument.
 *
 * ---------------------------------------------------------------------------
 * WHY NOTHING CAN BE LOST, BY CONSTRUCTION
 * ---------------------------------------------------------------------------
 *
 * Three steps, in this order, and the order is not an optimisation:
 *
 *   1. **Subscribe** to the notify channel.
 *   2. **Read** the snapshot, which carries `snapshot_through_seq`.
 *   3. **Drain** everything above that cursor, then keep draining on every wakeup.
 *
 * The proof is two cases and no third, because `appendEvents` sends its NOTIFY
 * *after* the transaction commits (never inside — a listener woken before the rows
 * are visible reads an empty table and concludes there is nothing new):
 *
 *   - An event whose NOTIFY was delivered before step 1 had already committed
 *     before step 1, therefore before step 2, therefore it is **in the snapshot**.
 *   - An event that committed after step 2 sends its NOTIFY after its commit,
 *     which is after step 1, so **this connection receives that wakeup** and step 3
 *     reads the row.
 *
 * There is no gap between those two cases: "committed before the snapshot read"
 * and "committed after the snapshot read" partition every event that will ever
 * exist. Nothing about EVENT COVERAGE depends on how long step 2 takes or on how
 * many `await`s are in it.
 *
 * **That sentence is the whole reason this ordering was chosen over the obvious
 * alternative.** The natural design — read the snapshot, then register the
 * socket with an in-process broadcaster — is correct only while the rule "no await
 * between the snapshot read and the registration" holds. That rule is invisible in
 * the code, cannot be expressed to the type system, and is silently broken by the
 * first person who adds a permission check, a metric, or a log line between the two
 * statements. What follows is not a crash: it is one missing event, in one session,
 * for one client, under load. Subscribing first removes almost all of that
 * fragility — but not all of it, and the residue must be named rather than
 * pretended away: there is still exactly one load-bearing synchronous block, the
 * handoff between sending the baseline (snapshot or resume frame) and publishing
 * `sessionId`, which is the drain gate. An await inside THAT block lets a
 * NOTIFY-driven drain emit events past the cursors before the baseline is on the
 * wire, and a snapshot that then replaces client state discards them. The block
 * is ordered so a mistake degrades to a duplicate rather than a loss, wrapped in
 * `harbor-sync-handoff` markers, and `scripts/lint-config.mjs` fails the build on
 * an await between them — because a rule that lives only in a comment is a rule
 * the next refactor deletes.
 *
 * The notify payload deliberately carries no event data — only an org id and a
 * verb, as `notifyChange` documents — so this stream is woken and then *reads*.
 * That is what makes a wakeup that arrives twice, late, or coalesced with another
 * one harmless: the wakeup is a hint, and Postgres is the truth.
 */
export const dynamic = "force-dynamic";

function toWireEvent(row: typeof sessionEvents.$inferSelect): SessionEvent {
	return {
		id: row.id,
		session_id: row.sessionId,
		seq: row.seq,
		type: row.type as SessionEventType,
		payload: (row.payload ?? null) as Record<string, unknown> | null,
		actor: row.actor,
		created_at: row.createdAt.toISOString(),
	};
}

/**
 * The resume cursor a reconnecting client presented, or null for a fresh start.
 *
 * `?after=` wins over `Last-Event-ID` — explicit beats ambient, and a client
 * that constructs a URL is stating intent while the header is whatever the
 * browser's `EventSource` remembered. Anything malformed is NULL, never a 400:
 * the header is set automatically on reconnect, and a 400 there breaks the
 * client's own retry loop at the exact moment it is trying to recover. A
 * garbled cursor costs one full snapshot, which is the safe direction.
 */
function resumeCursorFrom(request: Request): number | null {
	const url = new URL(request.url);
	const candidates = [url.searchParams.get("after"), request.headers.get("last-event-id")];
	for (const candidate of candidates) {
		if (candidate === null || candidate === "") continue;
		if (!/^\d{1,15}$/.test(candidate)) return null;
		return Number(candidate);
	}
	return null;
}

export async function GET(request: Request, { params }: { params: Promise<{ key: string }> }) {
	const { key } = await params;

	// A presented credential is judged on its own and does NOT fall back to the
	// browser's ambient session. Falling back would mean a revoked API key keeps
	// working for as long as somebody happens to be signed in on the same browser,
	// and the revocation would appear to have worked from every angle anybody
	// checked.
	const authorization = request.headers.get("authorization");
	const orgId = authorization
		? await orgIdForKey(authorization)
		: ((await currentSession())?.orgId ?? null);
	if (!orgId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

	const encoder = new TextEncoder();
	const pageSize = setting("maxSnapshotEvents");
	const resumeCursor = resumeCursorFrom(request);

	const stream = new ReadableStream({
		async start(controller) {
			let closed = false;
			// The `id:` line is what makes reconnection cheap: EventSource stores the
			// last id it saw and presents it as `Last-Event-ID` on reconnect, so a
			// dropped connection resumes from a cursor instead of re-downloading the
			// whole snapshot. Events carry their seq; the snapshot carries its own
			// cursor, so a client that got the snapshot and nothing else still
			// resumes rather than paying for the snapshot twice.
			const send = (event: string, data: unknown, id?: number) => {
				if (closed) return;
				try {
					controller.enqueue(
						encoder.encode(
							`${id !== undefined ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
						),
					);
				} catch {
					// The client went away between the notify and the write.
				}
			};
			const finish = () => {
				if (closed) return;
				closed = true;
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			};

			/**
			 * Two cursors, and they are not the same number.
			 *
			 * `contiguousThrough` is how far the timeline is known to be *complete*, and
			 * it is where every read starts. `emittedThrough` is the highest seq already
			 * put on the wire. They differ exactly when there is a hole — seq 87 still
			 * uncommitted while 88, 89 and 90 are visible — and keeping them apart is
			 * what stops the two failures at either end of that situation:
			 *
			 *  - One cursor advanced to 90 means 87, when it finally commits, is below
			 *    the cursor and is never read again. The event is lost, silently, for
			 *    this client until it reloads the page. That is the failure this whole
			 *    file exists to prevent, reintroduced by an optimisation.
			 *  - One cursor pinned at 86 means 88-90 are re-sent on every wakeup for as
			 *    long as the hole exists.
			 *
			 * So: read from `contiguousThrough` (never miss a filled hole), emit only
			 * above `emittedThrough` or into a known gap (never spam). `pendingGaps` is
			 * recomputed from each read window, so it cannot grow without bound and
			 * cannot go stale.
			 *
			 * A hole that never fills — a transaction that allocated a seq and rolled
			 * back — pins `contiguousThrough` forever, and the cost is re-reading up to
			 * one page per wakeup. That is the direction to fail in, and it is the same
			 * one `snapshotMeta` chose for the same reason: re-reading is invisible,
			 * losing an event is not.
			 */
			let contiguousThrough = 0;
			let emittedThrough = 0;
			let pendingGaps = new Set<number>();

			/**
			 * Null until the snapshot has been read, and checked rather than assumed.
			 *
			 * The subscription is deliberately live before the snapshot is read (see the
			 * proof above), so a NOTIFY that lands during step 2 calls `drain` before
			 * the session is known. Reading a `const` declared below this point would
			 * throw a `ReferenceError` from the temporal dead zone — swallowed by the
			 * drain's own catch, so the symptom is a confusing log line today and a
			 * permanently stuck `draining` flag the moment anybody adds an `await`
			 * before the first use. Returning early is the honest behaviour: nothing is
			 * lost, because the snapshot read that follows covers everything up to its
			 * own cursor and step 3 drains the rest.
			 */
			let sessionId: string | null = null;

			let draining = false;
			let dirty = false;

			const drain = async () => {
				if (closed || sessionId === null) return;
				if (draining) {
					// A wakeup that lands mid-drain sets a flag instead of starting a
					// second one. Without it, the wakeup is dropped — and the event that
					// caused it would then wait for the *next* unrelated notify, which on
					// a session that just went quiet is forever.
					dirty = true;
					return;
				}
				draining = true;
				try {
					let more = true;
					while (more && !closed) {
						dirty = false;
						const rows = await db
							.select()
							.from(sessionEvents)
							.where(
								and(
									eq(sessionEvents.sessionId, sessionId),
									gt(sessionEvents.seq, contiguousThrough),
								),
							)
							.orderBy(asc(sessionEvents.seq))
							.limit(pageSize);

						if (rows.length > 0) {
							for (const row of rows) {
								if (row.seq > emittedThrough || pendingGaps.has(row.seq)) {
									send("event", toWireEvent(row), row.seq);
									if (row.seq > emittedThrough) emittedThrough = row.seq;
								}
							}

							let run = contiguousThrough;
							for (const row of rows) {
								if (row.seq !== run + 1) break;
								run = row.seq;
							}
							contiguousThrough = run;

							const seen = new Set(rows.map((row) => row.seq));
							const highest = rows[rows.length - 1]!.seq;
							const gaps = new Set<number>();
							for (let seq = contiguousThrough + 1; seq <= highest; seq += 1) {
								if (!seen.has(seq)) gaps.add(seq);
							}
							pendingGaps = gaps;
						}

						// A full page means there is probably more behind it; keep reading
						// rather than waiting for a wakeup that may never come, because a
						// bulk append fires one NOTIFY for hundreds of events.
						more = rows.length === pageSize || dirty;
					}
				} catch (error) {
					console.error("[session-stream] drain failed:", error);
				} finally {
					draining = false;
				}
			};

			// ---- STEP 1: subscribe, before anything is read. ----------------------
			//
			// `subscribe` resolves only once the subscription is live — that is part of
			// the bus interface, not an accident of the Postgres backend, precisely so
			// this step cannot silently stop being step 1.
			const unsubscribe = await subscribe("harbor_changes", (payload) => {
				try {
					const change = JSON.parse(payload) as { orgId?: string };
					// Every org shares the one channel, so the filter happens here. A
					// channel per org would mean a LISTEN per org per connection and no
					// way to clean them up.
					if (change.orgId === orgId) void drain();
				} catch {
					// A malformed payload is not worth killing the stream over.
				}
			});

			const cleanupAndFinish = () => {
				void unsubscribe().catch(() => {});
				finish();
			};

			// ---- STEP 2: the baseline — a resume when the cursor allows, else the
			// full snapshot. -----------------------------------------------------
			//
			// A resume is only honoured when every event above the cursor is still
			// individually retained. Compaction folds old runs into summaries and
			// deletes the originals, so a cursor below the retention boundary points
			// into a range that can never be replayed event-by-event — the honest
			// answer there is the snapshot, whose summaries carry the same content.
			let resumed = false;
			if (resumeCursor !== null) {
				const session = await sessionByKey(orgId, key);
				if (!session) {
					// Same oracle argument as the snapshot path below.
					send("error", { error: "No such session." });
					cleanupAndFinish();
					return;
				}
				const retainedFrom = await retainedFromSeq(session.id);
				if (resumeCursor >= retainedFrom - 1) {
					// The `resume` frame is the client's contract signal: no snapshot is
					// coming, keep current state, apply events idempotently.
					//
					// harbor-sync-handoff-begin: the baseline frame must be on the wire
					// before `sessionId` — the drain gate — is published. An await inside
					// this block lets a NOTIFY-driven drain emit events and advance the
					// cursors BEFORE the baseline is sent; the client then applies the
					// baseline over them and those events are gone for this connection.
					// The lint rule in scripts/lint-config.mjs fails the build on an
					// await between these markers.
					send("resume", { from_seq: resumeCursor, retained_from_seq: retainedFrom }, resumeCursor);
					contiguousThrough = resumeCursor;
					emittedThrough = resumeCursor;
					sessionId = session.id;
					// harbor-sync-handoff-end
					resumed = true;
				}
				// A cursor below the boundary falls through to the snapshot: the
				// fallback is silent and complete rather than an error the client's
				// auto-reconnect cannot act on.
			}

			if (!resumed) {
				const snapshot = await snapshotSession(orgId, key);
				if (!snapshot) {
					// Scoped by org, so a key belonging to another tenant is indistinguishable
					// from one that was never minted — a distinct "wrong org" answer would
					// turn the key space into an oracle anyone could probe.
					send("error", { error: "No such session." });
					cleanupAndFinish();
					return;
				}

				// The ordering inside this block is load-bearing, and it is the one
				// place the file's own proof does not cover. The proof shows no EVENT
				// can be missed; it says nothing about the window between publishing
				// the drain gate and sending the baseline. The old order set the
				// cursors and `sessionId` first and sent the snapshot last — so an
				// await slipped in between (a permission check, a metric) would let a
				// concurrent NOTIFY drain events onto the wire and past the cursors
				// BEFORE the snapshot, and the snapshot-replaces-state contract then
				// discards them on the client forever. Baseline first, cursors next,
				// gate LAST: now an await anywhere in between degrades to a duplicate
				// emission, which the contract defines as a no-op.
				//
				// harbor-sync-handoff-begin: no await between the baseline send and the
				// gate publication. The lint rule fails the build on one.
				send("snapshot", snapshot, snapshot.snapshot_through_seq);
				contiguousThrough = snapshot.snapshot_through_seq;
				// Deliberately the same number, not the highest seq in `snapshot.events`.
				// The snapshot's tail can reach above its own cursor when there is a hole
				// below, and those events are re-sent live. A duplicate is defined by the
				// contract to be a no-op on the client; a skipped event is not defined at
				// all, so the cheap mistake is the one to make.
				emittedThrough = snapshot.snapshot_through_seq;
				sessionId = snapshot.session.id;
				// harbor-sync-handoff-end
			}

			// ---- STEP 3: everything above the cursor, then live. -------------------
			await drain();

			// Proxies and load balancers close a silent connection. A comment line is
			// the cheapest thing that counts as traffic and is ignored by EventSource.
			const keepAlive = setInterval(() => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(": keep-alive\n\n"));
				} catch {
					/* closed */
				}
			}, setting("sandboxHeartbeatIntervalMs"));

			request.signal.addEventListener("abort", () => {
				clearInterval(keepAlive);
				cleanupAndFinish();
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
