// SPDX-License-Identifier: Apache-2.0
/**
 * `describeDatabaseTls` — pure string in, struct out, no database.
 *
 * The case that matters most is `sslmode=require`, because it is the string every
 * hosted-Postgres quickstart prints and the one that sounds safe and is not. If
 * that assertion ever starts failing because somebody "fixed" the classification,
 * read the postgres.js source before changing the test: `require`, `allow` and
 * `prefer` all set `rejectUnauthorized = false`.
 */

import { describe, expect, it } from "vitest";
import { describeDatabaseTls } from "./tls.js";

const local = "postgres://harbor:harbor@localhost:5433/harbor";
const hosted = "postgres://u:p@db.example.neon.tech/harbor";

describe("describeDatabaseTls — verification, not just encryption", () => {
	it("treats sslmode=require as encrypted but UNVERIFIED, and warns", () => {
		const report = describeDatabaseTls(`${hosted}?sslmode=require`);
		expect(report.mode).toBe("require");
		expect(report.encrypted).toBe(true);
		expect(report.verified).toBe(false);
		expect(report.warnings.join(" ")).toMatch(/does NOT\s+verify/i);
	});

	it("treats sslmode=verify-full as verified, and says nothing", () => {
		const report = describeDatabaseTls(`${hosted}?sslmode=verify-full`);
		expect(report.verified).toBe(true);
		expect(report.warnings).toEqual([]);
	});

	it("accepts sslrootcert=system as an alias for full verification", () => {
		const report = describeDatabaseTls(`${hosted}?sslrootcert=system`);
		expect(report.mode).toBe("verify-full");
		expect(report.verified).toBe(true);
		expect(report.warnings).toEqual([]);
	});

	it("warns loudly when a remote DSN names no sslmode at all", () => {
		const report = describeDatabaseTls(hosted);
		expect(report.encrypted).toBe(false);
		expect(report.warnings.join(" ")).toMatch(/PLAINTEXT/);
	});

	it("says nothing about a loopback DSN, where plaintext is fine", () => {
		const report = describeDatabaseTls(local);
		expect(report.loopback).toBe(true);
		expect(report.warnings).toEqual([]);
	});

	it("classifies allow and prefer as unverified too, not just require", () => {
		for (const mode of ["allow", "prefer"]) {
			expect(describeDatabaseTls(`${hosted}?sslmode=${mode}`).verified).toBe(false);
		}
	});
});

describe("describeDatabaseTls — the transaction-pooler trap", () => {
	it("flags port 6543", () => {
		const report = describeDatabaseTls(`postgres://u:p@db.example.com:6543/harbor?sslmode=verify-full`);
		expect(report.warnings.join(" ")).toMatch(/TRANSACTION pooler/);
	});

	it("flags a Supabase pooler hostname", () => {
		const report = describeDatabaseTls(
			"postgres://u:p@aws-0-eu-west-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
		);
		expect(report.warnings.join(" ")).toMatch(/TRANSACTION pooler/);
	});

	it("flags pgbouncer=true", () => {
		const report = describeDatabaseTls(`${hosted}?sslmode=verify-full&pgbouncer=true`);
		expect(report.warnings.join(" ")).toMatch(/TRANSACTION pooler/);
	});

	it("does not flag an ordinary direct connection on 5432", () => {
		expect(describeDatabaseTls(`${hosted}:5432/harbor?sslmode=verify-full`).warnings).toEqual([]);
	});
});

describe("describeDatabaseTls — malformed input", () => {
	it("reports rather than throws on an unparseable DSN", () => {
		const report = describeDatabaseTls("not a url");
		expect(report.mode).toBe("unknown");
		expect(report.warnings).toHaveLength(1);
	});
});
