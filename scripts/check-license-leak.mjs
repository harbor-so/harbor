#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Check 3 of 5: no FSL licence text anywhere under `core/`.
 *
 * This is the check that protects the promise, as opposed to the filing. Check 1
 * makes sure each file under `core/` DECLARES Apache-2.0; this one makes sure no
 * file under `core/` also carries the FSL text that would contradict that
 * declaration. The realistic failure is not malice, it is a copy: a file is moved
 * from `app/` into `core/` with its header still attached, or the FSL LICENSE
 * itself gets copied down one directory, and now the Apache tree contains a
 * source-available licence grant. Anyone who then extracts `core/` and reads it
 * finds two incompatible statements about what they may do, and the safe reading
 * — the one their lawyer will take — is the restrictive one. The extractable half
 * stops being extractable, quietly, from a one-line diff.
 *
 * Tradeoff, stated deliberately: the spec named scancode-toolkit, and this is a
 * grep instead. scancode is a Python toolchain with a multi-minute install and a
 * large dependency tree, in a CI job whose defining property is that it needs no
 * configuration and no secrets; paying that on every push to detect a copied
 * header is the wrong trade. What is given up is real and worth naming: scancode
 * recognises PARAPHRASED and partial licence text, and the markers below only
 * catch the verbatim phrases. That is the right coverage for the failure that
 * actually happens (a pasted header or a copied LICENSE file) and the wrong
 * coverage for someone hand-rewriting the FSL terms into a comment — which is not
 * a mistake anybody makes by accident.
 *
 * Usage: node scripts/check-license-leak.mjs
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const CORE = "core";

/**
 * Verbatim phrases from LICENSES/LicenseRef-FSL-1.1-Apache-2.0.txt, chosen
 * because each one is unique to the FSL and none of them appears in ordinary
 * prose about leases, scopes or claims. `Permitted Purpose` and `Competing Use`
 * are the FSL's two defined terms and catch a pasted body that has lost its
 * title; the identifier strings catch a pasted header.
 */
const FSL_MARKERS = [
	"Functional Source License",
	"FSL-1.1",
	"LicenseRef-FSL",
	"Competing Use",
	"Permitted Purpose",
];

/** Text-ish files only. A binary under core/ would be a different problem. */
const SKIP_DIRS = new Set(["node_modules", ".next", ".git"]);
const BINARY = /\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|pdf|zip|gz)$/i;

function walk(dir, out = []) {
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIRS.has(entry)) continue;
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (!BINARY.test(entry)) out.push(full);
	}
	return out;
}

const findings = [];

for (const file of walk(CORE)) {
	const lines = readFileSync(file, "utf8").split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const marker = FSL_MARKERS.find((candidate) => lines[index].includes(candidate));
		if (!marker) continue;
		findings.push(
			`${file}:${index + 1}  contains FSL licence text: "${marker}"\n`
			+ `    ${lines[index].trim().slice(0, 100)}\n`
			+ `    Everything under core/ is Apache-2.0 and is meant to be extractable on its own.\n`
			+ `    If this file arrived from app/, it kept its old header — replace it with\n`
			+ `    "// SPDX-License-Identifier: Apache-2.0". If the file genuinely is FSL, it belongs\n`
			+ `    in app/ or pilot/, not here.`,
		);
	}
}

/**
 * The other half of the same promise: the Apache text has to actually be present.
 * An extracted `core/` with no LICENSE file grants nothing at all, which is a
 * worse outcome than the leak this check is named for.
 */
const coreLicence = path.join(CORE, "LICENSE");
if (!existsSync(coreLicence)) {
	findings.push(
		`${coreLicence}  missing\n`
		+ `    core/ is published as Apache-2.0 and must carry the Apache-2.0 text, or an\n`
		+ `    extracted copy grants a recipient nothing. Copy LICENSES/Apache-2.0.txt to core/LICENSE.`,
	);
} else if (!readFileSync(coreLicence, "utf8").includes("Apache License")) {
	findings.push(
		`${coreLicence}  is not the Apache-2.0 text\n`
		+ `    core/ is published as Apache-2.0. Copy LICENSES/Apache-2.0.txt to core/LICENSE.`,
	);
}

if (findings.length > 0) {
	console.error(`check-license-leak: ${findings.length} licence problem(s) under ${CORE}/.\n`);
	for (const finding of findings) console.error(`${finding}\n`);
	process.exit(1);
}

console.log(`check-license-leak: no FSL licence text under ${CORE}/, and core/LICENSE is Apache-2.0.`);
