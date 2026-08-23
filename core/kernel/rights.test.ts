// SPDX-License-Identifier: Apache-2.0
/**
 * The one invariant: rights never widen, and a child never reaches outside its
 * parent's scope. `narrow` is the only way to derive a child, and both failures
 * are typed refusals, not silent clamps.
 */

import { describe, expect, it } from "vitest";
import { NarrowError, narrow, type Right } from "./rights.js";

const parent = { scope: "github:acme/api#src/**", rights: ["read", "write"] as Right[] };

describe("narrow", () => {
	it("derives a child inside the parent scope with a subset of rights", () => {
		const child = narrow(parent, "github:acme/api#src/billing/invoice.ts", ["read"]);
		expect(child).toEqual({ scope: "github:acme/api#src/billing/invoice.ts", rights: ["read"] });
	});

	it("allows the same scope and the same rights", () => {
		const child = narrow(parent, "github:acme/api#src/**", ["read", "write"]);
		expect(child.rights.sort()).toEqual(["read", "write"]);
	});

	it("refuses a subscope outside the parent scope", () => {
		expect(() => narrow(parent, "github:acme/api#infra/deploy.sh", ["read"])).toThrow(NarrowError);
		// Different repo is outside too.
		expect(() => narrow(parent, "github:acme/web#src/a.ts", ["read"])).toThrow(NarrowError);
	});

	it("refuses a right the parent does not hold — rights never widen", () => {
		expect(() => narrow(parent, "github:acme/api#src/a.ts", ["read", "merge"])).toThrow(NarrowError);
		expect(() => narrow(parent, "github:acme/api#src/a.ts", ["spawn"])).toThrow(/never widen/);
	});

	it("refuses a subscope in a namespace with no resolver", () => {
		// Containment cannot be decided, so narrowing must refuse rather than assume.
		expect(() => narrow({ scope: "jira:PROJ", rights: ["read"] }, "jira:PROJ-1", ["read"])).toThrow();
	});
});
