// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The README must describe the product that exists.
 *
 * Every assertion here replaces a claim that had already drifted. The README said
 * Cursor shipped as a drivable agent (the adapter refuses it by name), quoted an
 * index that a migration had dropped, and advertised a token budget 15% under the
 * real one. None of those were caught by anything, because prose is the one part
 * of a repository nothing compiles.
 *
 * The rule this file enforces: a claim specific enough to be wrong is specific
 * enough to be tested. Vaguer prose is deliberately left alone — the point is not
 * to pin every sentence, it is that the *numbered and enumerated* claims cannot
 * quietly stop being true.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_RUNTIMES } from "@app/contracts/agent.js";
import { SANDBOX_PROVIDER_NAMES } from "@app/sandbox/registry.js";
import { adapterFor } from "../runtime/adapters/index.js";

const ROOT = process.cwd();
const readme = readFileSync(join(ROOT, "README.md"), "utf8");

describe("README: sandbox providers", () => {
	/**
	 * The provider table is the first thing an operator reads when choosing where
	 * sandboxes run, and a table that omits a shipped provider costs them the
	 * option silently — they never learn it was there.
	 */
	it("names every provider in the registry, and no others", () => {
		const table = readme.slice(
			readme.indexOf("| Provider | Isolation | Needs |"),
			readme.indexOf("### At most one sandbox per lease"),
		);
		expect(table).not.toHaveLength(0);

		for (const name of SANDBOX_PROVIDER_NAMES) {
			expect(table, `README provider table is missing \`${name}\``).toContain(`\`${name}\``);
		}

		// And nothing invented. A row for a provider that does not exist is the
		// failure `app/sandbox/registry.ts` refuses to allow in code; the README must
		// not reintroduce it in prose.
		const rows = table
			.split("\n")
			.filter((line) => line.trim().startsWith("| `"))
			.map((line) => line.split("`")[1]!);
		for (const row of rows) {
			expect(
				SANDBOX_PROVIDER_NAMES as readonly string[],
				`README advertises provider \`${row}\`, which is not in SANDBOX_PROVIDER_NAMES`,
			).toContain(row);
		}
	});
});

describe("README: coding agents", () => {
	/**
	 * "X ships" is the claim that decides whether somebody starts an evaluation, so
	 * it is the one claim that must never be aspirational. A runtime Harbor cannot
	 * drive headless is refused by `adapterFor`; the README has to agree with that
	 * function rather than with the `AGENT_RUNTIMES` union, which is wider on
	 * purpose (it also covers runtimes Harbor only *watches*).
	 */
	const drivable = AGENT_RUNTIMES.filter((runtime) => adapterFor(runtime).ok);
	const refused = AGENT_RUNTIMES.filter((runtime) => !adapterFor(runtime).ok);

	const section = readme.slice(
		readme.indexOf("### Bring your own agent"),
		readme.indexOf("### Pull requests are authored by the human"),
	);

	it("has a Bring your own agent section", () => {
		expect(section).not.toHaveLength(0);
	});

	it("claims exactly the runtimes that have a working adapter", () => {
		// `custom` is described by its mechanism (an argv template) rather than by
		// name in the ships list, so it is checked separately below.
		for (const runtime of drivable.filter((r) => r !== "custom")) {
			expect(section.toLowerCase(), `README does not say ${runtime} ships`).toContain(
				runtime.replace("-", " ") === "claude code" ? "claude code" : runtime,
			);
		}
		expect(section).toContain("`custom`");
	});

	it("does not claim a refused runtime can be driven", () => {
		// The section may — and should — mention a refused runtime, but only to
		// explain that Harbor watches it rather than runs it. What it must never do
		// is list one alongside the ones that ship.
		for (const runtime of refused) {
			const claimsItShips = new RegExp(
				`${runtime}[^.]{0,80}(ship|is supported as an agent|runs in a sandbox)`,
				"i",
			);
			expect(
				claimsItShips.test(section),
				`README appears to claim ${runtime} ships, but adapterFor refuses it`,
			).toBe(false);
		}
	});
});

describe("README: the coordination guarantee", () => {
	/**
	 * The single most load-bearing snippet in the document. It quoted
	 * `one_active_claim_per_task` for months after migration 0010 dropped that index
	 * and replaced it with a scope-based one — so the README was describing a
	 * guarantee the database no longer made, in the section explaining why the
	 * guarantee is trustworthy.
	 */
	it("quotes an index that the migrations actually create", () => {
		const match = readme.match(/create unique index (\w+)\s+on (\w+) \(([^)]+)\)/i);
		expect(match, "README no longer contains a `create unique index` snippet").not.toBeNull();
		const indexName = match![1]!;
		const table = match![2]!;
		const columns = match![3]!;

		const migrations = readdirSync(join(ROOT, "drizzle"))
			.filter((f) => f.endsWith(".sql"))
			.sort();
		const sql = migrations
			.map((f) => readFileSync(join(ROOT, "drizzle", f), "utf8"))
			.join("\n");

		// Created...
		const created = new RegExp(`CREATE UNIQUE INDEX "${indexName}"`, "i").test(sql);
		expect(created, `no migration creates "${indexName}"`).toBe(true);

		// ...and never dropped afterwards.
		const dropped = new RegExp(`DROP INDEX "${indexName}"`, "i").test(sql);
		expect(dropped, `"${indexName}" is created but later dropped; the README is stale`).toBe(
			false,
		);

		expect(sql).toContain(`ON "${table}"`);
		for (const column of columns.split(",").map((c) => c.trim())) {
			expect(sql, `index "${indexName}" does not cover ${column}`).toContain(`"${column}"`);
		}
	});
});

describe("the docs describe Harbor and nothing else", () => {
	/**
	 * The README once opened with a feature-by-feature comparison against another
	 * project, and a dozen source comments justified a decision by describing how
	 * somebody else got it wrong. That reads as defensive, dates badly — the other
	 * project changes and the criticism silently becomes false — and teaches a
	 * reader about software they did not ask about.
	 *
	 * Every one of those arguments survived being rewritten to stand on its own,
	 * which is the evidence that the foil was never carrying them.
	 */
	const BANNED = [
		"colemurray",
		"background-agents",
		"open-inspect",
		"competing implementation",
		"reference implementation",
		"the reference design",
		"the reference's",
		"block/buzz",
	];

	/**
	 * Match against normalized text, not the raw bytes.
	 *
	 * The first version of this check tested `raw.includes(term)`, and six files
	 * passed it while containing a banned phrase in full — because a comment had
	 * wrapped it: `* ...the reference\n * implementation's...`. The substring is
	 * split by a newline and a ` * ` leader, so it never matched, and the check
	 * reported clean on exactly the prose it existed to find.
	 *
	 * Joining comment-continuation lines and collapsing whitespace closes that.
	 * Do not "simplify" this back to a raw `includes` — the wrapping is invisible
	 * in a diff and the check goes quietly vacuous again.
	 */
	function normalize(raw: string): string {
		return raw
			.toLowerCase()
			.replace(/\s*\n\s*\*?\s*/g, " ")
			.replace(/\s+/g, " ");
	}

	/**
	 * Everything shipped: the licence zones (`core/`, `app/`, `pilot/`), the code
	 * that runs beside them (`runtime/`, `scripts/`), and the prose (`docs/`,
	 * `integrations/`, `sandbox/`). This list is the whole of what the check sees,
	 * so a new top-level directory of source has to be added here or its comments
	 * go unread.
	 *
	 * A directory named here that does not exist raises ENOENT rather than being
	 * skipped, and that is deliberate. This list went stale exactly once — it still
	 * said `src/` after `src/` was split into zones — and the ENOENT is what
	 * reported it. A walk that shrugged at a missing directory would instead have
	 * gone on passing while scanning nothing, which is the failure mode this whole
	 * file exists to avoid.
	 */
	const SCANNED = ["core", "app", "pilot", "runtime", "scripts", "docs", "integrations", "sandbox"];

	function sources(): string[] {
		const out: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir)) {
				if (["node_modules", ".next", ".git", ".context", "drizzle"].includes(entry)) continue;
				const full = join(dir, entry);
				if (statSync(full).isDirectory()) walk(full);
				else if (/\.(ts|tsx|md|mjs)$/.test(entry)) out.push(full);
			}
		};
		for (const dir of SCANNED) {
			walk(join(ROOT, dir));
		}

		// The repository root holds source too, and not only by accident: Next.js
		// resolves `instrumentation.ts` from the root and nowhere else, so a file
		// that used to sit under `src/` and be walked above now lives here. Read the
		// root shallowly — the directories in it are either walked above or excluded
		// on purpose (`drizzle/`, `node_modules/`, and the rest).
		for (const entry of readdirSync(ROOT)) {
			const full = join(ROOT, entry);
			if (statSync(full).isDirectory()) continue;
			if (/\.(ts|tsx|md|mjs)$/.test(entry)) out.push(full);
		}

		// Named explicitly as well as picked up by the root scan above, because the
		// documents an operator is handed are not optional: if one is renamed away,
		// this should fail on the missing file rather than quietly stop checking it.
		for (const file of ["README.md", "CHAT.md", "DEPLOY.md", "CONNECTORS.md"]) {
			out.push(join(ROOT, file));
		}
		return [...new Set(out)];
	}

	it("names no other project, in any doc or comment", () => {
		const offenders: string[] = [];
		for (const file of sources()) {
			// This file necessarily contains the banned strings, as data.
			if (file.endsWith("readme-claims.test.ts")) continue;
			const text = normalize(readFileSync(file, "utf8"));
			for (const term of BANNED) {
				if (text.includes(term)) offenders.push(`${file.replace(ROOT + "/", "")}: "${term}"`);
			}
		}
		expect(offenders, `these files name another project:\n  ${offenders.join("\n  ")}`).toEqual(
			[],
		);
	});
});
