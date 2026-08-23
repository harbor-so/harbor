// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The rebuild-skip decision, and the one arm that must not be got backwards.
 *
 * "Could not compute the hash" must **build**. Reporting it as "unchanged" is
 * the failure that matters: the scheduler skips every rebuild for as long as the
 * outage lasts, nothing anywhere says the images are stale, and the first
 * symptom is a sandbox booting with three-week-old dependencies. It is the same
 * indeterminate-is-not-denied discipline as `RepoAccess`, pointed the other way
 * — here the safe direction is to do the work.
 */

import { describe, expect, it } from "vitest";
import { dependencyDigest, dependencyHash, shouldRebuild } from "./dependency-hash.js";

const listing = (entries: Array<{ name: string; sha: string; type?: string }>) =>
	async () =>
		new Response(
			JSON.stringify(entries.map((entry) => ({ ...entry, type: entry.type ?? "file" }))),
			{ status: 200 },
		) as never;

const ask = (fetchImpl: () => Promise<never>) =>
	dependencyHash({
		owner: "acme",
		name: "api",
		ref: "main",
		token: "ghs_installation",
		fetch: fetchImpl as never,
	});

describe("dependencyDigest", () => {
	it("is stable under listing order", () => {
		const a = dependencyDigest([
			{ path: "package.json", sha: "aaa" },
			{ path: "pnpm-lock.yaml", sha: "bbb" },
		]);
		const b = dependencyDigest([
			{ path: "pnpm-lock.yaml", sha: "bbb" },
			{ path: "package.json", sha: "aaa" },
		]);
		expect(a).toBe(b);
	});

	it("changes when any blob changes", () => {
		const before = dependencyDigest([{ path: "pnpm-lock.yaml", sha: "aaa" }]);
		const after = dependencyDigest([{ path: "pnpm-lock.yaml", sha: "aab" }]);
		expect(before).not.toBe(after);
	});

	it("cannot be collided by concatenation", () => {
		// The NUL separator is the point: without it, ("ab", "c") and ("a", "bc")
		// hash identically, and a path may legally contain almost anything.
		expect(dependencyDigest([{ path: "ab", sha: "c" }])).not.toBe(
			dependencyDigest([{ path: "a", sha: "bc" }]),
		);
	});
});

describe("dependencyHash", () => {
	it("hashes only the dependency files, ignoring everything else", async () => {
		const result = await ask(
			listing([
				{ name: "README.md", sha: "doc" },
				{ name: "pnpm-lock.yaml", sha: "lock" },
				{ name: "package.json", sha: "manifest" },
				{ name: "src", sha: "tree", type: "dir" },
			]),
		);
		expect(result.kind).toBe("hashed");
		if (result.kind !== "hashed") return;
		expect(result.files.map((file) => file.path).sort()).toEqual([
			"package.json",
			"pnpm-lock.yaml",
		]);
		expect(result.hash).toBe(
			dependencyDigest([
				{ path: "package.json", sha: "manifest" },
				{ path: "pnpm-lock.yaml", sha: "lock" },
			]),
		);
	});

	it("reports no_dependencies rather than hashing nothing", async () => {
		const result = await ask(listing([{ name: "README.md", sha: "doc" }]));
		expect(result).toEqual({ kind: "no_dependencies", hash: null });
	});

	it("refuses to hash a subset when a blob SHA is missing", async () => {
		const result = await ask(
			async () =>
				new Response(JSON.stringify([{ name: "pnpm-lock.yaml", type: "file" }]), {
					status: 200,
				}) as never,
		);
		expect(result.kind).toBe("unavailable");
		if (result.kind !== "unavailable") return;
		// A subset hash is stable across a real change, which is the same bug as
		// reporting unavailable as unchanged.
		expect(result.reason).toBe("malformed_response");
	});

	it("distinguishes the ways it can fail", async () => {
		const unauthorized = await ask(async () => new Response("{}", { status: 403 }) as never);
		expect(unauthorized).toMatchObject({ kind: "unavailable", reason: "unauthorized" });

		const missing = await ask(async () => new Response("{}", { status: 404 }) as never);
		expect(missing).toMatchObject({ kind: "unavailable", reason: "not_found" });

		const down = await ask(async () => new Response("{}", { status: 503 }) as never);
		expect(down).toMatchObject({ kind: "unavailable", reason: "upstream_unavailable" });

		const offline = await ask(async () => {
			throw new Error("ENOTFOUND");
		});
		expect(offline).toMatchObject({ kind: "unavailable", reason: "upstream_unavailable" });
	});
});

describe("shouldRebuild", () => {
	const hashed = (hash: string) => ({ kind: "hashed" as const, hash, files: [] });

	it("builds when there has never been one", () => {
		expect(shouldRebuild({ previous: null, current: hashed("h1"), currentSha: "c1" })).toEqual({
			build: true,
			reason: "no_previous_build",
		});
	});

	it("skips when nothing at all moved — the point of the whole exercise", () => {
		expect(
			shouldRebuild({
				previous: { hash: "h1", sha: "c1" },
				current: hashed("h1"),
				currentSha: "c1",
			}),
		).toEqual({ build: false, reason: "dependencies_unchanged" });
	});

	it("builds when dependencies changed", () => {
		expect(
			shouldRebuild({
				previous: { hash: "h1", sha: "c1" },
				current: hashed("h2"),
				currentSha: "c2",
			}),
		).toEqual({ build: true, reason: "dependencies_changed" });
	});

	it("builds when only the commit moved — the image bakes a checkout too", () => {
		expect(
			shouldRebuild({
				previous: { hash: "h1", sha: "c1" },
				current: hashed("h1"),
				currentSha: "c2",
			}),
		).toEqual({ build: true, reason: "commit_moved" });
	});

	it("BUILDS on an unreadable hash, never skips", () => {
		// The arm that must not be inverted. Skipping here means an outage freezes
		// every image and nothing says so.
		expect(
			shouldRebuild({
				previous: { hash: "h1", sha: "c1" },
				current: { kind: "unavailable", reason: "upstream_unavailable", detail: "down" },
				currentSha: "c1",
			}),
		).toEqual({ build: true, reason: "hash_unavailable" });
	});

	it("treats a repository that lost its dependency files as changed", () => {
		expect(
			shouldRebuild({
				previous: { hash: "h1", sha: "c1" },
				current: { kind: "no_dependencies", hash: null },
				currentSha: "c1",
			}),
		).toEqual({ build: true, reason: "dependencies_changed" });
	});
});
