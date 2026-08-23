// SPDX-License-Identifier: Apache-2.0
/**
 * Live fan-out, as one interface with one Postgres implementation.
 *
 * Four SSE routes and two writers currently reach for `postgres(url, {max: 1})`
 * and `pg_notify` directly. That works, and it is exactly the coupling that makes
 * a second control-plane backend impossible: the fan-out mechanism is not an
 * implementation detail of the routes, it is the one thing they all depend on.
 *
 * ## The ordering property is part of the interface, not the implementation
 *
 * Every consumer of this module depends on one guarantee, and it is worth stating
 * here rather than in each of the four routes:
 *
 *   **`subscribe()` must be fully registered before the caller reads its
 *   snapshot.**
 *
 * The reason is a race that no test reliably catches. A stream that reads the
 * snapshot first and subscribes second has a window between the two in which an
 * event can commit, notify, find no subscriber, and be lost — permanently, with
 * no error, and the client simply never sees that message. Subscribing first
 * inverts it: an event landing during the read arrives on the live channel, and
 * the consumer's sequence number tells it whether the snapshot already had it.
 * Duplicate delivery is idempotent; loss is not recoverable.
 *
 * So `subscribe` resolves only once the subscription is live, and a backend that
 * cannot honour that must not be added. This is the property ADR 0001 argues is
 * an *improvement* on the single-threaded-actor design rather than a substitute
 * for it, because it holds by construction instead of by a rule somebody has to
 * remember while refactoring.
 *
 * ## Convergence, not exactly-once
 *
 * This is a notification channel, not a queue. A payload can be dropped if a
 * subscriber's connection dies mid-delivery, and nothing here retries. That is
 * deliberate and it is why every consumer treats a notification as "something
 * changed, go read" rather than as the data itself — the sequence-numbered read
 * that follows is what makes the client converge.
 */

import postgres from "postgres";
import { databaseUrl, db } from "../schema/index.js";
import { sql as raw } from "drizzle-orm";

/**
 * The channels that exist, enumerated rather than free-form.
 *
 * Every org shares one channel per topic and consumers filter client-side. A
 * channel per org would mean a LISTEN per org per connection, and — more to the
 * point — no way to clean them up when an org goes quiet.
 */
export type BusChannel = "harbor_changes" | "harbor_chat";

/** Cancels a subscription. Idempotent: calling it twice is not an error. */
export type Unsubscribe = () => Promise<void>;

export interface BusBackend {
	publish(channel: BusChannel, payload: string): Promise<void>;
	/**
	 * Resolves only once the subscription is live. See the ordering property above:
	 * a backend whose `subscribe` resolves before the subscription is registered
	 * silently reintroduces the lost-event race in all four stream routes at once.
	 */
	subscribe(channel: BusChannel, onPayload: (payload: string) => void): Promise<Unsubscribe>;
}

export const postgresBus: BusBackend = {
	async publish(channel, payload) {
		await db.execute(raw`select pg_notify(${channel}, ${payload})`);
	},

	async subscribe(channel, onPayload) {
		// A dedicated connection, not a pooled one. LISTEN occupies a connection for
		// as long as it is registered, so borrowing from the pool would retire a
		// pooled connection per open stream and starve every query behind it.
		const listener = postgres(databaseUrl(), { max: 1 });
		try {
			await listener.listen(channel, onPayload);
		} catch (error) {
			// Do not leak the connection if LISTEN itself failed.
			await listener.end({ timeout: 1 }).catch(() => {});
			throw error;
		}

		let closed = false;
		return async () => {
			if (closed) return;
			closed = true;
			await listener.end({ timeout: 1 }).catch(() => {});
		};
	},
};

let override: BusBackend | null = null;

export function backend(): BusBackend {
	return override ?? postgresBus;
}

export async function publish(channel: BusChannel, payload: string): Promise<void> {
	return backend().publish(channel, payload);
}

export async function subscribe(
	channel: BusChannel,
	onPayload: (payload: string) => void,
): Promise<Unsubscribe> {
	return backend().subscribe(channel, onPayload);
}

/**
 * Replace the bus backend. Returns a function that restores the previous one.
 *
 * Exists so an alternative control-plane backend can supply its own fan-out, and
 * so the contract suite can assert the ordering property against both.
 */
export function setBusBackend(next: BusBackend | null): () => void {
	const previous = override;
	override = next;
	return () => {
		override = previous;
	};
}
