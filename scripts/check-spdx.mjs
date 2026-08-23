#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Check 1 of 5: every source file declares the licence of the zone it lives in.
 *
 * Harbor ships as two licences in one tree. `core/` is the extractable Apache-2.0
 * half — the lease kernel, the schema, the MCP wire format — and everything that
 * ships around it is FSL-1.1-Apache-2.0. That split is only real if a reader can
 * tell, from the file in front of them, which licence they hold. A directory-level
 * LICENSE does not survive the way this code actually travels: files get copied
 * into gists, pasted into issues, vendored into a fork, and read one at a time by
 * an agent that never opens the directory listing. A per-file SPDX identifier is
 * the only marking that travels with the bytes.
 *
 * So this check is not paperwork. A file under `core/` that carries no header, or
 * carries the FSL identifier, is a file that cannot be extracted with confidence —
 * and the extractable Apache half is the whole reason for the split.
 *
 * The prologue rule is the subtle part, and it is load-bearing. A shebang must be
 * the first bytes of an executable script, and a `"use client"` directive must be
 * the first statement of a module or Next.js silently demotes the component to a
 * server component — silently, with no type error and no build failure. So the
 * header is required on line 1 normally, and on line 2 exactly when line 1 is a
 * prologue. Getting this backwards breaks the app in a way tsc cannot see, which
 * is why the rule is encoded here rather than left to whoever adds the next file.
 *
 * Usage:
 *   node scripts/check-spdx.mjs           # check; exits 1 on any missing/wrong header
 *   node scripts/check-spdx.mjs --write   # insert the correct header where it is missing
 *
 * Scope note: the zones below are the licensed source trees. Root-level build
 * configuration (`next.config.js`, `postcss.config.js`, `drizzle.config.ts`,
 * `vitest.config.ts`, `vitest.setup.ts`) and the
 * `integrations/` samples are deliberately not walked — they carry no zone, and
 * silently inventing one for them would put a licence claim on files that were
 * never reviewed for it. If a zone is added to the repository, add it here; a
 * checker that has to be told about a new directory is a checker that stops
 * covering the newest code, so the list is short and visible on purpose.
 */

import fs from "node:fs";
import path from "node:path";

const WRITE = process.argv.includes("--write") || process.argv.includes("--fix");

const APACHE = "Apache-2.0";
const FSL = "LicenseRef-FSL-1.1-Apache-2.0";

/** zone -> licence. `core/` is the extractable Apache half; everything else ships FSL. */
const ZONES = [
	["core", APACHE],
	["app", FSL],
	["pilot", FSL],
	["runtime", FSL],
	["scripts", FSL],
];

/**
 * Shipped source that cannot live inside a zone. `instrumentation.ts` must sit at
 * the repository root because that is where Next.js looks for it once there is no
 * `src/` directory — but it is not build configuration: it runs the web tier's
 * startup checks in production, the Dockerfile gives it its own COPY line, and an
 * unmarked shipped file is exactly what this check exists to make impossible.
 */
const ROOT_SOURCE = [["instrumentation.ts", FSL]];

const SOURCE = /\.(ts|tsx|mjs)$/;
const SKIP_DIRS = new Set(["node_modules", ".next", ".git"]);

/**
 * A shebang or a directive prologue MUST hold line 1 — see the header comment.
 * `"use strict"` is included because a module that declares it is asserting
 * something about its own first statement too.
 */
const PROLOGUE = /^#!|^["']use (client|server|strict)["']/;

const HEADER = "// SPDX-License-Identifier:";

function walk(dir, out = []) {
	if (!fs.existsSync(dir)) return out;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (!SKIP_DIRS.has(entry.name)) walk(full, out);
		} else if (SOURCE.test(entry.name)) {
			out.push(full);
		}
	}
	return out;
}

let scanned = 0;
let added = 0;
const problems = [];

/**
 * A zone that walks to zero files is the failure mode `check-migrations.mjs`
 * names: a vacuous check reports success forever, which is worse than a failure.
 * `pilot/` is legitimately empty of source today (it holds only a LICENCE), so it
 * is excluded — every other zone must produce files or the tree moved underneath us.
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

for (const [zone, licence] of ZONES) {
	const walked = walk(zone);
	// Root-level shipped source is checked under the zone that owns its licence.
	// Counted separately from `walked` so it can never mask an empty zone: a tree
	// where core/ has vanished must still fail, not be propped up by a root file.
	const rootFiles = ROOT_SOURCE
		.filter(([file, lic]) => lic === licence && fs.existsSync(file))
		.map(([file]) => file);
	zoneCounts[zone] = walked.length;
	const zoneFiles = [...walked, ...rootFiles];
	for (const file of zoneFiles) {
		scanned += 1;
		const source = fs.readFileSync(file, "utf8");
		const lines = source.split("\n");
		const wanted = PROLOGUE.test(lines[0] ?? "") ? 1 : 0;

		// A prologue on line 2 is broken whatever the header says, and it is the
		// exact mistake this check exists to prevent: inserting the licence header
		// above a shebang leaves a script whose first bytes are a comment, so the
		// kernel refuses to exec it, and inserting it above "use client" is at best
		// a convention violation and at worst — depending on what else drifts above
		// it later — a component that silently stops being a client component. The
		// prologue holds line 1; the header goes underneath it.
		if (PROLOGUE.test(lines[1] ?? "")) {
			problems.push(
				`${file}\n`
				+ `    line 2 is a shebang or a "use client"/"use server" directive, which must be line 1.\n`
				+ `    Move it up and put the SPDX header on line 2 underneath it: a shebang that is not\n`
				+ `    the first bytes of the file does not run, and a directive that is not the first\n`
				+ `    statement is ignored with no error anywhere.`,
			);
			continue;
		}

		// Only the first two lines can legally hold the header, so only those are
		// examined. A header buried at line 40 is not a header — a tool that reads
		// the top of the file to decide the licence would not find it.
		const at = lines.findIndex((line, index) => index < 2 && line.startsWith(HEADER));

		if (at !== -1) {
			const have = lines[at].slice(HEADER.length).trim();
			if (have !== licence) {
				problems.push(
					`${file}\n`
					+ `    declares ${have}, but every file under ${zone}/ is ${licence}.\n`
					+ `    If this file genuinely belongs to the other licence, it belongs in the\n`
					+ `    other zone — move the file, do not edit the header.`,
				);
			} else if (at !== wanted) {
				problems.push(
					`${file}\n`
					+ `    SPDX header is on line ${at + 1}, expected line ${wanted + 1}.\n`
					+ `    ${wanted === 1
						? "Line 1 is a shebang or a \"use client\"/\"use server\" directive and must stay first: "
							+ "a directive that is not the first statement is ignored, and Next.js demotes the "
							+ "component to a server component with no error anywhere."
						: "There is no prologue on line 1, so the header goes there."}`,
				);
			}
			continue;
		}

		if (!WRITE) {
			problems.push(
				`${file}\n`
				+ `    no SPDX header. Add "${HEADER} ${licence}" as line ${wanted + 1}.\n`
				+ `    Run \`node scripts/check-spdx.mjs --write\` to insert it.`,
			);
			continue;
		}

		lines.splice(wanted, 0, `${HEADER} ${licence}`);
		fs.writeFileSync(file, lines.join("\n"));
		added += 1;
	}
}

assertZonesPopulated(zoneCounts, "check-spdx");

if (problems.length > 0) {
	console.error(`check-spdx: ${problems.length} file(s) with a missing or wrong licence header.\n`);
	for (const problem of problems) console.error(`${problem}\n`);
	console.error(
		"Harbor ships two licences in one tree: core/ is Apache-2.0 and is meant to be\n"
		+ "extractable on its own; app/, pilot/, runtime/ and scripts/ are FSL-1.1-Apache-2.0.\n"
		+ "A file with no header cannot be extracted with confidence, so this is a build failure.\n",
	);
	process.exit(1);
}

if (WRITE) {
	console.log(`check-spdx: ${added} header(s) added across ${scanned} file(s).`);
} else {
	console.log(
		`check-spdx: ${scanned} file(s) across ${ZONES.map(([zone]) => `${zone}/`).join(", ")} all carry the licence of their zone.`,
	);
}
