// SPDX-License-Identifier: Apache-2.0
/**
 * Containment is per-namespace, and the kernel never parses identifiers. These
 * tests pin both: that `linear` is exact, that `github` globs over paths within a
 * repo, and that an unknown namespace is refused rather than treated as empty.
 */

import { describe, expect, it } from "vitest";
import {
	MalformedScopeError,
	UnknownNamespaceError,
	knownNamespaces,
	parseScope,
	resolverFor,
	scopeContains,
} from "./scope.js";

describe("parseScope", () => {
	it("splits on the first colon only", () => {
		expect(parseScope("linear:ENG-4471")).toEqual({ namespace: "linear", identifier: "ENG-4471" });
		expect(parseScope("github:acme/api#src/a:b")).toEqual({
			namespace: "github",
			identifier: "acme/api#src/a:b",
		});
	});

	it("refuses a string with no colon or an empty half", () => {
		for (const bad of ["nocolon", ":leading", "trailing:", ""]) {
			expect(() => parseScope(bad), bad).toThrow(MalformedScopeError);
		}
	});
});

describe("linear containment", () => {
	it("is exact match, nothing else", () => {
		expect(scopeContains("linear:ENG-4471", "linear:ENG-4471")).toBe(true);
		expect(scopeContains("linear:ENG-4471", "linear:ENG-4472")).toBe(false);
		// No prefix cleverness: ENG-447 does not contain ENG-4471.
		expect(scopeContains("linear:ENG-447", "linear:ENG-4471")).toBe(false);
	});
});

describe("github containment", () => {
	it("globs paths within the same repo", () => {
		expect(scopeContains("github:acme/api#src/billing/**", "github:acme/api#src/billing/invoice.ts")).toBe(
			true,
		);
		expect(
			scopeContains("github:acme/api#src/billing/**", "github:acme/api#src/billing/tax/vat.ts"),
		).toBe(true);
		expect(scopeContains("github:acme/api#src/billing/**", "github:acme/api#src/auth/login.ts")).toBe(
			false,
		);
	});

	it("a single star does not cross a path segment", () => {
		expect(scopeContains("github:acme/api#src/*.ts", "github:acme/api#src/index.ts")).toBe(true);
		expect(scopeContains("github:acme/api#src/*.ts", "github:acme/api#src/db/index.ts")).toBe(false);
	});

	it("never contains across different repos", () => {
		expect(scopeContains("github:acme/api#**", "github:acme/web#src/index.ts")).toBe(false);
	});

	it("a wildcard-free path contains only itself", () => {
		expect(scopeContains("github:acme/api#src/a.ts", "github:acme/api#src/a.ts")).toBe(true);
		expect(scopeContains("github:acme/api#src/a.ts", "github:acme/api#src/a.ts.bak")).toBe(false);
	});
});

describe("cross-namespace and unknown", () => {
	it("different namespaces never contain each other", () => {
		expect(scopeContains("github:acme/api#**", "linear:ENG-1")).toBe(false);
	});

	it("refuses an unregistered namespace rather than returning false", () => {
		expect(() => scopeContains("jira:PROJ-1", "jira:PROJ-1")).toThrow(UnknownNamespaceError);
		expect(() => resolverFor("jira")).toThrow(UnknownNamespaceError);
	});

	it("ships harbor, linear and github", () => {
		expect(knownNamespaces().sort()).toEqual(["github", "harbor", "linear"]);
	});
});
