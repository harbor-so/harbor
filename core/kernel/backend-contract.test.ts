// SPDX-License-Identifier: Apache-2.0
/**
 * The contract every control-plane backend must satisfy.
 *
 * This file is to `LockBackend` and `BusBackend` what
 * `src/sandbox/providers/provider-contract.test.ts` is to `SandboxProvider`: the
 * definition of what "implements the interface" means. TypeScript can check that
 * a backend has a `withLock` method; only these tests can check that the lock is
 * actually exclusive, that a thrown body releases it, or that `subscribe`
 * resolves late enough to close the lost-event race.
 *
 * Every backend is enrolled at the bottom of each describe block. A backend that
 * is not enrolled has not been shown to work, whatever its types say.
 *
 * The properties below are stated as behaviour, never as implementation, because
 * the whole point is that a Postgres advisory lock and a single-writer actor are
 * interchangeable *here* while being nothing alike underneath.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { BusBackend, BusChannel } from "./bus.js";
import { postgresBus } from "./bus.js";
import type { LockBackend } from "./locks.js";
import { globalLock, postgresLocks, sessionLock } from "./locks.js";

/** Distinct per run so a leftover lock from a crashed run cannot mask a failure. */
function uniqueSessionId(): string {
	return `contract-${crypto.randomUUID()}`;
}

async function settle(ms = 150): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------

function lockContract(name: string, backend: LockBackend): void {
	describe(`LockBackend contract: ${name}`, () => {
		it("runs the body when the lock is free", async () => {
			const outcome = await backend.withLock(sessionLock(uniqueSessionId()), async () => 7);
			expect(outcome.acquired).toBe(true);
			expect(outcome.acquired && outcome.result).toBe(7);
		});

		/**
		 * The property the whole module exists for. Note what is NOT asserted: that
		 * the second caller waits. It must not wait — a blocked runner is a held
		 * connection, and a queue of them is an outage that presents as the product
		 * being slow rather than as a lock problem.
		 *
		 * "Does not block" is asserted as an *ordering* — the second call settles
		 * while the first is still inside its body — rather than as a wall-clock
		 * ceiling. An earlier version measured elapsed milliseconds and was flaky for
		 * a reason worth recording: the elapsed time includes `sql.reserve()` waiting
		 * for a free pool connection, which on a loaded database is seconds and has
		 * nothing to do with the lock. The ordering version cannot confuse the two,
		 * because the first body does not finish until `release()` is called.
		 */
		it("refuses a second holder while the first is inside the body, without blocking", async () => {
			const key = sessionLock(uniqueSessionId());
			let release!: () => void;
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});

			let firstSettled = false;
			const first = backend
				.withLock(key, async () => {
					await held;
					return "first";
				})
				.then((outcome) => {
					firstSettled = true;
					return outcome;
				});

			// Give the first call time to actually take the lock.
			await settle();

			const second = await backend.withLock(key, async () => "second");

			expect(second.acquired).toBe(false);
			// The refusal came back while the first holder was still inside its body,
			// which is the whole claim: it did not wait for the lock to free.
			expect(firstSettled).toBe(false);

			release();
			const firstOutcome = await first;
			expect(firstOutcome.acquired).toBe(true);
		});

		/**
		 * A thrown body must not strand the lock. Without this, one unhandled error
		 * in a session turn means that session is never driven again — and nothing
		 * anywhere reports it.
		 */
		it("releases the lock when the body throws, and propagates the error", async () => {
			const key = sessionLock(uniqueSessionId());

			await expect(
				backend.withLock(key, async () => {
					throw new Error("body failed");
				}),
			).rejects.toThrow("body failed");

			const after = await backend.withLock(key, async () => "reacquired");
			expect(after.acquired).toBe(true);
			expect(after.acquired && after.result).toBe("reacquired");
		});

		it("releases the lock after a successful body", async () => {
			const key = sessionLock(uniqueSessionId());
			expect((await backend.withLock(key, async () => 1)).acquired).toBe(true);
			expect((await backend.withLock(key, async () => 2)).acquired).toBe(true);
		});

		/**
		 * Different keys must not contend. Advisory locks are keyed by integers in
		 * one global space, so a backend that hashed carelessly would serialise
		 * unrelated sessions — which looks like "the product is slow under load" and
		 * is very hard to attribute.
		 */
		it("does not serialise unrelated keys", async () => {
			const a = sessionLock(uniqueSessionId());
			const b = sessionLock(uniqueSessionId());

			let release!: () => void;
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			const first = backend.withLock(a, async () => {
				await held;
				return "a";
			});
			await settle();

			const other = await backend.withLock(b, async () => "b");
			expect(other.acquired).toBe(true);

			release();
			await first;
		});

		/**
		 * Session keys and global keys live in separate namespaces, so a session
		 * whose id happened to collide with a global lock name must not lock out the
		 * automation sweeper.
		 */
		it("keeps session and global namespaces disjoint", async () => {
			let release!: () => void;
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			const first = backend.withLock(globalLock("harbor:devin-poll"), async () => {
				await held;
				return "global";
			});
			await settle();

			const session = await backend.withLock(sessionLock("harbor:devin-poll"), async () => "s");
			expect(session.acquired).toBe(true);

			release();
			await first;
		});

		/**
		 * Not re-entrant, deliberately. Re-entrancy would hand the lock to code that
		 * believes it is the only writer while an outer frame believes the same.
		 */
		it("refuses a nested acquisition of the same key", async () => {
			const key = sessionLock(uniqueSessionId());
			const outcome = await backend.withLock(key, async () =>
				backend.withLock(key, async () => "inner"),
			);
			expect(outcome.acquired).toBe(true);
			expect(outcome.acquired && outcome.result.acquired).toBe(false);
		});
	});
}

lockContract("postgres", postgresLocks);

// ---------------------------------------------------------------------------
// Bus
// ---------------------------------------------------------------------------

function busContract(name: string, backend: BusBackend): void {
	describe(`BusBackend contract: ${name}`, () => {
		const open: Array<() => Promise<void>> = [];

		afterEach(async () => {
			for (const close of open.splice(0)) await close().catch(() => {});
		});

		async function track(
			channel: BusChannel,
			onPayload: (payload: string) => void,
		): Promise<void> {
			open.push(await backend.subscribe(channel, onPayload));
		}

		it("delivers a published payload to a subscriber", async () => {
			const seen: string[] = [];
			await track("harbor_changes", (payload) => seen.push(payload));

			await backend.publish("harbor_changes", "hello");
			await settle(400);

			expect(seen).toContain("hello");
		});

		it("delivers to every subscriber, not just the first", async () => {
			const a: string[] = [];
			const b: string[] = [];
			await track("harbor_changes", (payload) => a.push(payload));
			await track("harbor_changes", (payload) => b.push(payload));

			await backend.publish("harbor_changes", "fanout");
			await settle(400);

			expect(a).toContain("fanout");
			expect(b).toContain("fanout");
		});

		/**
		 * Channels are separate. `harbor_chat` traffic reaching the dashboard's
		 * change stream would wake every open tab on every message in every room.
		 */
		it("does not cross channels", async () => {
			const changes: string[] = [];
			await track("harbor_changes", (payload) => changes.push(payload));

			await backend.publish("harbor_chat", "chat-only");
			await settle(400);

			expect(changes).not.toContain("chat-only");
		});

		/**
		 * THE ordering property, and the reason `subscribe` is async at all.
		 *
		 * A backend whose `subscribe` resolves before the subscription is live
		 * reintroduces the lost-event race in all four stream routes at once: an
		 * event committing between the (apparently complete) subscribe and the
		 * snapshot read is delivered to nobody and is never recovered, because the
		 * snapshot that would have contained it was read before it existed.
		 *
		 * Publishing immediately after `subscribe` resolves is the tightest window
		 * available from the outside, and a backend that fails this fails it here.
		 */
		it("is live by the time subscribe resolves", async () => {
			const seen: string[] = [];
			const unsubscribe = await backend.subscribe("harbor_changes", (p) => seen.push(p));
			open.push(unsubscribe);

			// No settle: if the subscription were not yet live, this is lost.
			await backend.publish("harbor_changes", "immediately-after-subscribe");
			await settle(400);

			expect(seen).toContain("immediately-after-subscribe");
		});

		it("stops delivering after unsubscribe", async () => {
			const seen: string[] = [];
			const unsubscribe = await backend.subscribe("harbor_changes", (p) => seen.push(p));
			await unsubscribe();

			await backend.publish("harbor_changes", "after-close");
			await settle(400);

			expect(seen).not.toContain("after-close");
		});

		it("treats unsubscribe as idempotent", async () => {
			const unsubscribe = await backend.subscribe("harbor_changes", () => {});
			await unsubscribe();
			await expect(unsubscribe()).resolves.toBeUndefined();
		});

		/**
		 * Publishing with nobody listening is a no-op, not an error. This is a
		 * notification channel, not a queue — every consumer treats a wakeup as "go
		 * read" rather than as the data, so a dropped notification costs a round trip
		 * and never costs correctness.
		 */
		it("publishes successfully with no subscribers", async () => {
			await expect(backend.publish("harbor_changes", "into-the-void")).resolves.toBeUndefined();
		});
	});
}

busContract("postgres", postgresBus);
