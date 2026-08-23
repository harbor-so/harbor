// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Condition filters — the thing that turns "fire on every pull request" into
 * something a team can actually leave switched on.
 *
 * This module is shared by every trigger source, and the sharing is the point.
 * The common failure is to build a perfectly good condition system for scheduled
 * automations and then wire pull-request auto-review as a blunt
 * fire-on-every-PR-open with a per-repository toggle. A repo then either gets
 * agent review on generated migrations, vendored dependencies and one-line typo
 * fixes, or gets none at all — and the team turns it off within a week. Every
 * source getting the same conditions is what prevents that.
 *
 * So: one condition evaluator, used by cron targets, webhook payloads, GitHub
 * events and Slack rules alike.
 */

export const CONDITION_FIELDS = ["branch", "target_branch", "label", "path", "author", "title"] as const;
export type ConditionField = (typeof CONDITION_FIELDS)[number];

export const CONDITION_OPERATORS = ["exact", "glob", "any_of", "none_of", "matches"] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export interface Condition {
	field: ConditionField;
	operator: ConditionOperator;
	/** A single value for exact/glob/matches; a list for any_of/none_of. */
	value: string | string[];
}

/**
 * The facts a trigger source extracts from its payload, normalised.
 *
 * `paths` is a list because a push touches many files and a condition on it means
 * "any of them", which is a different question from the single-valued fields.
 */
export interface ConditionSubject {
	branch?: string | null;
	targetBranch?: string | null;
	labels?: string[];
	paths?: string[];
	author?: string | null;
	title?: string | null;
}

/**
 * Glob matching, deliberately restricted to what a path glob needs.
 *
 * `*` does not cross a `/`, `**` does, `?` is one character. Everything else is
 * escaped. Translating a user-supplied string straight into a RegExp is how a
 * condition field becomes a denial of service: `(a+)+$` in a path filter is a
 * catastrophic backtracking pattern evaluated against every changed path of every
 * push, and the person who typed it was not attacking anyone.
 */
export function globToRegExp(glob: string): RegExp {
	let pattern = "";
	for (let index = 0; index < glob.length; index += 1) {
		const char = glob[index]!;
		if (char === "*") {
			if (glob[index + 1] === "*") {
				// `**/` should also match zero directories, so `**/*.ts` matches `a.ts`.
				if (glob[index + 2] === "/") {
					pattern += "(?:.*/)?";
					index += 2;
				} else {
					pattern += ".*";
					index += 1;
				}
			} else {
				pattern += "[^/]*";
			}
		} else if (char === "?") {
			pattern += "[^/]";
		} else {
			pattern += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${pattern}$`);
}

function valuesFor(subject: ConditionSubject, field: ConditionField): string[] {
	switch (field) {
		case "branch":
			return subject.branch ? [subject.branch] : [];
		case "target_branch":
			return subject.targetBranch ? [subject.targetBranch] : [];
		case "label":
			return subject.labels ?? [];
		case "path":
			return subject.paths ?? [];
		case "author":
			return subject.author ? [subject.author] : [];
		case "title":
			return subject.title ? [subject.title] : [];
		// No default. A field added to CONDITION_FIELDS without an extractor here is
		// a compile error, rather than a condition that silently matches nothing —
		// which reads to the operator as "my filter is too strict" and sends them
		// looking in the wrong place.
	}
}

function asList(value: string | string[]): string[] {
	return Array.isArray(value) ? value : [value];
}

/**
 * Evaluate one condition.
 *
 * The empty-subject case is the one worth thinking about, and the answer differs
 * by operator on purpose:
 *
 *   - A positive condition (`exact`, `glob`, `any_of`, `matches`) on a field the
 *     payload does not carry is FALSE. "Only when the branch is main" must not
 *     fire on an event that has no branch.
 *   - `none_of` on an absent field is TRUE. "Not on these branches" is satisfied
 *     by an event with no branch, and reading it the other way would make a
 *     negative filter block everything it was not written about.
 */
export function evaluate(condition: Condition, subject: ConditionSubject): boolean {
	const actual = valuesFor(subject, condition.field);
	const expected = asList(condition.value);

	switch (condition.operator) {
		case "exact":
			return actual.some((value) => expected.includes(value));
		case "glob": {
			const patterns = expected.map(globToRegExp);
			return actual.some((value) => patterns.some((pattern) => pattern.test(value)));
		}
		case "any_of":
			return actual.some((value) => expected.includes(value));
		case "none_of":
			return !actual.some((value) => expected.includes(value));
		case "matches": {
			// Substring, case-insensitive — not a regular expression, for the same
			// backtracking reason as globToRegExp. A user who wants a regex is a user
			// who can write a glob.
			const needles = expected.map((value) => value.toLowerCase());
			return actual.some((value) =>
				needles.some((needle) => value.toLowerCase().includes(needle)),
			);
		}
		// No default: adding an operator is a compile error here.
	}
}

/**
 * All conditions must hold. AND, not OR.
 *
 * An OR default means adding a second condition makes a trigger fire *more*,
 * which is the opposite of what somebody adding a filter intends. Anyone who
 * genuinely wants OR writes one condition with `any_of`.
 *
 * No conditions means always. An unfiltered trigger is a legitimate thing to
 * want, and making the empty case mean "never" would silently disable every
 * automation created before filters existed.
 */
export function evaluateAll(conditions: Condition[], subject: ConditionSubject): boolean {
	return conditions.every((condition) => evaluate(condition, subject));
}

/** Parse and validate conditions out of an automation's `spec` jsonb. */
export function parseConditions(spec: unknown): Condition[] {
	if (typeof spec !== "object" || spec === null) return [];
	const raw = (spec as { conditions?: unknown }).conditions;
	if (!Array.isArray(raw)) return [];

	const parsed: Condition[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const { field, operator, value } = entry as Record<string, unknown>;
		if (!CONDITION_FIELDS.includes(field as ConditionField)) continue;
		if (!CONDITION_OPERATORS.includes(operator as ConditionOperator)) continue;
		if (typeof value !== "string" && !Array.isArray(value)) continue;
		parsed.push({
			field: field as ConditionField,
			operator: operator as ConditionOperator,
			value: value as string | string[],
		});
	}
	return parsed;
}
