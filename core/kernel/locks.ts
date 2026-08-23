// SPDX-License-Identifier: Apache-2.0
/**
 * Mutual exclusion, as one interface with one Postgres implementation.
 *
 * Harbor needs exactly one writer in three places — the runner driving a session,
 * the automation sweeper, the Devin poller — and until this module existed each
 * had its own copy of the same twenty lines. That is not merely duplication: the
 * reasoning below is subtle enough that one of the three was written *without*
 * it and had the connection-pool bug for a while (see the comment in
 * `tickAutomations` history). A property that has to be re-derived at each call
 * site is a property that will eventually be got wrong at one of them.
 *
 * ## Why a reserved connection and not `db.execute`
 *
 * An advisory lock taken with `pg_try_advisory_lock` belongs to the *connection*
 * that took it. Issue the lock on a pooled handle and the unlock is a separate
 * statement that may be routed to a different backend, where it does nothing at
 * all — and the lock is then held until that pooled connection is recycled, which
 * is indefinitely.
 *
 * The symptom is the worst kind. For a session: no runner will ever drive it
 * again, with no error anywhere. For automations: they run once after a deploy
 * and then silently never again, on work nobody is watching by definition. It
 * only reproduces with a pool of more than one connection, so it passes every
 * test run against a single-connection script.
 *
 * Reserving pins every statement in this function to one backend. See
 * [ADR 0006](../../docs/adr/0006-connection-scoped-advisory-locks.md).
 *
 * ## Why not the transaction-scoped variant
 *
 * `pg_advisory_xact_lock` is released by COMMIT or ROLLBACK, including the
 * rollback Postgres performs when a connection dies — strictly better crash
 * behaviour. It is not usable here because a body can boot a sandbox: the
 * transaction would sit open for minutes, holding a snapshot that blocks vacuum
 * on the busiest tables in the system, and every write the body performs would be
 * entangled in one transaction that a single failure rolls back wholesale.
 *
 * A crashed process still releases these locks — the backend dies with the socket
 * and Postgres drops its session locks — which covers the failure that actually
 * happens.
 *
 * ## Re-entrancy is deliberately not offered
 *
 * `pg_try_advisory_lock` is re-entrant within one connection, but each call here
 * reserves a *fresh* connection, so a nested call for the same key is correctly
 * refused rather than quietly granted to code that believes it is the only writer.
 *
 * ## What deliberately does NOT go through this module
 *
 * `src/lib/cost.ts` takes a per-org budget lock with `pg_advisory_xact_lock`
 * *inside* the admission transaction, under its own `HBUD` namespace. That is a
 * different mechanism on purpose and must not be unified with this one: the whole
 * point is that the lock, the spend check and the reservation insert commit or
 * roll back together, which is what makes twenty concurrent claims against a cap
 * permitting five admit exactly five. Routing it through `withLock` would take the
 * lock on a *different* connection from the transaction doing the work, and the
 * cap would stop being atomic while continuing to look correct.
 */

import { sql } from "../schema/index.js";

/**
 * A lock identity, as a closed union rather than a string.
 *
 * The two shapes are not interchangeable and must not be merged, because they
 * hash differently: a session lock uses the two-argument
 * `pg_try_advisory_lock(int, int)` form under a reserved namespace, and a global
 * lock uses the one-argument 64-bit form. Collapsing them into one representation
 * would change every existing lock's identity, and the window in which that
 * matters is a rolling deploy — where an old replica holding the old identity and
 * a new replica taking the new one are both, briefly, the only writer.
 */
export type LockKey =
	| { readonly kind: "session"; readonly sessionId: string }
	| { readonly kind: "global"; readonly name: GlobalLockName };

/**
 * The global locks that exist, enumerated.
 *
 * A free-form string would let two subsystems pick the same name by accident, and
 * the failure — one of them silently never running — is invisible.
 */
export type GlobalLockName = "harbor:automations" | "harbor:devin-poll";

/**
 * Sessions are namespaced away from any other two-int lock user.
 *
 * `0x48534553` is ASCII "HSES". Do not change it: the value IS the lock identity,
 * so a deploy that changes it has two replicas each believing they are the only
 * writer for the same session until the old one drains.
 */
export const SESSION_LOCK_NAMESPACE = 0x48534553;

export function sessionLock(sessionId: string): LockKey {
	return { kind: "session", sessionId };
}

export function globalLock(name: GlobalLockName): LockKey {
	return { kind: "global", name };
}

/**
 * The outcome of trying to take a lock.
 *
 * Not `T | null`, and `acquired: false` is emphatically not an error: "somebody
 * else is already driving this" is the expected result on every replica but one,
 * and a caller that treats it as a failure will retry, log, or alert on the
 * system working correctly.
 */
export type LockOutcome<T> = { readonly acquired: true; readonly result: T } | { readonly acquired: false };

/**
 * What a backend must implement to provide mutual exclusion. One method, because
 * a lock that can be taken without a scoped body is a lock that gets leaked.
 */
export interface LockBackend {
	withLock<T>(key: LockKey, body: () => Promise<T>): Promise<LockOutcome<T>>;
}

export const postgresLocks: LockBackend = {
	async withLock<T>(key: LockKey, body: () => Promise<T>): Promise<LockOutcome<T>> {
		const reserved = await sql.reserve();
		try {
			const [taken] =
				key.kind === "session"
					? await reserved`
							select pg_try_advisory_lock(
								${SESSION_LOCK_NAMESPACE}::int,
								hashtext(${key.sessionId})::int
							) as acquired
						`
					: await reserved`
							select pg_try_advisory_lock(hashtext(${key.name})) as acquired
						`;

			if (!taken?.acquired) return { acquired: false };

			try {
				return { acquired: true, result: await body() };
			} finally {
				// In a `finally` so a thrown body cannot strand the lock. The unlock
				// runs on the same reserved connection that took it, which is the
				// entire reason this function exists.
				if (key.kind === "session") {
					await reserved`
						select pg_advisory_unlock(
							${SESSION_LOCK_NAMESPACE}::int,
							hashtext(${key.sessionId})::int
						)
					`;
				} else {
					await reserved`select pg_advisory_unlock(hashtext(${key.name}))`;
				}
			}
		} finally {
			reserved.release();
		}
	},
};

/**
 * Run `body` as the only holder of `key`, or return without running it.
 *
 * The backend is resolved per call rather than captured at module load, so a test
 * or an alternative deployment target can swap it without every importer having
 * been written to expect that.
 */
export async function withLock<T>(key: LockKey, body: () => Promise<T>): Promise<LockOutcome<T>> {
	return backend().withLock(key, body);
}

let override: LockBackend | null = null;

/** Resolve the active backend. Postgres unless something has replaced it. */
export function backend(): LockBackend {
	return override ?? postgresLocks;
}

/**
 * Replace the lock backend. Returns a function that restores the previous one.
 *
 * Exists so an alternative control-plane backend can supply its own single-writer
 * mechanism, and so the contract suite can run the same tests against both.
 */
export function setLockBackend(next: LockBackend | null): () => void {
	const previous = override;
	override = next;
	return () => {
		override = previous;
	};
}
