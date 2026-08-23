#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Check 4 of 5: every lease-state mutation routes through the kernel.
 *
 * Harbor's one hard guarantee is that a scope has at most one active lease. It is
 * held by a partial unique index on `(org_id, scope) WHERE released_at IS NULL`
 * and by the locking discipline in `core/kernel/work.ts` — take the row lock,
 * re-read, decide, write, emit the event. The index means a second writer cannot
 * create a duplicate active lease. It does NOT mean a second writer is harmless:
 * a `claims` row updated from outside the kernel skips the event that the ledger
 * is rebuilt from, skips the cost attribution keyed on `claim_id`, and skips the
 * conflict accounting the pilot's whole number is computed from. The lease is
 * then correct in the table and wrong in every projection derived from it, which
 * is the class of bug that gets found weeks later, in a report, with no way to
 * reconstruct what happened.
 *
 * So the rule is structural rather than behavioural: `claims` is written in
 * exactly one directory. If you need a new lease transition, add a verb to
 * `core/kernel/work.ts`; that is the whole point of there being a kernel.
 *
 * Two exemptions, both deliberate, both stated here rather than hidden:
 *
 *   1. Test files. A test frequently has to manufacture a state the kernel
 *      refuses to create — an already-expired lease, a lease released in the
 *      past, two rows racing — and forcing that through the kernel would mean
 *      testing the kernel with itself. Tests do not ship, so a direct write in
 *      one cannot corrupt a running deployment. The count of exempted writes is
 *      printed on every run so this hole stays visible instead of becoming
 *      invisible.
 *   2. The named demo/seed generators below. These populate a throwaway
 *      development database with fixtures. They are grandfathered, not blessed:
 *      each one should eventually call `claim()` instead, and the fact that they
 *      have to be listed by name here is the pressure to do it. A new file cannot
 *      join this list by accident — adding to it is a diff a reviewer sees.
 *
 * Usage: node scripts/check-write-path.mjs
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

/** The one directory allowed to write the table. */
const KERNEL = "core/kernel";

/** Where source lives. `drizzle/` holds migrations, which are DDL, not lease transitions. */
const SEARCH = ["core", "app", "pilot", "runtime", "scripts"];

const SOURCE = /\.(ts|tsx|mjs)$/;
const TEST = /\.test\.(ts|tsx|mts)$/;
const SKIP_DIRS = new Set(["node_modules", ".next", ".git"]);

/** See exemption 2 in the header comment. Grandfathered, not blessed. */
const GRANDFATHERED = new Set([
	"scripts/seed.ts",
	"scripts/demo.ts",
]);

/**
 * Drizzle's builder form: `db.insert(claims)`, `tx.update(claims)`,
 * `tx.delete(schema.claims)`, and the same split across lines.
 */
const BUILDER = /\.(insert|update|delete)\(\s*(?:[A-Za-z_$][\w$]*\.)?claims\b/;

/**
 * Raw SQL, which bypasses the builder entirely: `sql\`update claims set ...\``.
 * This is the form that actually appeared in the tree, so it is not hypothetical.
 */
const RAW_SQL = /\b(insert\s+into|update|delete\s+from)\s+"?claims"?\b/i;

/**
 * A zone that walks to zero files is the failure mode `check-migrations.mjs`
 * names: a vacuous check reports success forever, which is worse than a failure.
 * `pilot/` is legitimately empty of source today (it holds only a LICENCE), so it
 * is excluded — every other zone must produce files or the tree moved under us.
 */
function assertZonesPopulated(counts, name) {
	const empty = Object.entries(counts).filter(([zone, n]) => n === 0 && zone !== "pilot");
	if (empty.length === 0) return;
	console.error(
		`${name}: walked 0 files under ${empty.map(([z]) => `${z}/`).join(", ")}.\n`
		+ "    This check resolves its zones by path, so an empty walk means the directory was\n"
		+ "    renamed or moved and the check is now vacuous — it would keep printing success\n"
		+ "    while asserting nothing. Re-point the zone list at the new layout.",
	);
	process.exit(1);
}

const zoneCounts = {};

function walk(dir, out = []) {
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIRS.has(entry)) continue;
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (SOURCE.test(entry)) out.push(full);
	}
	return out;
}

const violations = [];
let exemptedTestWrites = 0;

for (const root of SEARCH) {
	const zoneFiles = walk(root);
	zoneCounts[root] = (zoneCounts[root] ?? 0) + zoneFiles.length;
	for (const absolute of zoneFiles) {
		const file = path.relative(ROOT, path.resolve(absolute)).replaceAll("\\", "/");
		if (file.startsWith(`${KERNEL}/`)) continue;

		const lines = readFileSync(absolute, "utf8").split("\n");
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index];
			const trimmed = line.trim();

			// Prose may discuss writing to claims; code may not do it. This mirrors
			// scripts/lint-config.mjs, where the same rule keeps long explanatory
			// comments from tripping the lint they are explaining.
			if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
			if (!BUILDER.test(line) && !RAW_SQL.test(line)) continue;

			if (TEST.test(file) || GRANDFATHERED.has(file)) {
				exemptedTestWrites += 1;
				continue;
			}

			violations.push(
				`${file}:${index + 1}  writes the claims table outside ${KERNEL}/\n`
				+ `    ${trimmed.slice(0, 100)}\n`
				+ `    Every lease transition goes through core/kernel/work.ts — claim, renew, release,\n`
				+ `    complete, revoke — because the kernel is what takes the row lock, re-reads under\n`
				+ `    it, and emits the event the ledger and the cost attribution are rebuilt from. A\n`
				+ `    direct write leaves the table right and every projection derived from it wrong.\n`
				+ `    If the transition you need does not exist yet, add the verb to the kernel.`,
			);
		}
	}
}

if (violations.length > 0) {
	console.error(`check-write-path: ${violations.length} lease write(s) outside ${KERNEL}/.\n`);
	for (const violation of violations) console.error(`${violation}\n`);
	process.exit(1);
}

assertZonesPopulated(zoneCounts, "check-write-path");

console.log(
	`check-write-path: the claims table is written only in ${KERNEL}/`
	+ ` (${exemptedTestWrites} direct write(s) in exempt test fixtures and seed scripts).`,
);
