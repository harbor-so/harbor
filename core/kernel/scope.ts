// SPDX-License-Identifier: Apache-2.0
/**
 * What a lease is over, and who is allowed to decide whether one scope contains
 * another.
 *
 * A scope is a string of the form `<namespace>:<identifier>` — `linear:ENG-4471`,
 * `github:acme/api#src/billing/**`. The one rule this file exists to enforce:
 *
 *   **The kernel knows namespaces. It never parses the part after the colon.**
 *
 * Containment — "is this narrower scope inside that broader one?" — is the only
 * question the kernel asks, and it asks a per-namespace `ScopeResolver`, never
 * answering it itself. That is what keeps `linear` (an exact issue id) and
 * `github` (a glob over paths) from leaking their syntaxes into the lease core:
 * add a `jira` namespace tomorrow and the kernel does not change, only the
 * registry grows.
 *
 * What this file refuses to do:
 *  - Guess a namespace it does not know. An unregistered namespace is an
 *    `UnknownNamespaceError` at selection time, never a silent "not contained"
 *    that would let a lease escape a check it was supposed to fail.
 *  - Ship a resolver that half-works. There are no stubs here; a namespace is
 *    either resolvable or absent, and absence is a typed refusal.
 */

/** A malformed scope string — missing the colon, or an empty half. */
export class MalformedScopeError extends Error {
	constructor(scope: string) {
		super(
			`"${scope}" is not a scope. Scopes are "<namespace>:<identifier>", e.g. "linear:ENG-4471".`,
		);
		this.name = "MalformedScopeError";
	}
}

/** A scope whose namespace has no registered resolver. Refused, never guessed. */
export class UnknownNamespaceError extends Error {
	constructor(public readonly namespace: string) {
		super(
			`No scope resolver is registered for the "${namespace}" namespace. `
				+ `A namespace without a resolver is refused rather than assumed to contain nothing.`,
		);
		this.name = "UnknownNamespaceError";
	}
}

/**
 * The one thing a namespace must be able to answer.
 *
 * `contains` receives the two *identifiers* (the part after the colon), never the
 * full scopes — because the kernel has already matched the namespace and a
 * resolver has no business seeing, or being tempted to parse, a namespace prefix
 * that is not its own.
 */
export interface ScopeResolver {
	readonly namespace: string;
	/** True if `inner` is the same as, or wholly inside, `outer`. */
	contains(outer: string, inner: string): boolean;
}

export interface ParsedScope {
	namespace: string;
	identifier: string;
}

/**
 * Split a scope into namespace and identifier on the FIRST colon only.
 *
 * First colon, not last or all: a github identifier legitimately contains no
 * colon but a future namespace's identifier might, and the namespace is always
 * the single token before the first `:`.
 */
export function parseScope(scope: string): ParsedScope {
	const colon = scope.indexOf(":");
	if (colon <= 0 || colon === scope.length - 1) throw new MalformedScopeError(scope);
	return { namespace: scope.slice(0, colon), identifier: scope.slice(colon + 1) };
}

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

/**
 * Exact-match containment. Used by any namespace whose identifiers are opaque
 * atoms with no sub-structure to be inside of — a Linear issue id, a native
 * Harbor task UUID. `linear:ENG-4471` contains only `linear:ENG-4471`.
 */
function exactMatchResolver(namespace: string): ScopeResolver {
	return { namespace, contains: (outer, inner) => outer === inner };
}

/**
 * Turn a glob into an anchored regExp. `**` matches across `/`, `*` matches
 * within a path segment, everything else is literal. A pattern with no wildcard
 * therefore only ever equals itself, which is the containment we want.
 */
function globToRegExp(glob: string): RegExp {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i]!;
		if (c === "*") {
			if (glob[i + 1] === "*") {
				out += ".*";
				i++;
			} else {
				out += "[^/]*";
			}
		} else if (/[.+?^${}()|[\]\\]/.test(c)) {
			out += `\\${c}`;
		} else {
			out += c;
		}
	}
	return new RegExp(`^${out}$`);
}

/**
 * Path-glob containment scoped to a repository.
 *
 * Identifiers are `<owner>/<repo>#<path-or-glob>`. Two scopes in different repos
 * never contain one another; within one repo, `src/billing/**` contains
 * `src/billing/invoice.ts` and a bare path contains only itself.
 */
const githubResolver: ScopeResolver = {
	namespace: "github",
	contains(outer, inner) {
		const [outerRepo, outerPath = ""] = splitRepoPath(outer);
		const [innerRepo, innerPath = ""] = splitRepoPath(inner);
		if (outerRepo !== innerRepo) return false;
		return globToRegExp(outerPath).test(innerPath);
	},
};

function splitRepoPath(identifier: string): [string, string?] {
	const hash = identifier.indexOf("#");
	if (hash === -1) return [identifier];
	return [identifier.slice(0, hash), identifier.slice(hash + 1)];
}

/**
 * The registry. A namespace is present or it is refused — there is no fallback
 * resolver, because a fallback is exactly the silent "contains nothing" this
 * file exists to avoid.
 *
 * `harbor` and `linear` are exact-match: their identifiers are atoms. `github`
 * is glob-over-paths. To add a namespace, register a resolver here; nothing else
 * changes.
 */
const RESOLVERS: ReadonlyMap<string, ScopeResolver> = new Map(
	[exactMatchResolver("harbor"), exactMatchResolver("linear"), githubResolver].map((r) => [
		r.namespace,
		r,
	]),
);

export function resolverFor(namespace: string): ScopeResolver {
	const resolver = RESOLVERS.get(namespace);
	if (!resolver) throw new UnknownNamespaceError(namespace);
	return resolver;
}

export function knownNamespaces(): string[] {
	return [...RESOLVERS.keys()];
}

/**
 * Does `outer` contain `inner`?
 *
 * Different namespaces never contain each other. Same namespace defers entirely
 * to that namespace's resolver, which sees only the identifiers. A namespace
 * with no resolver throws rather than returning false — a scope we cannot reason
 * about must not slip through a containment check as "not contained".
 */
export function scopeContains(outer: string, inner: string): boolean {
	const o = parseScope(outer);
	const i = parseScope(inner);
	if (o.namespace !== i.namespace) return false;
	return resolverFor(o.namespace).contains(o.identifier, i.identifier);
}
