// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Cron and condition tests. Pure modules, so zero mocks and exact boundaries.
 *
 * The cron suite is longer than a cron parser usually deserves, and the reason is
 * in the module header: this code decides when money is spent with no human
 * present. An off-by-one that turns an hourly automation into a per-minute one is
 * sixty sandboxes an hour, billed, until somebody notices.
 */

import { describe, expect, it } from "vitest";
import { CronError, matches, nextRun, parseCron } from "./cron.js";
import { evaluate, evaluateAll, globToRegExp, parseConditions } from "./conditions.js";

const at = (iso: string) => new Date(iso);

describe("cron parsing", () => {
	it("parses the shorthands people actually type", () => {
		expect([...parseCron("@hourly").minute]).toEqual([0]);
		expect([...parseCron("@daily").hour]).toEqual([0]);
		expect([...parseCron("@weekly").dayOfWeek]).toEqual([0]);
		expect([...parseCron("@monthly").dayOfMonth]).toEqual([1]);
	});

	it("parses lists, ranges and steps", () => {
		expect([...parseCron("0,30 * * * *").minute]).toEqual([0, 30]);
		expect([...parseCron("0 9-17 * * *").hour]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
		expect([...parseCron("*/15 * * * *").minute]).toEqual([0, 15, 30, 45]);
		expect([...parseCron("0 0-23/6 * * *").hour]).toEqual([0, 6, 12, 18]);
	});

	it("accepts month and day names", () => {
		expect([...parseCron("0 0 1 jan *").month]).toEqual([1]);
		expect([...parseCron("0 0 * * mon").dayOfWeek]).toEqual([1]);
	});

	/**
	 * Both 0 and 7 mean Sunday in every cron anyone has used. Rejecting 7 because
	 * the field table says 0-6 would be defensible and would break expressions
	 * people copy straight out of their existing crontab.
	 */
	it("accepts 7 as Sunday", () => {
		expect([...parseCron("0 0 * * 7").dayOfWeek]).toEqual([0]);
	});

	/**
	 * The specific failure this refuses: some parsers silently reinterpret a
	 * six-field expression, turning "every hour" into "every minute".
	 */
	it("refuses six-field expressions rather than guessing", () => {
		expect(() => parseCron("0 0 * * * *")).toThrow(CronError);
		expect(() => parseCron("0 0 * * * *")).toThrow(/sixty sandboxes an hour/);
	});

	it("rejects out-of-range values, bad steps and backwards ranges", () => {
		expect(() => parseCron("60 * * * *")).toThrow(/minute field/);
		expect(() => parseCron("* 24 * * *")).toThrow(/hour field/);
		expect(() => parseCron("* * 0 * *")).toThrow(/day of month/);
		expect(() => parseCron("*/0 * * * *")).toThrow(/invalid step/);
		expect(() => parseCron("30-10 * * * *")).toThrow(/backwards/);
	});
});

describe("matching", () => {
	it("matches on the minute in UTC", () => {
		const schedule = parseCron("30 9 * * *");
		expect(matches(schedule, at("2026-03-04T09:30:00Z"), "UTC")).toBe(true);
		expect(matches(schedule, at("2026-03-04T09:29:00Z"), "UTC")).toBe(false);
		expect(matches(schedule, at("2026-03-04T10:30:00Z"), "UTC")).toBe(false);
	});

	/**
	 * `Intl` renders midnight as hour 24 in en-GB with hour12:false. Left
	 * unhandled that makes every `0 0 * * *` automation never fire — and `@daily`
	 * is the most common expression there is, so the bug would present as "cron
	 * automations do not work" rather than as an edge case.
	 */
	it("matches midnight, which Intl renders as hour 24", () => {
		const schedule = parseCron("0 0 * * *");
		expect(matches(schedule, at("2026-03-04T00:00:00Z"), "UTC")).toBe(true);
	});

	it("respects a timezone", () => {
		const schedule = parseCron("0 9 * * *");
		// 09:00 in Tokyo is 00:00 UTC.
		expect(matches(schedule, at("2026-03-04T00:00:00Z"), "Asia/Tokyo")).toBe(true);
		expect(matches(schedule, at("2026-03-04T09:00:00Z"), "Asia/Tokyo")).toBe(false);
	});

	/**
	 * Cron's one genuine oddity, and matching it is what makes a copied crontab
	 * line behave as its author expects: when BOTH day fields are restricted they
	 * are OR-ed, not AND-ed.
	 */
	it("ORs the day fields when both are restricted", () => {
		const schedule = parseCron("0 0 1 * mon");
		// The 1st of March 2026 is a Sunday — matches on day-of-month alone.
		expect(matches(schedule, at("2026-03-01T00:00:00Z"), "UTC")).toBe(true);
		// The 2nd is a Monday — matches on day-of-week alone.
		expect(matches(schedule, at("2026-03-02T00:00:00Z"), "UTC")).toBe(true);
		// The 3rd is neither.
		expect(matches(schedule, at("2026-03-03T00:00:00Z"), "UTC")).toBe(false);
	});

	it("ANDs the day fields when only one is restricted", () => {
		const schedule = parseCron("0 0 1 * *");
		expect(matches(schedule, at("2026-03-01T00:00:00Z"), "UTC")).toBe(true);
		expect(matches(schedule, at("2026-03-02T00:00:00Z"), "UTC")).toBe(false);
	});
});

describe("nextRun", () => {
	it("never returns the minute it was given, so an automation cannot re-fire", () => {
		const next = nextRun("*/5 * * * *", at("2026-03-04T09:05:00Z"), "UTC");
		expect(next?.toISOString()).toBe("2026-03-04T09:10:00.000Z");
	});

	it("rolls forward across a day boundary", () => {
		const next = nextRun("0 1 * * *", at("2026-03-04T09:00:00Z"), "UTC");
		expect(next?.toISOString()).toBe("2026-03-05T01:00:00.000Z");
	});

	/**
	 * A schedule that can never fire must terminate rather than hang. The 30th of
	 * February is the canonical example and somebody will type it.
	 */
	it("returns null for a schedule that can never fire", () => {
		expect(nextRun("0 0 30 2 *", at("2026-03-04T09:00:00Z"), "UTC")).toBeNull();
	});
});

// ---------------------------------------------------------------------------

describe("glob matching", () => {
	it("stops * at a path separator and lets ** cross one", () => {
		expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
		expect(globToRegExp("src/*.ts").test("src/nested/a.ts")).toBe(false);
		expect(globToRegExp("src/**/*.ts").test("src/nested/deep/a.ts")).toBe(true);
	});

	/** `**\/*.ts` should match a file at the root, not only nested ones. */
	it("lets **/ match zero directories", () => {
		expect(globToRegExp("**/*.ts").test("a.ts")).toBe(true);
		expect(globToRegExp("**/*.ts").test("src/a.ts")).toBe(true);
	});

	/**
	 * A user-supplied string translated straight into a RegExp is how a condition
	 * field becomes a denial of service: this pattern is catastrophic backtracking
	 * evaluated against every changed path of every push, and whoever typed it was
	 * not attacking anyone.
	 */
	it("escapes regex metacharacters rather than honouring them", () => {
		expect(globToRegExp("(a+)+$").test("(a+)+$")).toBe(true);
		expect(globToRegExp("a.b").test("axb")).toBe(false);
		expect(globToRegExp("a.b").test("a.b")).toBe(true);
	});
});

describe("conditions", () => {
	const push = {
		branch: "feature/retry-cap",
		targetBranch: "main",
		labels: ["bug", "backend"],
		paths: ["src/api/retry.ts", "docs/readme.md"],
		author: "rin",
		title: "Cap the retry loop",
	};

	it("matches exact, glob, any_of and none_of", () => {
		expect(evaluate({ field: "target_branch", operator: "exact", value: "main" }, push)).toBe(true);
		expect(evaluate({ field: "path", operator: "glob", value: "src/**/*.ts" }, push)).toBe(true);
		expect(evaluate({ field: "path", operator: "glob", value: "infra/**" }, push)).toBe(false);
		expect(evaluate({ field: "label", operator: "any_of", value: ["bug", "urgent"] }, push)).toBe(true);
		expect(evaluate({ field: "label", operator: "none_of", value: ["skip-review"] }, push)).toBe(true);
		expect(evaluate({ field: "label", operator: "none_of", value: ["bug"] }, push)).toBe(false);
	});

	/**
	 * The asymmetry that matters. A positive condition on an absent field must be
	 * false — "only when the branch is main" must not fire on an event with no
	 * branch. A negative condition on an absent field must be true, or every
	 * negative filter blocks everything it was not written about.
	 */
	it("treats an absent field as false for positive and true for negative conditions", () => {
		const empty = {};
		expect(evaluate({ field: "branch", operator: "exact", value: "main" }, empty)).toBe(false);
		expect(evaluate({ field: "path", operator: "glob", value: "**" }, empty)).toBe(false);
		expect(evaluate({ field: "label", operator: "any_of", value: ["bug"] }, empty)).toBe(false);
		expect(evaluate({ field: "label", operator: "none_of", value: ["bug"] }, empty)).toBe(true);
	});

	/**
	 * AND, not OR. An OR default means adding a second condition makes a trigger
	 * fire MORE, which is the opposite of what somebody adding a filter intends.
	 */
	it("ANDs multiple conditions", () => {
		expect(
			evaluateAll(
				[
					{ field: "target_branch", operator: "exact", value: "main" },
					{ field: "path", operator: "glob", value: "src/**" },
				],
				push,
			),
		).toBe(true);
		expect(
			evaluateAll(
				[
					{ field: "target_branch", operator: "exact", value: "main" },
					{ field: "path", operator: "glob", value: "infra/**" },
				],
				push,
			),
		).toBe(false);
	});

	/**
	 * An unfiltered trigger is a legitimate thing to want, and making the empty
	 * case mean "never" would silently disable every automation created before
	 * filters existed.
	 */
	it("treats no conditions as always", () => {
		expect(evaluateAll([], push)).toBe(true);
		expect(evaluateAll([], {})).toBe(true);
	});

	it("discards malformed conditions rather than throwing on a stored spec", () => {
		const parsed = parseConditions({
			conditions: [
				{ field: "branch", operator: "exact", value: "main" },
				{ field: "nonsense", operator: "exact", value: "x" },
				{ field: "branch", operator: "regex", value: "x" },
				null,
				"nope",
			],
		});
		expect(parsed).toHaveLength(1);
		expect(parsed[0]!.field).toBe("branch");
	});
});
