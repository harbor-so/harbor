// SPDX-License-Identifier: Apache-2.0
/**
 * What a lease permits, and the one rule that governs handing a subset of it to
 * a child lease.
 *
 * Rights are a closed set drawn from the capabilities a background agent can
 * exercise. Today every lease is minted `{read, write}` and nothing enforces the
 * rarer ones — but the column and this narrowing rule exist now because the
 * alternative is migrating every historical lease blind once delegation ships.
 *
 * The single invariant this file exists to hold:
 *
 *   **Rights never widen.** A child lease may drop rights its parent held; it may
 *   never acquire one the parent lacked, and it may never reach outside the
 *   parent's scope. `narrow()` is the only sanctioned way to derive a child, and
 *   it refuses both violations with a typed error rather than clamping silently —
 *   a silently-clamped lease is a caller that thinks it has power it does not.
 */

import { scopeContains } from "./scope.js";

/**
 * The closed set. A discriminated union of capabilities; adding one is a
 * deliberate change every call site that decides about rights must see, not a
 * string some caller invents.
 */
export const RIGHTS = ["read", "write", "spawn", "publish", "merge", "delegate"] as const;
export type Right = (typeof RIGHTS)[number];

export function isRight(value: string): value is Right {
	return (RIGHTS as readonly string[]).includes(value);
}

/** The rights every lease is currently minted with. */
export const DEFAULT_RIGHTS: readonly Right[] = ["read", "write"];

/** A refusal to narrow — either the scope escaped the parent or a right widened. */
export class NarrowError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NarrowError";
	}
}

export interface Lease {
	scope: string;
	rights: readonly Right[];
}

export interface NarrowedLease {
	scope: string;
	rights: Right[];
}

function isSubset(child: readonly Right[], parent: readonly Right[]): boolean {
	const held = new Set(parent);
	return child.every((r) => held.has(r));
}

/**
 * Derive a child lease from a parent, or refuse.
 *
 * Fails if `subscope` is not contained in the parent's scope (per that
 * namespace's resolver) or if `subrights` is not a subset of the parent's
 * rights. On success the returned lease is exactly the requested subscope and
 * subrights — never wider than asked for, and never wider than the parent.
 */
export function narrow(
	parent: Lease,
	subscope: string,
	subrights: readonly Right[],
): NarrowedLease {
	if (!scopeContains(parent.scope, subscope)) {
		throw new NarrowError(
			`"${subscope}" is not contained in the parent lease scope "${parent.scope}". `
				+ `A child lease cannot reach outside its parent.`,
		);
	}
	if (!isSubset(subrights, parent.rights)) {
		const widened = subrights.filter((r) => !parent.rights.includes(r));
		throw new NarrowError(
			`Rights ${JSON.stringify(widened)} are not held by the parent lease `
				+ `(${JSON.stringify(parent.rights)}). Rights never widen.`,
		);
	}
	return { scope: subscope, rights: [...subrights] };
}
