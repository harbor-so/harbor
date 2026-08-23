#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Check 2 of 5: the licence zones are one-way. `core/` imports nothing outside
 * `core/`, and `app/` imports nothing from `pilot/`.
 *
 * The two rules exist for different reasons and both are one-way doors.
 *
 * `core/` is the Apache-2.0 half, and "extractable" is a property that is either
 * true or false at any given commit — there is no partially extractable. One
 * import of `app/lib/...` from a kernel file makes the Apache tree un-shippable
 * on its own, and nothing else in the build notices: tsc resolves it happily,
 * the tests pass, the app runs. The failure only surfaces the day someone tries
 * to publish the kernel, which is the worst possible day to discover it.
 *
 * `pilot/` is per-customer work — hand-authored views for one pilot tenant. It is
 * allowed to depend on the product; the product is not allowed to depend on it,
 * or the pilot stops being a pilot and becomes a permanent limb of the codebase
 * that cannot be deleted when the engagement ends.
 *
 * Why this is a script and not dependency-cruiser: the rule is roughly forty
 * lines of path arithmetic, and the alternative is a dependency with its own
 * config format, its own resolver, and its own version to keep current — for a
 * check that must keep working in a fork with no network. The cost of writing it
 * is lower than the cost of owning the dependency.
 *
 * The dynamic-import case is the entire reason for the care taken below. A
 * boundary violation hid in `await import("../lib/cost.js")` once already: it is
 * invisible to a static-import grep, invisible to tsc's module graph in the way
 * people usually read it, and it is exactly the shape that lazy-loading produces.
 * So `import(...)`, `require(...)`, side-effect `import "..."` and re-exporting
 * `export ... from "..."` are all resolved here, and inside `core/` a dynamic
 * import whose specifier is NOT a literal is itself a failure — an unresolvable
 * import is an unprovable boundary, and this check trades a little inconvenience
 * for a property that can actually be asserted.
 *
 * Third-party specifiers (`drizzle-orm`, `node:crypto`) are not zone crossings
 * and are skipped. Whether the kernel may depend on a given npm package is a
 * licence-compatibility question about `package.json`, not a question about the
 * shape of this tree.
 *
 * Usage: node scripts/check-boundaries.mjs
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

/** The zones this repository is divided into. First path segment wins. */
const ZONES = ["core", "app", "pilot", "runtime", "scripts", "drizzle", "integrations", "sandbox", "deploy", "docker"];

/**
 * The policy, stated once. `from` is the zone a file lives in; `mayNotImport`
 * answers whether a resolved first-party target is out of bounds for it.
 */
const RULES = [
	{
		from: "core",
		mayNotImport: (zone) => zone !== "core",
		explain: (target) =>
			`core/ is the Apache-2.0 half of this repository and must be extractable on its own.\n`
			+ `    This import reaches ${target}, which does not ship with it, so the extracted tree\n`
			+ `    would not compile. Move the shared code down into core/, or invert the dependency\n`
			+ `    so the caller passes what the kernel needs as an argument.`,
	},
	{
		from: "app",
		mayNotImport: (zone) => zone === "pilot",
		explain: (target) =>
			`pilot/ is hand-authored work for a single pilot tenant, and the product must not\n`
			+ `    depend on it — ${target} has to stay deletable on the day that engagement ends.\n`
			+ `    Dependencies point pilot/ -> app/ -> core/, never back up. If app/ needs this\n`
			+ `    behaviour, it is not pilot code: promote it into app/.`,
	},
];

const SOURCE = /\.(ts|tsx|mjs)$/;
const SKIP_DIRS = new Set(["node_modules", ".next", ".git"]);

/**
 * Import specifiers this repository writes for its own files. Anything else is a
 * package name and is none of this check's business.
 *   ./x, ../x        relative, the common case
 *   @core/x, @app/x  the tsconfig path aliases
 *   core/x, app/x    a zone-rooted specifier, which nothing writes today but
 *                    which must not become the hole in this check tomorrow
 */
const ALIASES = { "@core/": "core/", "@app/": "app/" };

function isFirstParty(specifier) {
	if (specifier.startsWith("./") || specifier.startsWith("../")) return true;
	if (Object.keys(ALIASES).some((alias) => specifier.startsWith(alias))) return true;
	return ZONES.some((zone) => specifier === zone || specifier.startsWith(`${zone}/`));
}

/** Resolve a first-party specifier to a repo-relative path (no extension logic needed: only the directory decides the zone). */
function resolveFirstParty(fromFile, specifier) {
	for (const [alias, zone] of Object.entries(ALIASES)) {
		if (specifier.startsWith(alias)) return zone + specifier.slice(alias.length);
	}
	if (!specifier.startsWith(".")) return specifier;
	const joined = path.posix.join(path.posix.dirname(fromFile), specifier);
	return path.posix.normalize(joined);
}

function zoneOf(repoRelative) {
	const [first] = repoRelative.split("/");
	return ZONES.includes(first) ? first : null;
}

/**
 * Blank out comments so a commented-out import is not reported as a real one,
 * without disturbing line numbers.
 *
 * This is line-based rather than a real tokenizer, deliberately: a hand-rolled
 * JavaScript lexer has to get regex literals right to avoid mistaking `/["']/`
 * for the start of a string, and getting THAT wrong makes the check silently
 * skip the rest of a file. Whole-line comments are the shape that commented-out
 * imports actually take, and a trailing `// import ...` after real code is not a
 * thing anyone writes.
 */
function stripComments(source) {
	const out = [];
	let inBlock = false;
	for (const line of source.split("\n")) {
		const trimmed = line.trim();
		if (inBlock) {
			out.push("");
			if (trimmed.includes("*/")) inBlock = false;
			continue;
		}
		if (trimmed.startsWith("/*")) {
			out.push("");
			if (!trimmed.includes("*/")) inBlock = true;
			continue;
		}
		if (trimmed.startsWith("//") || trimmed.startsWith("*")) {
			out.push("");
			continue;
		}
		out.push(line);
	}
	return out.join("\n");
}

/**
 * Every specifier the module graph can reach, with the line it sits on.
 *
 * `from "..."` is matched anywhere on a line rather than only after a leading
 * `import`, because a multi-line named import puts the specifier on its own
 * line — a line-anchored pattern would miss precisely the long import lists
 * where a stray cross-zone name is easiest to overlook.
 */
const PATTERNS = [
	/\bfrom\s*["']([^"']+)["']/g,          // import ... from "x";  export ... from "x";
	/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // await import("x");  typeof import("x")
	/\bimport\s+["']([^"']+)["']/g,        // import "x";  (side-effect / bare)
	/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

/** `import(` whose argument is not a string literal — see the header comment. */
const COMPUTED_IMPORT = /\bimport\s*\(\s*(?!["'])/g;

function lineOf(source, index) {
	let line = 1;
	for (let cursor = 0; cursor < index; cursor += 1) if (source[cursor] === "\n") line += 1;
	return line;
}

function importsOf(source) {
	const found = [];
	const code = stripComments(source);
	for (const pattern of PATTERNS) {
		pattern.lastIndex = 0;
		let match;
		while ((match = pattern.exec(code)) !== null) {
			found.push({ specifier: match[1], line: lineOf(code, match.index) });
		}
	}
	return { imports: found, code };
}

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

for (const rule of RULES) {
	const zoneFiles = walk(rule.from);
	zoneCounts[rule.from] = (zoneCounts[rule.from] ?? 0) + zoneFiles.length;
	for (const absolute of zoneFiles) {
		const file = path.relative(ROOT, path.resolve(absolute)).replaceAll("\\", "/");
		const source = readFileSync(absolute, "utf8");
		const { imports, code } = importsOf(source);

		for (const { specifier, line } of imports) {
			if (!isFirstParty(specifier)) continue;
			const target = resolveFirstParty(file, specifier);
			const targetZone = zoneOf(target);
			if (!rule.mayNotImport(targetZone)) continue;
			violations.push(
				`${file}:${line}  imports "${specifier}" (${target})\n`
				+ `    ${rule.explain(target)}`,
			);
		}

		// The unresolvable-dynamic-import rule applies to core/ only: it is the zone
		// whose self-containment has to be provable, and a computed specifier cannot
		// be proved either way.
		if (rule.from !== "core") continue;
		COMPUTED_IMPORT.lastIndex = 0;
		let computed;
		while ((computed = COMPUTED_IMPORT.exec(code)) !== null) {
			// `import.meta` is not a dynamic import; the pattern cannot see the dot.
			if (code.slice(computed.index, computed.index + 12).startsWith("import.meta")) continue;
			violations.push(
				`${file}:${lineOf(code, computed.index)}  dynamic import with a computed specifier\n`
				+ `    Inside core/ every import must be a string literal, because a specifier that is\n`
				+ `    built at runtime cannot be checked against the zone boundary — and a dynamic\n`
				+ `    import is exactly where a boundary violation hid the last time. Use a literal, or\n`
				+ `    take the module as a parameter.`,
			);
		}
	}
}

if (violations.length > 0) {
	console.error(`check-boundaries: ${violations.length} import(s) cross a licence zone boundary.\n`);
	for (const violation of violations) console.error(`${violation}\n`);
	process.exit(1);
}

assertZonesPopulated(zoneCounts, "check-boundaries");

/**
 * Nothing the sandbox image compiles may use the `@core/` or `@app/` aliases, and
 * this is the one rule here whose violation is invisible until production.
 *
 * Everything else in the repository resolves those aliases: Next.js and tsx read
 * `paths` out of tsconfig.json, and vitest.config.ts declares them by hand. So an
 * aliased import in this set typechecks, passes the suite, and looks correct.
 *
 * It then fails in the only place nobody is looking. sandbox/Dockerfile compiles
 * these paths with its own generated tsconfig, which has no `paths`, and the emit
 * runs under bare Node inside the agent image with no node_modules and no
 * resolver. Adding `paths` to that tsconfig does not fix it either — tsc does not
 * rewrite specifiers, so the emit would still say `@core/...` and would still be
 * unresolvable at runtime. Relative is the only thing that survives both steps.
 *
 * The set is read from the Dockerfile's own COPY lines rather than restated here,
 * because a hand-maintained copy drifts the moment somebody adds a directory to
 * the image — which is exactly how this rule was first shipped covering only
 * runtime/ while app/activity was equally affected, and CI caught it rather than
 * the check.
 */
function sandboxCompiledPaths() {
	const dockerfile = path.join(ROOT, "sandbox", "Dockerfile");
	if (!existsSync(dockerfile)) return ["runtime"];
	const copied = [...readFileSync(dockerfile, "utf8").matchAll(/^COPY\s+(\S+)\s+\.\//gm)]
		.map((m) => m[1])
		.filter((p) => /^(runtime|app|core)\b/.test(p));
	return copied.length > 0 ? copied : ["runtime"];
}

const sandboxPaths = sandboxCompiledPaths();
const aliasedRuntime = [];
for (const target of sandboxPaths) {
	const abs = path.join(ROOT, target);
	if (!existsSync(abs)) continue;
	const files = statSync(abs).isDirectory() ? walk(target) : [target];
	for (const absolute of files) {
		// The generated tsconfig excludes tests, so a test file never reaches the
		// image and its specifiers cannot break it. Mirror the Dockerfile's exclude
		// as well as its include, or this reports violations the build cannot have.
		if (/\.test\.(ts|tsx|mts)$/.test(absolute)) continue;
		const file = path.relative(ROOT, path.resolve(absolute)).replaceAll("\\", "/");
		for (const { specifier, line } of importsOf(readFileSync(absolute, "utf8")).imports) {
			if (/^@(core|app)\//.test(specifier)) aliasedRuntime.push(`${file}:${line}  "${specifier}"`);
		}
	}
}

if (aliasedRuntime.length > 0) {
	console.error(
		`check-boundaries: ${aliasedRuntime.length} aliased import(s) inside the sandbox image's `
			+ `compile set (${sandboxPaths.join(", ")}).\n`,
	);
	for (const hit of aliasedRuntime) console.error(`  ${hit}`);
	console.error(
		"\n    These paths are compiled by sandbox/Dockerfile with a tsconfig that has no `paths`,\n"
		+ "    and its emit runs under bare Node with no node_modules. Use a relative specifier\n"
		+ "    (../../core/kernel/config.js). This passes tsc and the test suite either way —\n"
		+ "    the failure only appears inside the sandbox image, at import time.",
	);
	process.exit(1);
}

console.log(
	"check-boundaries: core/ imports nothing outside core/, app/ imports nothing from pilot/,\n"
	+ `                 and the sandbox compile set (${sandboxPaths.join(", ")}) uses no path aliases.`,
);
