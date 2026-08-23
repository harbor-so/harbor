// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Turning "hey @harbor, the login page is broken" into a repository.
 *
 * The obvious answer is to hand the message, the thread, the channel name and a
 * description of every repository to a fast model and ask it to classify. That
 * works, and we keep it — as the *last* step.
 *
 * It is last for three reasons, and none of them is a dislike of models:
 *
 *  1. **A deployment with no model key configured must still route.** If the
 *     classifier is the only path, then self-hosting Harbor requires an LLM
 *     account before the Slack integration does anything at all, which is a second
 *     vendor relationship bolted onto a product whose pitch is that it needs none.
 *  2. **Most inbound traffic has a deterministic answer.** A channel that is
 *     always about one service, a message that names the repo outright, a team
 *     mapped to a project. Paying a model call and 400ms of latency to rediscover
 *     a mapping somebody already wrote down is waste, and it is waste on the hot
 *     path of every message.
 *  3. **A classifier's confident wrong answer is expensive.** It starts a session
 *     against the wrong repository, and the cost of that is a stranger's branch
 *     with an agent's commits on it. The deterministic paths cannot be confidently
 *     wrong; they either match or they do not.
 *
 * So: explicit → mapping → keyword → classified → ask. And `unknown` is a
 * first-class result rather than an error, because a picker with two buttons is
 * slower exactly once and correct every time.
 */

import { and, eq, isNull } from "drizzle-orm";
import { db } from "@core/schema/index.js";
import { environments, repos } from "@core/schema/schema.js";
import type { RouteConfidence, RouteTarget } from "../contracts/index.js";

/**
 * What a connector knows about where a message came from.
 *
 * `channelRef` and `teamRef` are deliberately opaque strings. Slack calls it a
 * channel, Linear calls it a team, GitHub calls it a repository — the routing
 * logic does not care, and making it care would mean a branch per connector in
 * the one place all connectors share.
 */
export interface RoutingInput {
	orgId: string;
	text: string;
	/** A Slack channel id, a Linear team id, a GitHub repo full name. */
	channelRef?: string | null;
	/** A human-readable name for the same thing, used by keyword rules. */
	channelName?: string | null;
	/** Earlier messages in the thread, oldest first. Context for the classifier. */
	threadContext?: string[];
	/** Connector config: `channelMap`, `keywordRules`. */
	config: Record<string, unknown>;
}

/** A repo or environment Harbor could route to, flattened for matching. */
interface Candidate {
	id: string;
	kind: "repo" | "environment";
	/** `owner/name` for a repo, the name for an environment. */
	slug: string;
	label: string;
	description: string | null;
}

async function candidatesFor(orgId: string): Promise<Candidate[]> {
	const [repoRows, envRows] = await Promise.all([
		db
			.select()
			.from(repos)
			.where(and(eq(repos.orgId, orgId), isNull(repos.archivedAt))),
		db
			.select()
			.from(environments)
			.where(and(eq(environments.orgId, orgId), isNull(environments.archivedAt))),
	]);

	return [
		...repoRows.map((row) => ({
			id: row.id,
			kind: "repo" as const,
			slug: `${row.owner}/${row.name}`,
			label: `${row.owner}/${row.name}`,
			description: row.description,
		})),
		...envRows.map((row) => ({
			id: row.id,
			kind: "environment" as const,
			slug: row.name,
			label: row.name,
			description: row.description,
		})),
	];
}

function asTarget(candidate: Candidate, confidence: RouteConfidence, reason: string): RouteTarget {
	return candidate.kind === "repo"
		? { kind: "repo", repo_id: candidate.id, confidence, reason }
		: { kind: "environment", environment_id: candidate.id, confidence, reason };
}

// ---------------------------------------------------------------------------
// Step 1 — explicit
// ---------------------------------------------------------------------------

/**
 * The user said which one. `in owner/repo`, `repo:owner/name`, `[owner/name]`, or
 * a bare `owner/name` anywhere in the message.
 *
 * Matched first and matched exactly, because a person who took the trouble to
 * name the repository has told us the answer and no amount of inference should be
 * allowed to overrule them. The failure this prevents is the specific and
 * infuriating one where a tool ignores what you typed because its classifier
 * disagreed.
 */
const EXPLICIT_PATTERNS = [
	/\bin\s+([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)/,
	/\brepo:\s*([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)/,
	/\[([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\]/,
	/(?:^|\s)([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)(?:\s|$)/,
];

function matchExplicit(text: string, candidates: Candidate[]): RouteTarget | null {
	for (const pattern of EXPLICIT_PATTERNS) {
		const found = text.match(pattern);
		if (!found?.[1]) continue;
		const slug = found[1].toLowerCase();
		const hit = candidates.find((c) => c.slug.toLowerCase() === slug);
		if (hit) return asTarget(hit, "explicit", `the message named ${hit.label}`);
	}

	// An environment named outright, e.g. "in staging". Checked after repository
	// slugs because `owner/name` is unambiguous and a bare word is not.
	const words: string[] = text.toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) ?? [];
	for (const candidate of candidates) {
		if (candidate.kind !== "environment") continue;
		if (words.includes(candidate.slug.toLowerCase())) {
			return asTarget(candidate, "explicit", `the message named the ${candidate.label} environment`);
		}
	}

	return null;
}

// ---------------------------------------------------------------------------
// Step 2 — mapping
// ---------------------------------------------------------------------------

/**
 * An operator said "this channel is always about that repo".
 *
 * Stored on the connector as `channelMap: { "<channelRef>": {kind, id} }`. This is
 * the highest-value routing path in practice, because most teams already organise
 * their chat by service and the mapping is written once.
 */
function matchMapping(input: RoutingInput, candidates: Candidate[]): RouteTarget | null {
	if (!input.channelRef) return null;
	const map = input.config.channelMap;
	if (typeof map !== "object" || map === null) return null;

	const entry = (map as Record<string, unknown>)[input.channelRef];
	if (typeof entry !== "object" || entry === null) return null;
	const { kind, id } = entry as { kind?: unknown; id?: unknown };
	if (typeof id !== "string" || (kind !== "repo" && kind !== "environment")) return null;

	// Resolved against live candidates rather than trusted directly: a mapping can
	// outlive the repository it points at, and routing a session to a deleted repo
	// fails deep inside the sandbox boot where the error is least legible.
	const hit = candidates.find((c) => c.id === id && c.kind === kind);
	if (!hit) return null;
	return asTarget(hit, "mapping", `${input.channelName ?? input.channelRef} is mapped to ${hit.label}`);
}

// ---------------------------------------------------------------------------
// Step 3 — keywords
// ---------------------------------------------------------------------------

/**
 * Operator-written rules: "if the message mentions checkout, it is the payments repo".
 *
 * Stored as `keywordRules: [{ match: string[], kind, id }]`. Deliberately requires
 * a rule to be written rather than inferring keywords from repository names — an
 * inferred rule matching the word "api" in a message about an unrelated API is a
 * wrong answer produced by a mechanism nobody chose.
 */
function matchKeywords(input: RoutingInput, candidates: Candidate[]): RouteTarget | null {
	const rules = input.config.keywordRules;
	if (!Array.isArray(rules)) return null;
	const haystack = ` ${input.text.toLowerCase()} `;

	for (const rule of rules) {
		if (typeof rule !== "object" || rule === null) continue;
		const { match, kind, id } = rule as { match?: unknown; kind?: unknown; id?: unknown };
		if (!Array.isArray(match) || typeof id !== "string") continue;
		if (kind !== "repo" && kind !== "environment") continue;

		const hitWord = match.find(
			(word) => typeof word === "string" && haystack.includes(` ${word.toLowerCase()} `),
		);
		if (!hitWord) continue;

		const hit = candidates.find((c) => c.id === id && c.kind === kind);
		if (hit) return asTarget(hit, "keyword", `the message mentioned "${String(hitWord)}"`);
	}

	return null;
}

// ---------------------------------------------------------------------------
// Step 4 — the classifier
// ---------------------------------------------------------------------------

/**
 * Only reached when nothing deterministic matched, and only when a key exists.
 *
 * Two properties matter more than accuracy here:
 *
 *  - **`unknown` is an explicit option in the prompt.** A classifier without an
 *    escape hatch always picks something, and the thing it picks when it has no
 *    idea is indistinguishable from the thing it picks when it is certain.
 *  - **A failure returns `unknown`, never a guess.** A timeout, a rate limit or a
 *    malformed response falls through to the picker. Routing is authority, not
 *    liveness: when we cannot determine the answer we must not assume one.
 */
async function classify(input: RoutingInput, candidates: Candidate[]): Promise<RouteTarget | null> {
	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (!apiKey || candidates.length === 0) return null;

	const catalogue = candidates
		.map((c) => `- ${c.kind}:${c.id} — ${c.label}${c.description ? ` — ${c.description}` : ""}`)
		.join("\n");

	const thread = (input.threadContext ?? []).slice(-5).join("\n");

	const prompt = [
		"Route this message to exactly one repository or environment, or answer unknown.",
		"",
		`Channel: ${input.channelName ?? "(unknown)"}`,
		thread ? `Earlier in the thread:\n${thread}\n` : "",
		`Message: ${input.text}`,
		"",
		"Options:",
		catalogue,
		"",
		'Answer with exactly one line: either `repo:<id>`, `environment:<id>`, or `unknown`.',
		"Answer `unknown` whenever you are not confident. Being asked is cheap; starting",
		"an agent against the wrong repository is not.",
	].join("\n");

	try {
		const response = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: {
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: process.env.HARBOR_ROUTER_MODEL ?? "claude-haiku-4-5-20251001",
				max_tokens: 32,
				messages: [{ role: "user", content: prompt }],
			}),
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) return null;

		const body = (await response.json()) as { content?: Array<{ text?: string }> };
		const answer = body.content?.[0]?.text?.trim().toLowerCase() ?? "";
		const parsed = answer.match(/^(repo|environment):([0-9a-f-]{36})$/);
		if (!parsed) return null;

		const hit = candidates.find((c) => c.kind === parsed[1] && c.id === parsed[2]);
		if (!hit) return null;
		return asTarget(hit, "classified", "classified from the message and thread");
	} catch {
		// A model that timed out has told us nothing. Falling through to the picker
		// is the only safe reading of silence.
		return null;
	}
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

export async function resolveTarget(input: RoutingInput): Promise<RouteTarget> {
	const candidates = await candidatesFor(input.orgId);

	if (candidates.length === 0) {
		return { kind: "unknown", candidates: [] };
	}

	// Exactly one option is not a routing problem. Asking anyway is the kind of
	// pedantry that makes a tool feel hostile on its first day, when a new
	// deployment has connected precisely one repository.
	if (candidates.length === 1) {
		return asTarget(candidates[0]!, "mapping", "the only connected repository");
	}

	const deterministic =
		matchExplicit(input.text, candidates) ??
		matchMapping(input, candidates) ??
		matchKeywords(input, candidates);
	if (deterministic) return deterministic;

	const classified = await classify(input, candidates);
	if (classified) return classified;

	return {
		kind: "unknown",
		candidates: candidates.slice(0, 25).map((c) => ({ id: c.id, kind: c.kind, label: c.label })),
	};
}

/** Exported for tests: the deterministic half, with no network and no model. */
export const _internals = { matchExplicit, matchMapping, matchKeywords, candidatesFor };
