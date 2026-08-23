// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Secrets, and the precedence rule that decides which one wins.
 *
 * Three scopes — global, repository, environment — resolved most-specific-first
 * so a staging environment can override one key without duplicating the other
 * forty. That much is unsurprising. Two decisions here are not, and both exist
 * because the obvious alternative widens what a sandbox can read without anyone
 * noticing.
 *
 * **A repository's secrets do NOT flow into an environment that contains it.**
 * An environment is its own trust scope. If member repositories' secrets were
 * inherited, then adding a repository to an environment would silently grant
 * every session in that environment access to that repository's production
 * credentials — an access change performed by what looks like a filing operation,
 * with no prompt and no audit entry that reads as a permission grant.
 *
 * **Only key NAMES ever leave the server.** The dashboard lists names, the API
 * returns names, an error message names the key that was missing. Values are
 * decrypted exactly once, at spawn, into the environment of the box that needs
 * them. There is no read endpoint, deliberately — a secret you can read back
 * through the UI is a secret that leaks through a screen-share.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@core/schema/index.js";
import { environmentRepos, secrets } from "@core/schema/schema.js";
import { decrypt, encrypt } from "./crypto.js";
import { HarborError } from "@core/kernel/work.js";

export type SecretScope = "global" | "repo" | "environment";

/** Ascending specificity. A later scope's value replaces an earlier one's. */
const PRECEDENCE: readonly SecretScope[] = ["global", "repo", "environment"];

export interface SecretTarget {
	orgId: string;
	/** The repositories this session works in, in position order. First is primary. */
	repoIds?: string[];
	environmentId?: string | null;
}

/**
 * Resolve every secret a session should see, decrypted, ready to inject.
 *
 * Returns a plain map because that is what a sandbox provider takes. The caller
 * must not log it, must not put it in an event payload, and must not return it to
 * a client; those are the three places a secret has historically escaped from and
 * the reason values never travel in a session snapshot.
 */
export async function resolveSecrets(target: SecretTarget): Promise<Record<string, string>> {
	const repoIds = target.repoIds ?? [];

	const rows = await db
		.select()
		.from(secrets)
		.where(eq(secrets.orgId, target.orgId));

	// The `: boolean` annotation is load-bearing, not style. The comment below
	// promises that a fourth scope is a compile error — but a filter callback's
	// contextual parameter type accepts an implicit `undefined` return, so
	// without the annotation the new scope's secrets would silently apply to
	// NOTHING (undefined is falsy) with the suite green. Annotated, the switch
	// missing an arm is TS2366 exactly as the comment claims.
	const applicable = rows.filter((row): boolean => {
		switch (row.scope as SecretScope) {
			case "global":
				return true;
			case "repo":
				return Boolean(row.scopeId) && repoIds.includes(row.scopeId!);
			case "environment":
				return Boolean(target.environmentId) && row.scopeId === target.environmentId;
			// No default. A scope added to the schema without a decision here is a
			// compile error rather than a secret that silently applies to everything
			// or to nothing.
		}
	});

	const resolved: Record<string, string> = {};

	for (const scope of PRECEDENCE) {
		const inScope = applicable.filter((row) => row.scope === scope);

		// Within the repository scope, an ad-hoc multi-repo session gets every
		// selected repository's secrets, and the PRIMARY repository wins a name
		// collision. Ordering by the caller's position array rather than by
		// insertion time is what makes that predictable: "the first repo you picked
		// wins" is a rule somebody can hold in their head, whereas "whichever row was
		// created first" is a rule nobody can.
		const ordered =
			scope === "repo"
				? [...inScope].sort(
						(a, b) =>
							repoIds.indexOf(b.scopeId ?? "") - repoIds.indexOf(a.scopeId ?? ""),
					)
				: inScope;

		for (const row of ordered) {
			try {
				resolved[row.name] = decrypt(row.ciphertext);
			} catch (error) {
				// One unreadable secret must not take the whole spawn with it, but it
				// also must not vanish. The name is safe to log; the value is why we
				// are here.
				throw new HarborError(
					`Secret "${row.name}" (${row.scope} scope) could not be decrypted: `
						+ `${(error as Error).message}`,
				);
			}
		}
	}

	return resolved;
}

/**
 * The names a client is allowed to see, with their scope. Never the values.
 */
export async function listSecretNames(orgId: string) {
	return db
		.select({
			id: secrets.id,
			name: secrets.name,
			scope: secrets.scope,
			scopeId: secrets.scopeId,
			createdAt: secrets.createdAt,
			updatedAt: secrets.updatedAt,
		})
		.from(secrets)
		.where(eq(secrets.orgId, orgId));
}

/**
 * Write a secret. Upsert, because the common operation is rotating a value and
 * a second row with the same name would make which one applies depend on
 * iteration order.
 */
export async function putSecret(input: {
	orgId: string;
	scope: SecretScope;
	scopeId?: string | null;
	name: string;
	value: string;
}): Promise<void> {
	const name = input.name.trim();
	// The name becomes an environment variable, so it has to be a legal one.
	// Rejecting here means a bad name fails in the UI where somebody can fix it,
	// rather than inside a booting sandbox where the error is a shell parse
	// failure with no indication of which key caused it.
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
		throw new HarborError(
			`"${input.name}" is not a valid environment variable name. Use letters, digits `
				+ "and underscores, starting with a letter or underscore.",
		);
	}
	if (input.scope !== "global" && !input.scopeId) {
		throw new HarborError(`A ${input.scope}-scoped secret needs the id of the ${input.scope}.`);
	}

	const now = new Date();
	await db
		.insert(secrets)
		.values({
			orgId: input.orgId,
			scope: input.scope,
			scopeId: input.scope === "global" ? null : input.scopeId!,
			name,
			ciphertext: encrypt(input.value),
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			// Matches the partial unique index, which coalesces a null scopeId so two
			// global secrets cannot share a name — Postgres treats NULLs as distinct.
			target: [secrets.orgId, secrets.scope, secrets.scopeId, secrets.name],
			set: { ciphertext: encrypt(input.value), updatedAt: now },
		});
}

export async function deleteSecret(orgId: string, id: string): Promise<void> {
	await db.delete(secrets).where(and(eq(secrets.orgId, orgId), eq(secrets.id, id)));
}

/**
 * Which repositories an environment contains, in position order.
 *
 * Used at session creation to snapshot the environment. Read once and stored,
 * never re-resolved — see `session_repos` in the schema for why editing an
 * environment must not mutate what an in-flight session is working on.
 */
export async function environmentRepoIds(
	orgId: string,
	environmentId: string,
): Promise<string[]> {
	const rows = await db
		.select({ repoId: environmentRepos.repoId, position: environmentRepos.position })
		.from(environmentRepos)
		.where(
			and(
				eq(environmentRepos.orgId, orgId),
				eq(environmentRepos.environmentId, environmentId),
			),
		)
		.orderBy(environmentRepos.position);
	return rows.map((row) => row.repoId);
}
