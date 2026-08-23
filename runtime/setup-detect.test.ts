// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Detection is a pile of precedence rules, so it is a pure function and every
 * rule is one line here.
 *
 * The cases worth arguing about, and what this file pins down:
 *
 *  - **lockfile beats manifest**, because a lockfile is evidence of what was
 *    actually used and a manifest field is a statement of intent that may
 *    predate three migrations;
 *  - **frozen installs**, because a boot that quietly updates a lockfile has
 *    modified the repository before the agent read a line of it, and the diff
 *    turns up in somebody's pull request;
 *  - **two lockfiles refuse**, because installing the wrong one produces a
 *    dependency tree that fails much later with an error about a missing binary
 *    rather than about a lockfile.
 */

import { describe, expect, it } from "vitest";
import { dependencyFiles, describe as describeDetection, detectPackageManager } from "./setup-detect.js";

describe("detectPackageManager", () => {
	it("prefers the lockfile over package.json", () => {
		const result = detectPackageManager(["package.json", "pnpm-lock.yaml", "src"]);
		expect(result).toEqual({
			kind: "detected",
			manager: "pnpm",
			command: ["pnpm", "install", "--frozen-lockfile"],
			evidence: "pnpm-lock.yaml",
		});
	});

	it("installs frozen when there is a lockfile", () => {
		// The repository is not modified by being booted.
		expect(detectPackageManager(["yarn.lock"])).toMatchObject({
			command: ["yarn", "install", "--immutable"],
		});
		expect(detectPackageManager(["package-lock.json"])).toMatchObject({ command: ["npm", "ci"] });
		expect(detectPackageManager(["bun.lockb"])).toMatchObject({
			command: ["bun", "install", "--frozen-lockfile"],
		});
	});

	it("falls back to an unfrozen install when only a manifest is present", () => {
		// No lockfile means dependencies are unpinned. That is the repository's
		// choice; `npm ci` would simply fail, which teaches nobody anything.
		expect(detectPackageManager(["package.json"])).toEqual({
			kind: "detected",
			manager: "npm",
			command: ["npm", "install"],
			evidence: "package.json",
		});
	});

	it("handles the non-JavaScript ecosystems it claims to", () => {
		expect(detectPackageManager(["uv.lock"])).toMatchObject({ manager: "uv" });
		expect(detectPackageManager(["poetry.lock"])).toMatchObject({ manager: "poetry" });
		expect(detectPackageManager(["requirements.txt"])).toMatchObject({
			command: ["pip", "install", "-r", "requirements.txt"],
		});
		expect(detectPackageManager(["go.sum", "go.mod"])).toMatchObject({ manager: "go" });
		expect(detectPackageManager(["Cargo.lock"])).toMatchObject({ manager: "cargo" });
		expect(detectPackageManager(["Gemfile.lock"])).toMatchObject({ manager: "bundler" });
	});

	it("refuses two node lockfiles and names both", () => {
		const result = detectPackageManager(["package.json", "pnpm-lock.yaml", "package-lock.json"]);
		expect(result.kind).toBe("ambiguous");
		if (result.kind !== "ambiguous") return;
		expect(result.candidates.sort()).toEqual(["npm", "pnpm"]);
		expect(result.reason).toContain("pnpm-lock.yaml");
		expect(result.reason).toContain("package-lock.json");
		// The remedy, not just the complaint.
		expect(result.reason).toContain(".harbor/setup.sh");
	});

	it("refuses a polyglot repository rather than installing half of it", () => {
		const result = detectPackageManager(["pnpm-lock.yaml", "go.sum"]);
		expect(result.kind).toBe("ambiguous");
		if (result.kind !== "ambiguous") return;
		expect(result.reason).toContain("more than one ecosystem");
	});

	it("reports nothing recognised without calling it a failure", () => {
		// A documentation repository is not degraded.
		const result = detectPackageManager(["README.md", "docs"]);
		expect(result.kind).toBe("none");
		expect(describeDetection(result)).toBe("nothing recognised");
	});

	it("does not walk into subdirectories", () => {
		// The root tool owns the workspace: `pnpm install` at the root installs
		// every package. Walking would make a bounded decision unbounded on exactly
		// the repositories where boot time already hurts.
		expect(detectPackageManager(["packages", "README.md"]).kind).toBe("none");
	});
});

describe("dependencyFiles", () => {
	it("returns only what is present, and nothing twice", () => {
		expect(dependencyFiles(["package.json", "pnpm-lock.yaml", "src", "README.md"])).toEqual([
			"pnpm-lock.yaml",
			"package.json",
		]);
	});

	it("is empty for a repository with no dependency declaration", () => {
		expect(dependencyFiles(["README.md"])).toEqual([]);
	});
});
