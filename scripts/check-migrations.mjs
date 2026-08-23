#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Check 5 of 5: migrations are additive. Expand, then contract, and never in one
 * deploy.
 *
 * Harbor runs `npm run db:migrate` on boot, against a database that belongs to
 * whoever self-hosted it. There is no migration review board and often no backup:
 * a `DROP COLUMN` merged on a Tuesday is somebody's data gone on Wednesday, with
 * no rollback, because the old code cannot be redeployed against the new schema
 * either. The same statement also breaks the deploy it ships in — during a rolling
 * restart the old process is still selecting the column the new migration just
 * removed.
 *
 * The discipline that avoids both is expand/contract: add the new column, backfill
 * it, ship code that writes both and reads the new one, and only then — in a
 * LATER release, once no running process references the old shape — remove the
 * old column. This check enforces the "only then" by making the destructive half
 * impossible to merge by accident. It is not a ban: it is a requirement that
 * somebody type a sentence saying they know which release this is.
 *
 * The override, on the destructive statement or in the comment block directly
 * above it:
 *
 *     -- harbor-migration-allow-destructive: column added and unused since 0031;
 *     -- no deployed code reads it.
 *
 * A reason is required, because "the marker is present" is not the property that
 * matters — "someone checked" is, and a reason is the only evidence of that which
 * survives into the git history.
 *
 * What counts as destructive, and what deliberately does not:
 *   - DROP TABLE / DROP COLUMN — data loss, unrecoverable.
 *   - ALTER COLUMN ... TYPE — a table rewrite that can truncate or fail on real
 *     data, and that changes the shape under a running process.
 *   - RENAME — a drop and an add wearing one name; every old reader breaks at once.
 *   - ALTER TYPE ... DROP/RENAME VALUE — same, for enums.
 *   - DROP INDEX is NOT destructive here, and drizzle/0010 legitimately does it.
 *     An index holds no data; dropping one that a later index supersedes is an
 *     ordinary part of expand/contract. The cost is a slow query, not a lost row.
 *   - ALTER TYPE ... ADD VALUE is additive by construction and is allowed.
 *
 * Usage: node scripts/check-migrations.mjs
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

const MIGRATIONS = "drizzle";
const MARKER = "harbor-migration-allow-destructive:";

const DESTRUCTIVE = [
	{ pattern: /\bDROP\s+TABLE\b/i, what: "DROP TABLE" },
	{ pattern: /\bDROP\s+COLUMN\b/i, what: "DROP COLUMN" },
	{ pattern: /\bALTER\s+COLUMN\b[^;]*\bTYPE\b/i, what: "ALTER COLUMN ... TYPE" },
	{ pattern: /\bALTER\s+TYPE\b[^;]*\b(DROP|RENAME)\b/i, what: "ALTER TYPE ... DROP/RENAME" },
	{ pattern: /\bRENAME\s+(TABLE|COLUMN|TO)\b/i, what: "RENAME" },
];

/**
 * Walk back through the contiguous `--` comment block above a statement looking
 * for the marker, and accept it on the statement's own line too. Stops at the
 * first non-comment line, so a marker attached to some unrelated statement
 * further up does not silently license this one. This is the same shape as the
 * escape hatch in scripts/lint-config.mjs, on purpose: one override convention in
 * the repository is one thing to learn.
 *
 * `--> statement-breakpoint` is drizzle's own separator, not a human comment, so
 * it neither carries a marker nor ends the block being scanned.
 */
function reasonFor(lines, index) {
	const own = lines[index].split("--").slice(1).join("--");
	if (own.includes(MARKER)) return own.split(MARKER)[1].trim();

	for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
		const line = (lines[cursor] ?? "").trim();
		if (line === "") continue;
		if (line.startsWith("-->")) continue;
		if (!line.startsWith("--")) return null;
		if (line.includes(MARKER)) return line.split(MARKER)[1].trim();
	}
	return null;
}

const violations = [];

const files = existsSync(MIGRATIONS)
	? readdirSync(MIGRATIONS).filter((entry) => entry.endsWith(".sql")).sort()
	: [];

if (files.length === 0) {
	console.error(
		`check-migrations: no .sql files found under ${MIGRATIONS}/.\n`
		+ "    This check reads the migrations directory directly, so an empty result means the\n"
		+ "    directory moved and the check is now vacuous — which is worse than a failure,\n"
		+ "    because a vacuous check reports success forever. Point MIGRATIONS at the new path.",
	);
	process.exit(1);
}

for (const name of files) {
	const file = path.posix.join(MIGRATIONS, name);
	const lines = readFileSync(file, "utf8").split("\n");

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		// The statement, without any trailing comment: a comment may name a
		// destructive statement while explaining why one was avoided.
		const statement = line.split("--")[0];
		const hit = DESTRUCTIVE.find(({ pattern }) => pattern.test(statement));
		if (!hit) continue;

		const reason = reasonFor(lines, index);
		if (reason && reason.length > 0) continue;

		violations.push(
			`${file}:${index + 1}  ${hit.what} — destructive migration\n`
			+ `    ${statement.trim().slice(0, 100)}\n`
			+ `    ${reason === "" ? "The override marker is present but gives no reason.\n    " : ""}`
			+ `Harbor migrates the operator's own database on boot, with no review and often no\n`
			+ `    backup, and a rolling restart runs the old code against the new schema. Split this\n`
			+ `    into expand now (add, backfill, dual-write) and contract in a LATER release, once\n`
			+ `    nothing deployed reads the old shape.\n`
			+ `    If this IS that later release, say so on the statement or directly above it:\n`
			+ `        -- ${MARKER} <why this is safe now>`,
		);
	}
}

if (violations.length > 0) {
	console.error(`check-migrations: ${violations.length} destructive statement(s) without an override.\n`);
	for (const violation of violations) console.error(`${violation}\n`);
	process.exit(1);
}

console.log(`check-migrations: ${files.length} migration(s) under ${MIGRATIONS}/ are additive.`);
