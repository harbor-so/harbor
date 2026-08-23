// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * What a token costs, and — more importantly — *which price list said so*.
 *
 * Prices change. They changed twice while this file was being written. A cost
 * row that records `$0.42` and nothing else cannot be recomputed, audited, or
 * corrected: six months later nobody can tell whether that number came from the
 * list in force at the time, from a list that was already stale, or from a
 * fabrication. So every priced row carries `pricingVersion`, and the version is
 * enough on its own to reproduce the arithmetic.
 *
 * That requirement is why this table deliberately does **not** encode
 * time-varying prices. Anthropic's Sonnet 5 has an introductory rate that
 * expires on a date; encoding "cheap until 2026-08-31, then dearer" would mean a
 * row stamped `2026-06-24` no longer determines its own price — you would also
 * need the row's timestamp and the expiry rules, and the version would be a lie.
 * When an introductory rate ends, or any price moves, the answer is a **new
 * PRICING_VERSION with new numbers**, and old rows keep meaning what they meant.
 *
 * The second rule this file enforces: **an unknown model is priced at zero and
 * marked unpriced. It is never guessed.** A fabricated number in a spend report
 * is worse than a visible gap, because a gap prompts somebody to go and find the
 * real figure, whereas a plausible-looking wrong number gets spent against. This
 * is the same discipline as `AgentUsage.source: "unavailable"` in the wire
 * contract, applied one layer down.
 *
 * Money is integer micro-USD everywhere. There are no floats in this file's
 * output. Prices are stored per *million* tokens precisely so that the table
 * itself stays integral: Haiku input is $1.00/MTok, which is 1 micro-USD per
 * token, but Claude Haiku 3 input is $0.25/MTok, which is a quarter of a
 * micro-USD per token and has no integer representation at all. Per-million is
 * the smallest unit in which every published price is a whole number.
 */

// ---------------------------------------------------------------------------
// Exhaustiveness
// ---------------------------------------------------------------------------

/**
 * The `never` assertion used by every exhaustive switch in the cost subsystem.
 *
 * It lives in this module rather than in `cost.ts` because `cost.ts` imports
 * `pricing.ts` and not the other way round. Putting it in the consumer would
 * mean an import cycle, and an ESM cycle between two modules that both run code
 * at import time fails at *runtime*, in production, with a TDZ error that names
 * neither file usefully.
 *
 * Calling it is a compile error unless every case is handled, so adding a status
 * or a reason breaks the build at each decision point instead of silently
 * falling through to whatever the last branch happened to do.
 */
export function assertNever(value: never, context: string): never {
	throw new Error(`${context}: unhandled variant ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------------------
// The price list
// ---------------------------------------------------------------------------

/**
 * The identifier stamped on every row this module prices.
 *
 * Format is the date the list was taken from the providers' published pricing.
 * It is not a semver: a version here answers "which numbers were in the table",
 * and a date answers that better than a counter nobody can map back to a day.
 *
 * Changing any number below **requires** changing this string in the same
 * commit. A table edited without a version bump makes two rows stamped
 * identically that were priced differently, which is exactly the un-auditable
 * state the stamp exists to prevent.
 */
export const PRICING_VERSION = "2026-06-24";

/**
 * Marker stamped in place of a version when nothing priced the row.
 *
 * Deliberately a distinct sentinel rather than an empty string or null, because
 * the stamp is stored inside a text column and "" is indistinguishable from a
 * write that lost the field.
 */
export const UNPRICED_STAMP = "unpriced";

export type PricingProvider = "anthropic" | "openai";

/**
 * One model's published prices, in micro-USD per million tokens.
 *
 * `cacheWritePerMillion: 0` is a *fact*, not a gap: OpenAI does not bill for
 * writing to its prompt cache. Anthropic does (1.25x input at the 5-minute TTL).
 * The difference is why this is an explicit number per model rather than a
 * multiplier applied in code — a multiplier would have to encode "except on
 * OpenAI", and that exception would rot the first time a provider changes it.
 */
export interface ModelPrice {
	provider: PricingProvider;
	inputPerMillion: number;
	outputPerMillion: number;
	/** Reading a cached prefix. Both providers discount this heavily. */
	cacheReadPerMillion: number;
	/** Writing a cache entry. Zero where the provider does not bill for it. */
	cacheWritePerMillion: number;
}

const dollarsPerMillion = (usd: number): number => Math.round(usd * 1_000_000);

const anthropic = (inputUsd: number, outputUsd: number): ModelPrice => ({
	provider: "anthropic",
	inputPerMillion: dollarsPerMillion(inputUsd),
	outputPerMillion: dollarsPerMillion(outputUsd),
	// 0.1x input for a cache read and 1.25x input for a five-minute cache write,
	// both published as multipliers of the model's own input rate rather than as
	// separate numbers. Derived here so that a model whose input price moves
	// cannot end up with a cache price from the previous list.
	cacheReadPerMillion: dollarsPerMillion(inputUsd * 0.1),
	cacheWritePerMillion: dollarsPerMillion(inputUsd * 1.25),
});

const openai = (inputUsd: number, cachedInputUsd: number, outputUsd: number): ModelPrice => ({
	provider: "openai",
	inputPerMillion: dollarsPerMillion(inputUsd),
	outputPerMillion: dollarsPerMillion(outputUsd),
	cacheReadPerMillion: dollarsPerMillion(cachedInputUsd),
	// Not a missing value. OpenAI does not charge to populate the cache.
	cacheWritePerMillion: 0,
});

/**
 * Model id → price. Not a tunable, so it is not in `src/config.ts`.
 *
 * The distinction matters and is worth stating plainly, because the rule against
 * module-level constants is otherwise easy to read as absolute: `src/config.ts`
 * holds numbers an *operator* may legitimately want different — timeouts,
 * thresholds, caps. This table holds numbers a *vendor* publishes. An operator
 * who edits Anthropic's output price does not change what they are billed; they
 * only make their own report wrong. It is data with a version stamp, and it
 * belongs in code where a diff reviews it.
 *
 * Ids are exactly the strings the providers accept, with no date suffixes on the
 * aliases — see `normalizeModelId` for how dated snapshots and Bedrock/Vertex
 * spellings are folded onto these keys.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
	// -- Anthropic ----------------------------------------------------------
	"claude-fable-5": anthropic(10, 50),
	"claude-mythos-5": anthropic(10, 50),
	"claude-opus-5": anthropic(5, 25),
	"claude-opus-4-8": anthropic(5, 25),
	"claude-opus-4-7": anthropic(5, 25),
	"claude-opus-4-6": anthropic(5, 25),
	"claude-opus-4-5": anthropic(5, 25),
	"claude-opus-4-1": anthropic(15, 75),
	"claude-opus-4-0": anthropic(15, 75),
	// Standard rate. Sonnet 5 carries an introductory $2/$10 through 2026-08-31;
	// see the file header for why the discount is not encoded here. An operator
	// who wants the introductory rate reflected in their own reports takes a new
	// PRICING_VERSION with those numbers, which keeps every row reproducible.
	"claude-sonnet-5": anthropic(3, 15),
	"claude-sonnet-4-6": anthropic(3, 15),
	"claude-sonnet-4-5": anthropic(3, 15),
	"claude-sonnet-4-0": anthropic(3, 15),
	"claude-haiku-4-5": anthropic(1, 5),
	"claude-3-haiku-20240307": anthropic(0.25, 1.25),

	// -- OpenAI -------------------------------------------------------------
	"gpt-5": openai(1.25, 0.125, 10),
	"gpt-5-codex": openai(1.25, 0.125, 10),
	"gpt-5-mini": openai(0.25, 0.025, 2),
	"gpt-5-nano": openai(0.05, 0.005, 0.4),
	"gpt-4.1": openai(2, 0.5, 8),
	"gpt-4.1-mini": openai(0.4, 0.1, 1.6),
	"gpt-4.1-nano": openai(0.1, 0.025, 0.4),
	"gpt-4o": openai(2.5, 1.25, 10),
	"gpt-4o-mini": openai(0.15, 0.075, 0.6),
	o3: openai(2, 0.5, 8),
	"o3-mini": openai(1.1, 0.55, 4.4),
	"o4-mini": openai(1.1, 0.275, 4.4),
};

/**
 * Fold a provider-specific spelling onto a key in the table above.
 *
 * The same model reaches Harbor under at least four names: the plain alias
 * (`claude-opus-5`), a dated snapshot (`claude-haiku-4-5-20251001`), a Bedrock
 * id with a region and vendor prefix (`us.anthropic.claude-opus-5`), and a
 * Vertex id with an `@`-separated version (`claude-opus-4-5@20251101`). An agent
 * running against Bedrock would otherwise report every single turn as an unknown
 * model, and a spend report that is 100% "unpriced" is not a gap anyone can act
 * on — it just looks broken.
 *
 * Every transformation here is *removal of decoration*, never substitution. A
 * dated snapshot of a known alias is the same model at the same price. Nothing
 * maps a name onto a *different* model, because that is how you end up billing
 * Haiku traffic at Opus rates and never noticing.
 */
export function normalizeModelId(raw: string): string | null {
	const trimmed = raw.trim();
	if (trimmed === "") return null;
	if (MODEL_PRICES[trimmed]) return trimmed;

	let id = trimmed.toLowerCase();

	// Router and gateway prefixes: `anthropic/claude-opus-5`, `openai/gpt-5`.
	const slash = id.lastIndexOf("/");
	if (slash >= 0) id = id.slice(slash + 1);

	// Bedrock: `us.anthropic.claude-opus-5`, `eu.anthropic.…`.
	const vendor = id.indexOf("anthropic.");
	if (vendor >= 0) id = id.slice(vendor + "anthropic.".length);

	// Vertex: `claude-opus-4-5@20251101`.
	const at = id.indexOf("@");
	if (at >= 0) id = id.slice(0, at);

	if (MODEL_PRICES[id]) return id;

	// Dated snapshot of an alias: `claude-haiku-4-5-20251001`. Only accepted when
	// stripping the date lands on a key that actually exists; a trailing eight
	// digits on an unknown model stays unknown.
	const dated = id.replace(/-\d{8}$/, "");
	if (dated !== id && MODEL_PRICES[dated]) return dated;

	return null;
}

/** The price for a model, or null. Null is a real answer, not a failure. */
export function lookupPrice(model: string | null | undefined): ModelPrice | null {
	if (!model) return null;
	const id = normalizeModelId(model);
	return id ? (MODEL_PRICES[id] ?? null) : null;
}

// ---------------------------------------------------------------------------
// Pricing a turn
// ---------------------------------------------------------------------------

export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
}

/**
 * Why a row could not be priced. Typed, because these are not the same problem.
 *
 * `unknown_model` means the price list is behind the world and somebody should
 * add a row to the table. `no_model_reported` means the *adapter* lost the model
 * name and the bug is upstream in the integration. `usage_unavailable` means the
 * agent never told us how many tokens it used, which is a known and accepted
 * state for some runtimes. `invalid_usage` means a negative or non-finite count
 * arrived, which is a corrupt payload, not a gap.
 *
 * Collapsing these into a boolean `unpriced` would make the first two — one a
 * five-minute table edit, the other a real integration bug — indistinguishable
 * in the one place anybody would ever look for them.
 */
export const UNPRICED_REASONS = [
	"unknown_model",
	"no_model_reported",
	"usage_unavailable",
	"invalid_usage",
] as const;
export type UnpricedReason = (typeof UNPRICED_REASONS)[number];

export type PriceQuote =
	| {
			priced: true;
			microUsd: number;
			pricingVersion: string;
			/** The normalized id the price came from, not the raw string. */
			model: string;
			/**
			 * Null on the one path where a row is priced without this table having
			 * priced it: the agent reported its own money for a model the table does
			 * not know. Naming a provider there would mean inferring one from the
			 * shape of the model string, and a spend-by-provider report built on that
			 * inference is a guess wearing a fact's clothes.
			 */
			provider: PricingProvider | null;
	  }
	| {
			priced: false;
			microUsd: 0;
			/** Which list *failed* to price it — needed to know when to re-try. */
			pricingVersion: string;
			model: string | null;
			provider: null;
			reason: UnpricedReason;
	  };

/** Human-readable, and exhaustive so a new reason is a compile error here. */
export function describeUnpriced(reason: UnpricedReason): string {
	switch (reason) {
		case "unknown_model":
			return `not in price list ${PRICING_VERSION}; add it to MODEL_PRICES to price this row`;
		case "no_model_reported":
			return "the agent adapter reported usage without a model name";
		case "usage_unavailable":
			return "the agent reported no token counts for this turn";
		case "invalid_usage":
			return "token counts were negative or not finite";
	}
	return assertNever(reason, "describeUnpriced");
}

/**
 * tokens x price-per-million, in exact integer arithmetic.
 *
 * BigInt, and not because the answer is large. `tokens * perMillion` is the
 * intermediate: a million-token context at Opus output rates is 1e6 * 2.5e7 =
 * 2.5e13, which is fine, but a caller passing a bogus billion-token count
 * produces 2.5e16 — past `Number.MAX_SAFE_INTEGER`, where float64 silently
 * starts rounding to even. The failure mode is not a crash; it is a spend report
 * that is quietly off by dollars and cannot be reconciled against the invoice.
 *
 * Rounding is half-up rather than truncating. Truncation loses up to one
 * micro-USD per row and always in the same direction, so across a few million
 * rows an org systematically under-counts its own spend and blows through a cap
 * it believes it is under.
 */
function microUsdForTokens(tokens: number, perMillion: number): number {
	if (tokens <= 0 || perMillion <= 0) return 0;
	const product = BigInt(Math.round(tokens)) * BigInt(perMillion);
	const rounded = (product + 500_000n) / 1_000_000n;
	return Number(rounded);
}

/** True for a count we are willing to multiply by money. */
function isSaneCount(value: number | undefined): boolean {
	if (value === undefined) return true;
	return Number.isFinite(value) && value >= 0;
}

/**
 * Price one turn's tokens.
 *
 * Cache reads and cache writes are priced separately and are *not* folded into
 * `inputTokens`, because both providers bill them at rates that differ from
 * input by an order of magnitude in opposite directions. Treating a cache read
 * as an input token overstates spend tenfold on exactly the workload — a long
 * agent session re-sending its whole context — that Harbor runs most of.
 */
export function priceTokens(model: string | null | undefined, usage: TokenUsage): PriceQuote {
	if (!model) {
		return {
			priced: false,
			microUsd: 0,
			pricingVersion: PRICING_VERSION,
			model: null,
			provider: null,
			reason: "no_model_reported",
		};
	}

	if (
		!isSaneCount(usage.inputTokens)
		|| !isSaneCount(usage.outputTokens)
		|| !isSaneCount(usage.cacheReadTokens)
		|| !isSaneCount(usage.cacheWriteTokens)
	) {
		return {
			priced: false,
			microUsd: 0,
			pricingVersion: PRICING_VERSION,
			model,
			provider: null,
			reason: "invalid_usage",
		};
	}

	const id = normalizeModelId(model);
	const price = id ? MODEL_PRICES[id] : undefined;
	if (!id || !price) {
		return {
			priced: false,
			microUsd: 0,
			pricingVersion: PRICING_VERSION,
			model,
			provider: null,
			reason: "unknown_model",
		};
	}

	const microUsd =
		microUsdForTokens(usage.inputTokens, price.inputPerMillion)
		+ microUsdForTokens(usage.outputTokens, price.outputPerMillion)
		+ microUsdForTokens(usage.cacheReadTokens ?? 0, price.cacheReadPerMillion)
		+ microUsdForTokens(usage.cacheWriteTokens ?? 0, price.cacheWritePerMillion);

	return {
		priced: true,
		microUsd,
		pricingVersion: PRICING_VERSION,
		model: id,
		provider: price.provider,
	};
}

/**
 * Price what an agent adapter reported, honouring the adapter when it knows.
 *
 * `AgentUsage` documents the adapter as authoritative for money when it reports
 * money, and this respects that: an agent that hands back its own `micro_usd`
 * has seen the provider's own accounting for that call, including discounts,
 * negotiated rates and batch pricing that this table cannot know about. Re-
 * pricing it from the table would replace a real figure with an estimate that
 * disagrees with the invoice.
 *
 * The stamp on that path is `agent_reported`, not `PRICING_VERSION`, because
 * claiming this list produced a number it did not produce is precisely the
 * un-auditable state the stamp exists to prevent.
 */
export const AGENT_REPORTED_STAMP = "agent_reported";

export function priceAgentUsage(usage: {
	source: "agent_reported" | "unavailable";
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens?: number;
	cache_write_tokens?: number;
	model: string | null;
	micro_usd?: number;
}): PriceQuote {
	if (usage.source === "unavailable") {
		return {
			priced: false,
			microUsd: 0,
			pricingVersion: PRICING_VERSION,
			model: usage.model,
			provider: null,
			reason: "usage_unavailable",
		};
	}

	if (usage.micro_usd !== undefined && Number.isFinite(usage.micro_usd) && usage.micro_usd >= 0) {
		const id = usage.model ? normalizeModelId(usage.model) : null;
		const price = id ? MODEL_PRICES[id] : undefined;
		return {
			priced: true,
			microUsd: Math.round(usage.micro_usd),
			pricingVersion: AGENT_REPORTED_STAMP,
			model: id ?? usage.model ?? "unknown",
			// Only if the table actually knows the model. Never inferred from the
			// name's shape — see the field's own comment.
			provider: price?.provider ?? null,
		};
	}

	return priceTokens(usage.model, {
		inputTokens: usage.input_tokens,
		outputTokens: usage.output_tokens,
		cacheReadTokens: usage.cache_read_tokens,
		cacheWriteTokens: usage.cache_write_tokens,
	});
}

// ---------------------------------------------------------------------------
// Stamping the version onto a row
// ---------------------------------------------------------------------------

/**
 * Pack `model` and `pricingVersion` into the one text column the schema has.
 *
 * `cost_events` has `model` but no `pricing_version`, and the schema is frozen
 * for this change. The alternatives were all worse: a parallel table doubles
 * every write and makes the anti-join in `cost.ts` a three-way; jsonb was
 * explicitly ruled out; and dropping the version means the rows cannot be
 * recomputed, which defeats the purpose of pricing them at all.
 *
 * So the version rides in the same column, after an `@`. No model id published
 * by either provider contains an `@` except Vertex's version separator, which
 * `normalizeModelId` has already removed by the time anything is stamped, so the
 * delimiter is unambiguous. `decodeModelStamp` splits on the *last* `@` anyway.
 *
 * A row with no `@` at all decodes as unpriced with a null version — that is the
 * honest reading of a row written before this scheme existed, or by hand.
 */
export function stampModel(model: string | null, quote: PriceQuote): string | null {
	const name = quote.priced ? quote.model : (model ?? quote.model);
	if (!name) return null;
	if (quote.priced) return `${name}@${quote.pricingVersion}`;
	return `${name}@${UNPRICED_STAMP}:${quote.pricingVersion}`;
}

export interface DecodedModel {
	model: string;
	/** Null when the row predates stamping, i.e. its price cannot be reproduced. */
	pricingVersion: string | null;
	unpriced: boolean;
}

export function decodeModelStamp(value: string | null): DecodedModel | null {
	if (value === null || value === "") return null;
	const at = value.lastIndexOf("@");
	if (at < 0) return { model: value, pricingVersion: null, unpriced: true };

	const model = value.slice(0, at);
	const suffix = value.slice(at + 1);
	if (suffix.startsWith(`${UNPRICED_STAMP}:`)) {
		return {
			model,
			pricingVersion: suffix.slice(UNPRICED_STAMP.length + 1) || null,
			unpriced: true,
		};
	}
	return { model, pricingVersion: suffix || null, unpriced: false };
}
