// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Tests for the lint rule, including its error message.
 *
 * Testing a lint rule's *message* looks like excessive ceremony until you have
 * watched one rot. A rule that fires with "Error: violation" gets an
 * eslint-disable comment and never fires usefully again; a rule that explains
 * what to do instead gets obeyed. The message is the feature, so the message is
 * under test — if somebody shortens it to something unhelpful, this fails.
 */

import { describe, expect, it } from "vitest";
// Plain ESM JavaScript, deliberately: the lint rule must be runnable as a bare
// `node scripts/lint-config.mjs` in CI without a TypeScript toolchain in front
// of it. The shape is asserted here rather than declared in a .d.ts, so a change
// to the rule's return type fails this file rather than a declaration nobody reads.
import {
	findSyncHandoffViolations as rawHandoff,
	findViolations as rawFind,
	lintTree as rawLint,
} from "./lint-config.mjs";

interface Violation {
	file: string;
	line: number;
	name: string;
	value: string;
	message: string;
}

const findViolations = rawFind as (source: string, file: string) => Violation[];
const findSyncHandoffViolations = rawHandoff as (source: string, file: string) => Violation[];
const lintTree = rawLint as (root: string) => Violation[];

describe("finding hardcoded tunables", () => {
	it("fires on a module-level timeout constant", () => {
		const found = findViolations("const BOOT_TIMEOUT_MS = 90_000;\n", "app/example.ts");
		expect(found).toHaveLength(1);
		expect(found[0]!.name).toBe("BOOT_TIMEOUT_MS");
	});

	it("fires on camelCase and on an exported constant", () => {
		expect(findViolations("const pollIntervalMs = 5000;\n", "app/a.ts")).toHaveLength(1);
		expect(findViolations("export const MAX_RETRIES = 3;\n", "app/a.ts")).toHaveLength(1);
		expect(findViolations("const CIRCUIT_COOLDOWN = 60000;\n", "app/a.ts")).toHaveLength(1);
	});

	it("fires through a type annotation and a trailing comment", () => {
		const found = findViolations(
			"const STALE_THRESHOLD_MS: number = 45_000; // three heartbeats\n",
			"app/a.ts",
		);
		expect(found).toHaveLength(1);
	});

	/**
	 * A rule that fires on everything gets turned off. These are the cases that
	 * would produce noise, and each is a real pattern in this codebase.
	 */
	it("does not fire on identifiers that are not tunables", () => {
		expect(findViolations("const IV_BYTES = 12;\n", "app/a.ts")).toHaveLength(0);
		expect(findViolations("const KEY_BYTES = 32;\n", "app/a.ts")).toHaveLength(0);
		expect(findViolations("const VERSION = 1;\n", "app/a.ts")).toHaveLength(0);
	});

	it("does not fire on non-numeric values or on inline numbers", () => {
		expect(findViolations('const TIMEOUT_MESSAGE = "too slow";\n', "app/a.ts")).toHaveLength(0);
		expect(findViolations("const MAX_ITEMS = items.length;\n", "app/a.ts")).toHaveLength(0);
		expect(findViolations("await sleep(30_000);\n", "app/a.ts")).toHaveLength(0);
	});

	it("does not fire inside a function body", () => {
		const source = "function f() {\n\tconst retryDelayMs = 1000;\n\treturn retryDelayMs;\n}\n";
		// Indented by a tab, so the module-level anchor does not match. Locals are
		// out of scope on purpose: the rule is about the deployment's configuration
		// surface, not about every number anyone ever writes.
		expect(findViolations(source, "app/a.ts")).toHaveLength(0);
	});

	it("honours a documented escape hatch on the line above", () => {
		const source =
			"// harbor-lint-allow-constant: the protocol fixes this at 30s\nconst PROTOCOL_TIMEOUT_MS = 30_000;\n";
		expect(findViolations(source, "app/a.ts")).toHaveLength(0);
	});
});

describe("the error message", () => {
	const violation = findViolations("const SPAWN_TIMEOUT_MS = 90_000;\n", "app/sandbox/x.ts")[0]!;

	it("names the file and line", () => {
		expect(violation.message).toContain("app/sandbox/x.ts:1");
	});

	/** Without this, the reader knows they broke a rule but not how to comply. */
	it("says exactly what to do instead", () => {
		expect(violation.message).toContain("core/kernel/config.ts");
		expect(violation.message).toContain('setting("...")');
	});

	/** Without this, the rule reads as arbitrary and gets argued with. */
	it("says why the rule exists in terms of who it hurts", () => {
		expect(violation.message).toContain("fork the project");
		expect(violation.message).toContain("self-hoster");
	});

	it("names the escape hatch", () => {
		expect(violation.message).toContain("harbor-lint-allow-constant");
	});
});

describe("the tree as it actually stands", () => {
	/**
	 * The acceptance criterion, asserted rather than asserted-about: no hardcoded
	 * tunable exists anywhere in the shipped source. If this fails, the message
	 * printed by the rule tells whoever broke it what to do.
	 */
	it("has no hardcoded tunables", () => {
		const violations = lintTree(process.cwd());
		if (violations.length > 0) {
			throw new Error(
				`${violations.length} hardcoded tunable(s):\n\n`
					+ violations.map((v) => v.message).join("\n\n"),
			);
		}
		expect(violations).toHaveLength(0);
	});
});

describe("the escape hatch", () => {
	/**
	 * The first version of this rule checked only the line directly above, which
	 * meant a well-written five-line justification did NOT suppress it and a terse
	 * one did — training people to write the terse one. That is exactly backwards
	 * for a mechanism whose entire value is the explanation, and it was caught by
	 * the rule firing on its own author.
	 */
	it("accepts a marker anywhere in the comment block above", () => {
		const source = [
			"// harbor-lint-allow-constant: the protocol fixes this, so it is not a",
			"// deployment choice and a knob here would only make the endpoint easier",
			"// to abuse.",
			"const MAX_BODY_BYTES = 4_096;",
			"",
		].join("\n");
		expect(findViolations(source, "app/a.ts")).toHaveLength(0);
	});

	it("accepts a marker inside a jsdoc block", () => {
		const source = [
			"/**",
			" * harbor-lint-allow-constant: fixed by the wire format.",
			" */",
			"const MAX_FRAME_BYTES = 65_536;",
			"",
		].join("\n");
		expect(findViolations(source, "app/a.ts")).toHaveLength(0);
	});

	/**
	 * A marker attached to some unrelated declaration further up must not silently
	 * license this one — otherwise one exception in a file exempts the whole file,
	 * which is how an escape hatch becomes an opt-out.
	 */
	it("does not carry a marker across a non-comment line", () => {
		const source = [
			"// harbor-lint-allow-constant: this one is fine",
			"const MAX_FRAME_BYTES = 65_536;",
			"const somethingElse = compute();",
			"const POLL_INTERVAL_MS = 5_000;",
			"",
		].join("\n");
		const found = findViolations(source, "app/a.ts");
		expect(found).toHaveLength(1);
		expect(found[0]!.name).toBe("POLL_INTERVAL_MS");
	});
});

describe("arithmetic expressions and the widened name set", () => {
	/**
	 * The regression this closes shipped: three real tunables — the Slack replay
	 * window, the maximum claim lease, the dashboard cookie lifetime — sat
	 * hardcoded while the lint reported a clean tree, because the value pattern
	 * matched only a bare literal and the name pattern lacked _MINUTES. A lint
	 * rule that does not fire is worse than none, because it is believed.
	 */
	it("fires on arithmetic over literals — the careful author's spelling", () => {
		expect(findViolations("const REPLAY_WINDOW_SECONDS = 60 * 5;\n", "app/a.ts")).toHaveLength(1);
		expect(findViolations("const MAX_LEASE_MINUTES = 8 * 60;\n", "app/a.ts")).toHaveLength(1);
		expect(findViolations("const MAX_AGE_SECONDS = 30 * 86_400;\n", "app/a.ts")).toHaveLength(1);
	});

	it("fires on whitespace variants and a trailing comment", () => {
		expect(findViolations("const MAX_LEASE_MINUTES = 8*60;\n", "app/a.ts")).toHaveLength(1);
		expect(
			findViolations("const MAX_LEASE_MINUTES = 8 * 60; // a working day\n", "app/a.ts"),
		).toHaveLength(1);
	});

	it("fires on _MINUTES and MIN_ names", () => {
		expect(findViolations("const DEFAULT_LEASE_MINUTES = 30;\n", "app/a.ts")).toHaveLength(1);
		expect(findViolations("const MIN_SECRET_LENGTH = 32;\n", "app/a.ts")).toHaveLength(1);
	});

	it("does not fire on identifier operands — a computation is not a configuration", () => {
		expect(findViolations("const TOTAL_MS = a * b;\n", "app/a.ts")).toHaveLength(0);
		expect(findViolations("const WINDOW_MS = base * factor;\n", "app/a.ts")).toHaveLength(0);
	});
});

describe("the sync-handoff rule", () => {
	const region = (body: string) =>
		[
			"async function start() {",
			"\t// harbor-sync-handoff-begin: baseline before gate",
			body,
			"\t// harbor-sync-handoff-end",
			"}",
			"",
		].join("\n");

	it("fires on an await inserted into the critical block", () => {
		const found = findSyncHandoffViolations(
			region("\tsend(1);\n\tconst x = await db.select();\n\tsessionId = s;"),
			"app/api/sessions/[key]/stream/route.ts",
		);
		expect(found).toHaveLength(1);
		expect(found[0]!.line).toBe(4);
	});

	it("fires on .then( and for await, the awaits wearing disguises", () => {
		expect(
			findSyncHandoffViolations(region("\tdb.select().then(() => {});"), "app/a.ts"),
		).toHaveLength(1);
		expect(
			findSyncHandoffViolations(region("\tfor await (const x of xs) {}"), "app/a.ts"),
		).toHaveLength(1);
	});

	it("lets a comment discuss await without firing", () => {
		expect(
			findSyncHandoffViolations(region("\t// an await here would lose events\n\tsend(1);"), "app/a.ts"),
		).toHaveLength(0);
	});

	it("passes the clean synchronous block", () => {
		expect(
			findSyncHandoffViolations(
				region("\tsend(\"snapshot\", snapshot);\n\tcontiguousThrough = n;\n\tsessionId = s;"),
				"app/a.ts",
			),
		).toHaveLength(0);
	});

	it("treats an unterminated begin marker as a violation itself", () => {
		const found = findSyncHandoffViolations(
			"// harbor-sync-handoff-begin\nsend(1);\n",
			"app/a.ts",
		);
		expect(found).toHaveLength(1);
		expect(found[0]!.message).toContain("unterminated");
	});

	it("says what breaks and what to do about it", () => {
		const [violation] = findSyncHandoffViolations(
			region("\tawait metrics.record();"),
			"app/a.ts",
		);
		expect(violation!.message).toContain("snapshot");
		expect(violation!.message).toContain("one missing event");
		expect(violation!.message).toContain("Move the async work");
	});

	it("the stream route actually carries the markers — removing them fails here", () => {
		// The rule only protects marked regions, so the markers themselves are
		// load-bearing. This is the assertion that stops a refactor from deleting
		// the comment and, with it, the entire protection.
		const { readFileSync } = require("node:fs") as typeof import("node:fs");
		const source = readFileSync("app/api/sessions/[key]/stream/route.ts", "utf8");
		expect(source).toContain("harbor-sync-handoff-begin");
		expect(source).toContain("harbor-sync-handoff-end");
	});
});
