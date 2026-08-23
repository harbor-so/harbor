// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * What to install when a repository has no `.harbor/setup.sh`.
 *
 * ## Why this exists
 *
 * Harbor's boot runs `.harbor/setup.sh` if it is there and silently skips it if
 * it is not. That is a defensible contract and it has one expensive
 * consequence: **every repository needs a hook written for it before an agent
 * can run its tests.** For a JavaScript monorepo that hook is, ninety-five times
 * out of a hundred, the single line `pnpm install`. Requiring a human to write
 * that line, commit it, and get it reviewed — per repository, before the first
 * prompt — is the whole onboarding cost of the product, and it is paid on
 * exactly the repositories where the answer was obvious.
 *
 * So: when the hook is absent, detect the package manager and install. When the
 * hook is present, **it wins, completely** — no merging, no "we also ran npm
 * install first". A repository that took the trouble to describe its own setup
 * is a repository whose author knew something this file does not.
 *
 * ## Why it is a pure function
 *
 * Same reason as `boot-decisions.ts`. Detection is a pile of precedence rules
 * over a directory listing, and precedence rules embedded in a supervisor are
 * rules nobody can test without booting a container. Here the input is an array
 * of filenames and the output is a command, so every rule below is one line in a
 * unit test.
 *
 * ## The precedence, and why it is lockfile-first
 *
 * A lockfile is *evidence of what was actually used*; a manifest field is a
 * statement of intent that may predate three migrations. A repository with both
 * `package-lock.json` and `pnpm-lock.yaml` has been through a migration whose
 * cleanup was incomplete, and the honest reading is ambiguous — so that case
 * refuses rather than guessing, and says which files disagree. Guessing there
 * produces a `node_modules` built by the wrong tool, which fails later, deeper,
 * and with an error about a missing binary rather than about a lockfile.
 */

/** The ecosystems auto-setup can handle. Closed on purpose — see `describe`. */
export const PACKAGE_MANAGERS = [
	"pnpm",
	"yarn",
	"bun",
	"npm",
	"uv",
	"poetry",
	"pipenv",
	"pip",
	"go",
	"cargo",
	"bundler",
] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

export type Detection =
	| { kind: "detected"; manager: PackageManager; command: string[]; evidence: string }
	| { kind: "none"; reason: string }
	| { kind: "ambiguous"; candidates: PackageManager[]; evidence: string[]; reason: string };

/**
 * One rule: the file that proves it, the manager it proves, and the install.
 *
 * Order is precedence. Within an ecosystem the lockfile comes before the
 * manifest; across ecosystems the more specific tool comes before the fallback,
 * which is why `pnpm-lock.yaml` outranks `package.json`.
 */
interface Rule {
	manager: PackageManager;
	file: string;
	command: string[];
	/** Ecosystem, so two rules in the same one are precedence rather than conflict. */
	ecosystem: "node" | "python" | "go" | "rust" | "ruby";
}

const RULES: readonly Rule[] = [
	// Node. `--frozen-lockfile` / `ci` rather than a plain install: a boot that
	// silently updates the lockfile has changed the repository before the agent
	// has read a line of it, and the diff turns up in somebody's pull request.
	{ manager: "pnpm", file: "pnpm-lock.yaml", command: ["pnpm", "install", "--frozen-lockfile"], ecosystem: "node" },
	{ manager: "bun", file: "bun.lockb", command: ["bun", "install", "--frozen-lockfile"], ecosystem: "node" },
	{ manager: "bun", file: "bun.lock", command: ["bun", "install", "--frozen-lockfile"], ecosystem: "node" },
	{ manager: "yarn", file: "yarn.lock", command: ["yarn", "install", "--immutable"], ecosystem: "node" },
	{ manager: "npm", file: "package-lock.json", command: ["npm", "ci"], ecosystem: "node" },

	// Python.
	{ manager: "uv", file: "uv.lock", command: ["uv", "sync"], ecosystem: "python" },
	{ manager: "poetry", file: "poetry.lock", command: ["poetry", "install"], ecosystem: "python" },
	{ manager: "pipenv", file: "Pipfile.lock", command: ["pipenv", "install", "--deploy"], ecosystem: "python" },

	// Go, Rust, Ruby. One rule each: these ecosystems settled on one tool.
	{ manager: "go", file: "go.sum", command: ["go", "mod", "download"], ecosystem: "go" },
	{ manager: "cargo", file: "Cargo.lock", command: ["cargo", "fetch"], ecosystem: "rust" },
	{ manager: "bundler", file: "Gemfile.lock", command: ["bundle", "install"], ecosystem: "ruby" },
];

/**
 * Manifests, used only when no lockfile in that ecosystem was found.
 *
 * A manifest with no lockfile means dependencies are unpinned, so the install
 * cannot be frozen — `npm install` rather than `npm ci`. That is a weaker
 * guarantee and it is the repository's choice, not ours to override.
 */
const MANIFEST_RULES: readonly Rule[] = [
	{ manager: "npm", file: "package.json", command: ["npm", "install"], ecosystem: "node" },
	{ manager: "uv", file: "pyproject.toml", command: ["uv", "sync"], ecosystem: "python" },
	{ manager: "pip", file: "requirements.txt", command: ["pip", "install", "-r", "requirements.txt"], ecosystem: "python" },
	{ manager: "go", file: "go.mod", command: ["go", "mod", "download"], ecosystem: "go" },
	{ manager: "cargo", file: "Cargo.toml", command: ["cargo", "fetch"], ecosystem: "rust" },
	{ manager: "bundler", file: "Gemfile", command: ["bundle", "install"], ecosystem: "ruby" },
];

/**
 * Decide what to install from a directory listing.
 *
 * `entries` is the repository root, not a recursive walk. A monorepo's inner
 * packages are the root tool's problem — `pnpm install` at the root installs the
 * workspace — and walking would turn a bounded decision into an unbounded one on
 * exactly the repositories where boot time already matters most.
 */
export function detectPackageManager(entries: readonly string[]): Detection {
	const present = new Set(entries);

	const lockHits = RULES.filter((rule) => present.has(rule.file));

	// Two different NODE lockfiles is the migration-gone-wrong case. Two
	// different ECOSYSTEMS is not ambiguity at all — a Go service with a
	// JavaScript dashboard is one repository with two real answers, and picking
	// the first is a partial install, which is worse than saying so.
	const ecosystems = new Set(lockHits.map((rule) => rule.ecosystem));
	const managers = [...new Set(lockHits.map((rule) => rule.manager))];

	if (managers.length > 1) {
		return {
			kind: "ambiguous",
			candidates: managers,
			evidence: lockHits.map((rule) => rule.file),
			reason:
				ecosystems.size > 1
					? `This repository has lockfiles for more than one ecosystem (${lockHits
							.map((rule) => rule.file)
							.join(", ")}). Installing one of them would leave the others missing, so `
						+ "Harbor installed nothing. Write .harbor/setup.sh saying what this "
						+ "repository actually needs."
					: `This repository has ${lockHits.map((rule) => rule.file).join(" and ")}, which `
						+ "name different package managers. That usually means a migration whose "
						+ "cleanup is incomplete. Harbor will not guess, because the wrong one "
						+ "produces a dependency tree that fails much later with an error about a "
						+ "missing binary. Delete the stale lockfile, or write .harbor/setup.sh.",
		};
	}

	const lock = lockHits[0];
	if (lock) {
		return {
			kind: "detected",
			manager: lock.manager,
			command: [...lock.command],
			evidence: lock.file,
		};
	}

	const manifestHits = MANIFEST_RULES.filter((rule) => present.has(rule.file));
	const manifestManagers = [...new Set(manifestHits.map((rule) => rule.manager))];
	if (manifestManagers.length > 1) {
		return {
			kind: "ambiguous",
			candidates: manifestManagers,
			evidence: manifestHits.map((rule) => rule.file),
			reason:
				`This repository has ${manifestHits.map((rule) => rule.file).join(", ")} and no `
				+ "lockfile to break the tie. Write .harbor/setup.sh saying what to install.",
		};
	}

	const manifest = manifestHits[0];
	if (manifest) {
		return {
			kind: "detected",
			manager: manifest.manager,
			command: [...manifest.command],
			evidence: manifest.file,
		};
	}

	return {
		kind: "none",
		reason:
			"No lockfile or manifest Harbor recognises is present at the repository root, so "
			+ "there was nothing to install. If this repository does need a setup step, put it "
			+ "in .harbor/setup.sh.",
	};
}

/**
 * The files whose contents define this repository's dependency set.
 *
 * Kept next to the rules it is derived from, because the failure mode of a
 * separate list is that somebody adds a package manager here and the hash keeps
 * being computed over the old files — which does not break anything visibly, it
 * just stops noticing changes. Used by the image pipeline to decide whether a
 * rebuild would produce anything different.
 */
export function dependencyFiles(entries: readonly string[]): string[] {
	const present = new Set(entries);
	return [...RULES, ...MANIFEST_RULES]
		.map((rule) => rule.file)
		.filter((file, index, all) => all.indexOf(file) === index)
		.filter((file) => present.has(file));
}

/** A one-line description for a boot event, and for the warning when it fails. */
export function describe(detection: Detection): string {
	switch (detection.kind) {
		case "detected":
			return `${detection.evidence} → ${detection.command.join(" ")}`;
		case "none":
			return "nothing recognised";
		case "ambiguous":
			return `ambiguous (${detection.evidence.join(", ")})`;
	}
	// Exhaustive over the union; a new arm is a compile error here rather than a
	// silent empty string in a boot event.
	const unreachable: never = detection;
	throw new Error(`unhandled detection: ${JSON.stringify(unreachable)}`);
}
