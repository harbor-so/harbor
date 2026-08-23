// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Whether rebuilding a repository's image would produce anything different.
 *
 * A prebuilt-image pipeline that rebuilds on a timer does the same work whether
 * or not anything changed, and the same work is not free: it is a container, an
 * install, and a registry push per repository per interval. Rebuilding every
 * thirty minutes unconditionally is affordable for one team with a handful of
 * repositories and is not affordable for a deployment with two hundred, where the
 * bill scales with repository count rather than with how much anything changed.
 *
 * The observation this exploits: an image is interesting only because of what
 * `setup.sh` (or auto-detection) installed into it, and what gets installed is a
 * function of the dependency files. If `pnpm-lock.yaml` has the same content it
 * had at the last build, a rebuild produces the same image with a different
 * timestamp.
 *
 * ## Two things this is careful about
 *
 * **The hash is over blob SHAs, not file contents.** GitHub's contents API
 * already returns a git blob SHA per entry, which is a hash of the content, so
 * the whole answer comes from one listing rather than N downloads. A monorepo
 * with a nine-megabyte lockfile costs the same as an empty repository.
 *
 * **Unavailable is not unchanged.** This is the failure that would matter: an
 * unreachable host reported as "hash is the same" means the scheduler skips
 * every rebuild for as long as the outage lasts, and nothing anywhere says the
 * images are stale. So the outcome is a three-arm union and the *caller* is
 * forced to decide — the same discipline as `RepoAccess`, `PrAuthority` and
 * every other question in this codebase that can be answered "I do not know".
 */

import { createHash } from "node:crypto";
import { dependencyFiles } from "../../runtime/setup-detect.js";
import { scmSetting } from "../git/provider.js";

export type FetchLike = typeof fetch;

export interface DependencyFile {
	path: string;
	/** The git blob SHA. Content-addressed, so equal SHAs mean equal bytes. */
	sha: string;
}

export type DependencyHash =
	| { kind: "hashed"; hash: string; files: DependencyFile[] }
	/** No lockfile or manifest at the root. A rebuild would install nothing. */
	| { kind: "no_dependencies"; hash: null }
	| {
			kind: "unavailable";
			reason: "upstream_unavailable" | "unauthorized" | "not_found" | "malformed_response";
			detail: string;
	  };

/**
 * The digest itself, pure so it can be reasoned about without a network.
 *
 * Sorted by path, then `path\0sha\n` per line. The NUL is what stops the
 * pathological collision where two different (path, sha) pairs concatenate to
 * the same string — a path may contain almost anything, and a separator that can
 * appear inside a path is not a separator.
 */
export function dependencyDigest(files: readonly DependencyFile[]): string {
	const hash = createHash("sha256");
	for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
		hash.update(`${file.path}\0${file.sha}\n`);
	}
	return hash.digest("hex");
}

interface ContentsEntry {
	name?: unknown;
	type?: unknown;
	sha?: unknown;
}

/**
 * Read the repository root at `ref` and hash whatever dependency files are there.
 *
 * `token` is an installation token, not a user token: this is Harbor asking
 * about a repository it already has permission to build, not a question about
 * what a particular person may see. The multi-tenancy check happened at connect
 * time and again at session creation.
 */
export async function dependencyHash(input: {
	apiBase?: string;
	owner: string;
	name: string;
	ref: string;
	token: string;
	fetch?: FetchLike;
}): Promise<DependencyHash> {
	const doFetch = input.fetch ?? fetch;
	const base = input.apiBase ?? "https://api.github.com";
	const url =
		`${base}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.name)}`
		+ `/contents/?ref=${encodeURIComponent(input.ref)}`;

	let response: Response;
	try {
		response = await doFetch(url, {
			headers: {
				accept: "application/vnd.github+json",
				"x-github-api-version": "2022-11-28",
				"user-agent": "harbor",
				authorization: `token ${input.token}`,
			},
			signal: AbortSignal.timeout(scmSetting("scmRequestTimeoutMs")),
		});
	} catch (error) {
		return {
			kind: "unavailable",
			reason: "upstream_unavailable",
			detail: (error as Error).message,
		};
	}

	if (response.status === 401 || response.status === 403) {
		return {
			kind: "unavailable",
			reason: "unauthorized",
			detail: `GitHub returned ${response.status} listing ${input.owner}/${input.name}.`,
		};
	}
	if (response.status === 404) {
		return {
			kind: "unavailable",
			reason: "not_found",
			detail: `${input.owner}/${input.name}@${input.ref} was not found.`,
		};
	}
	if (!response.ok) {
		return {
			kind: "unavailable",
			reason: "upstream_unavailable",
			detail: `GitHub returned ${response.status}.`,
		};
	}

	let body: unknown;
	try {
		body = await response.json();
	} catch (error) {
		return { kind: "unavailable", reason: "malformed_response", detail: (error as Error).message };
	}
	if (!Array.isArray(body)) {
		// A single-file response means the path resolved to a file rather than the
		// root directory, which cannot happen for `contents/` — so this is a shape
		// we do not understand, not an empty repository.
		return {
			kind: "unavailable",
			reason: "malformed_response",
			detail: "Expected a directory listing at the repository root.",
		};
	}

	const entries = body as ContentsEntry[];
	const names = entries
		.filter((entry) => entry.type === "file" && typeof entry.name === "string")
		.map((entry) => entry.name as string);

	// The list of what counts comes from `setup-detect`, so a package manager
	// added there is hashed here without anybody remembering to update a second
	// list. A separate list would not break visibly — it would just quietly stop
	// noticing changes to the new ecosystem's lockfile.
	const wanted = new Set(dependencyFiles(names));
	if (wanted.size === 0) return { kind: "no_dependencies", hash: null };

	const files: DependencyFile[] = [];
	for (const entry of entries) {
		if (typeof entry.name !== "string" || !wanted.has(entry.name)) continue;
		if (typeof entry.sha !== "string") {
			// A dependency file whose SHA we could not read makes the digest a lie:
			// it would be stable across a real change. Refuse rather than hash a
			// subset — a subset hash is the "unavailable reported as unchanged" bug
			// wearing a different hat.
			return {
				kind: "unavailable",
				reason: "malformed_response",
				detail: `The listing for ${entry.name} carried no blob SHA.`,
			};
		}
		files.push({ path: entry.name, sha: entry.sha });
	}

	return { kind: "hashed", hash: dependencyDigest(files), files };
}

/**
 * Should a due build actually run?
 *
 * Pure, and the reason it is its own function rather than an `if` at the call
 * site is that all three arms are load-bearing and two of them are easy to get
 * backwards:
 *
 *  - a hash we could not compute must **build**, never skip. Skipping on an
 *    unreadable answer means an outage silently freezes every image;
 *  - a repository with no dependency files must still build when the commit
 *    moved, because the image contains a checkout as well as `node_modules`.
 */
export type RebuildDecision =
	| { build: true; reason: "no_previous_build" | "dependencies_changed" | "commit_moved" | "hash_unavailable" }
	| { build: false; reason: "dependencies_unchanged" };

export function shouldRebuild(input: {
	previous: { hash: string | null; sha: string | null } | null;
	current: DependencyHash;
	currentSha: string;
}): RebuildDecision {
	if (!input.previous) return { build: true, reason: "no_previous_build" };
	if (input.current.kind === "unavailable") return { build: true, reason: "hash_unavailable" };

	const currentHash = input.current.kind === "hashed" ? input.current.hash : null;
	if (currentHash !== input.previous.hash) return { build: true, reason: "dependencies_changed" };

	// Dependencies are identical. The image still bakes a checkout, so a moved
	// commit is a real difference — it is just a much cheaper one, because the
	// dependency layer is reused.
	if (input.currentSha !== input.previous.sha) return { build: true, reason: "commit_moved" };

	return { build: false, reason: "dependencies_unchanged" };
}
