// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Spend accounting, and the one thing about it that is genuinely hard:
 * **the budget check has to be atomic with admission.**
 *
 * The naive cap reads today's spend, compares it to the limit, and then admits
 * the work. Under any concurrency at all that is a lost-update race with money
 * on the other side of it. Twenty automations firing on the same cron tick all
 * read "$4 spent, cap is $50", all conclude they have room, and all start; the
 * org wakes up to $200 of spend against a $50 cap and a log full of decisions
 * that were each individually correct. This is not a theoretical race. Every
 * amplification path in Harbor — child sessions, automations, sandbox warming,
 * periodic image rebuilds — is a loop with no human in it that fires many
 * requests at the same instant, which is precisely the shape that loses this
 * race every time.
 *
 * So `reserveBudget` does the read and the write in one transaction, behind a
 * per-org advisory lock, and the *reservation row it inserts is what makes the
 * next caller's read return a bigger number*. Two concurrent callers serialise:
 * the second one sees the first one's reservation and refuses. That is the whole
 * design, and the 20-concurrent-callers-against-a-cap-of-5 test is the only
 * proof of it that is worth anything.
 *
 * Four further decisions are load-bearing:
 *
 *  1. **UTC days.** The daily window is midnight-to-midnight UTC, everywhere,
 *     with no local-time option. A local boundary means the cap resets at a
 *     different instant for each deployment, two operators in different offices
 *     running the same report get different totals and neither is wrong, and a
 *     "today" that shifts under a DST transition either double-counts an hour or
 *     loses one. UTC is not the friendliest default; it is the only one where
 *     the same query means the same thing twice.
 *
 *  2. **Reservations are superseded, never deleted.** A reservation is an
 *     estimate. When the work finishes, a `final` row lands for the same key and
 *     the reservation stops counting — net spend is finals plus *unsuperseded*
 *     reservations. Deleting instead would work, but then a crash between the
 *     delete and the insert loses the charge entirely, and a spend table you can
 *     only trust when nothing crashed is not an audit trail.
 *
 *  3. **Automations have no human, and that is legal.** `actor` is null for
 *     automation-driven work. A per-user cap therefore cannot apply to them —
 *     but "cannot apply a per-user cap" must never be implemented as "skip the
 *     budget check", which is how an unattended loop becomes the one thing in
 *     the system with no spending limit. Automations roll up to the org cap, and
 *     there is a test asserting exactly that.
 *
 *  4. **A breach stops admission, not execution.** On breach Harbor refuses to
 *     admit *new* claims and lets running turns finish. Killing a turn mid-
 *     flight wastes every token already spent on it and produces a half-applied
 *     change in somebody's repository — it converts a cost problem into a
 *     correctness problem, and the org pays for both.
 */

import { createHash } from "node:crypto";
import { eq, type SQL, sql as raw } from "drizzle-orm";
import { type RepoOverrides, setting } from "@core/kernel/config.js";
import { db } from "@core/schema/index.js";
import { costEvents } from "@core/schema/schema.js";
import {
	assertNever,
	type PriceQuote,
	priceAgentUsage,
	priceTokens,
	stampModel,
	type TokenUsage,
} from "./pricing.js";
import { HarborError, notifyChange } from "@core/kernel/work.js";

/**
 * The db handle or a transaction on it. Same derivation as `work.ts`, and for
 * the same reason: casting a transaction to `typeof db` compiles only because
 * the cast hides a real difference.
 */
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// ---------------------------------------------------------------------------
// Kinds and statuses
// ---------------------------------------------------------------------------

/**
 * What a cost row is *for*. Closed set — every consumer switches on these, so a
 * new kind is a deliberate change reviewed at each decision point rather than a
 * string some caller invents and nobody ever groups by.
 */
export const COST_KINDS = [
	"sandbox_spawn",
	"sandbox_seconds",
	"tokens",
	"provider_call",
	// Scheduled per-repo image builds. Attributed like any other automated spend so the
	// fourth amplification path — a build loop with no human in it — rolls up to the org
	// cap rather than being the one unbounded thing.
	"image_build",
] as const;
export type CostKind = (typeof COST_KINDS)[number];

/**
 * Whether a row is a promise to spend or a record of having spent.
 *
 * `reserved` rows are estimates taken *before* the work runs, and they are what
 * makes the cap atomic. `final` rows are what actually happened. Both live in
 * `cost_events`, distinguished by a prefix on `kind` — see `encodeCostKind`.
 */
export const COST_STATUSES = ["reserved", "final"] as const;
export type CostStatus = (typeof COST_STATUSES)[number];

const RESERVED_PREFIX = "reserved:";
const FINAL_PREFIX = "final:";

/**
 * Pack status, kind and the supersession key into the one text column there is.
 *
 * `cost_events.kind` is the only free text column that every query already
 * filters on, and the schema is frozen for this change, so status and the key
 * hash ride along inside it: `final:tokens#3f9a…`. That is not elegant, and it
 * is chosen over the alternatives deliberately.
 *
 * The key hash in particular has to be *in the row* rather than derived from it.
 * The obvious scheme — make the reservation's id and the final's id two hashes
 * of the same tuple — is unusable, because given a reservation row on its own
 * there is no way to recompute what its final's id would be: the caller's key is
 * not stored anywhere. Without that, "is this reservation superseded?" cannot be
 * answered in SQL at all, and net spend would have to be computed in application
 * memory over every row of the day. Carrying the shared hash in `kind` turns it
 * into a `NOT EXISTS` the database can answer.
 *
 * `:` separates status from kind and `#` separates kind from hash, so both parts
 * can be recovered with `split_part` inside a query.
 */
export function encodeCostKind(status: CostStatus, kind: CostKind, keyHash: string): string {
	switch (status) {
		case "reserved":
			return `${RESERVED_PREFIX}${kind}#${keyHash}`;
		case "final":
			return `${FINAL_PREFIX}${kind}#${keyHash}`;
	}
	return assertNever(status, "encodeCostKind");
}

export type DecodedCostKind =
	| { ok: true; status: CostStatus; kind: CostKind; keyHash: string }
	| { ok: false; reason: "malformed" | "unknown_status" | "unknown_kind"; raw: string };

/**
 * Read a `kind` column back apart.
 *
 * The failure cases are separated rather than collapsed to null because they
 * mean different things to whoever is looking. `malformed` is a row written by
 * something that is not this module — a migration, a hand-run INSERT, an older
 * version. `unknown_kind` is a row written by a *newer* version of this module
 * during a rolling deploy, which is a normal and temporary state. Reporting both
 * as "bad row" would send somebody hunting for corruption during a deploy.
 */
export function decodeCostKind(value: string): DecodedCostKind {
	const hash = value.indexOf("#");
	const colon = value.indexOf(":");
	if (hash < 0 || colon < 0 || colon > hash) {
		return { ok: false, reason: "malformed", raw: value };
	}

	const status = value.slice(0, colon);
	const kind = value.slice(colon + 1, hash);
	const keyHash = value.slice(hash + 1);

	if (!(COST_STATUSES as readonly string[]).includes(status)) {
		return { ok: false, reason: "unknown_status", raw: value };
	}
	if (!(COST_KINDS as readonly string[]).includes(kind)) {
		return { ok: false, reason: "unknown_kind", raw: value };
	}
	if (keyHash === "") return { ok: false, reason: "malformed", raw: value };

	return { ok: true, status: status as CostStatus, kind: kind as CostKind, keyHash };
}

// ---------------------------------------------------------------------------
// Identity: idempotency and supersession
// ---------------------------------------------------------------------------

/**
 * Namespace for the derived row ids. Fixed forever.
 *
 * Changing it makes every previously-written row un-collidable with its own
 * retry, which turns the idempotency guarantee off silently — the writes
 * succeed, they just double-charge. If a future scheme needs different inputs,
 * it gets a new namespace *and* the old one stays, so old rows keep resolving.
 */
const COST_ID_NAMESPACE = "6f4d5a1e-9c2b-4d7a-8e13-5b0c7a2f9d41";

/**
 * The separator inside every derived name.
 *
 * NUL, because it is the one byte that cannot appear in a caller-supplied key,
 * a UUID or a kind. With a printable delimiter like `|`, a caller whose key
 * contained one could produce the same joined string as a different tuple, and
 * two genuinely different charges would collide on the primary key. The second
 * one would then be silently dropped by `onConflictDoNothing` — money that was
 * spent and never recorded, with no error anywhere.
 */
const FIELD_SEPARATOR = "\u0000";

/**
 * A name-based UUID, v5-shaped, so a retried write collides instead of charging
 * twice.
 *
 * v5 rather than a random id because the whole point is that the caller does not
 * have to remember anything: a process that crashed after the provider call but
 * before the database write retries with the same inputs, derives the same id,
 * and the insert is absorbed by the primary key. Random ids would need a
 * separate dedupe table, which is one more thing to keep consistent with the
 * thing it deduplicates.
 *
 * SHA-1 here is not a security decision and does not need to resist an attacker;
 * it is the digest RFC 4122 specifies for v5, and using it keeps these ids
 * indistinguishable from any other v5 UUID to every tool that parses them.
 */
function uuidV5(namespace: string, name: string): string {
	const hex = namespace.replace(/-/g, "");
	const namespaceBytes = Buffer.from(hex, "hex");
	const digest = createHash("sha1")
		.update(namespaceBytes)
		.update(Buffer.from(name, "utf8"))
		.digest();

	const bytes = Buffer.from(digest.subarray(0, 16));
	bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50; // version 5
	bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80; // RFC 4122 variant
	const out = bytes.toString("hex");
	return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20)}`;
}

/**
 * What identifies "the same unit of work" for both idempotency and supersession.
 *
 * `key` is the caller's sequence or attempt marker — a turn number, a heartbeat
 * tick, a spawn attempt. It is the only field a caller has to think about, and
 * getting it wrong in the safe direction (too specific) costs an extra row while
 * getting it wrong in the unsafe direction (reused across genuinely different
 * charges) drops one.
 */
export interface CostRef {
	orgId: string;
	claimId?: string | null;
	sessionId?: string | null;
	key: string;
}

/**
 * The 16-hex digest that ties a reservation to the final that supersedes it.
 *
 * Deliberately *excludes* the kind, so a reservation booked as a `sandbox_spawn`
 * estimate is still superseded by the `tokens` row that records what the turn
 * actually cost. The two are the same unit of work seen before and after; if the
 * kind were in the hash they would never match and every finished turn would be
 * counted twice — once as its estimate and once as its actual — until the
 * estimate aged out.
 */
export function spendKeyHash(ref: CostRef): string {
	const name = [ref.orgId, ref.claimId ?? "-", ref.sessionId ?? "-", ref.key].join(FIELD_SEPARATOR);
	return createHash("sha256").update(name, "utf8").digest("hex").slice(0, 16);
}

/**
 * The primary key for one cost row.
 *
 * Status is in the derivation because a reservation and its final are two rows
 * that must coexist; `part` is in it because a charge larger than the column can
 * hold is written as several rows (see `MICRO_USD_COLUMN_CEILING`).
 */
export function costEventId(
	ref: CostRef,
	status: CostStatus,
	kind: CostKind,
	part: number,
): string {
	const name = [
		status,
		kind,
		ref.orgId,
		ref.claimId ?? "-",
		ref.sessionId ?? "-",
		ref.key,
		String(part),
	].join(FIELD_SEPARATOR);
	return uuidV5(COST_ID_NAMESPACE, name);
}

// ---------------------------------------------------------------------------
// UTC day arithmetic
// ---------------------------------------------------------------------------

/**
 * Midnight UTC at or before `at`.
 *
 * Not `setHours(0,0,0,0)`, which is midnight *local* and therefore a different
 * instant on every host in the deployment. See the file header for why the day
 * boundary is UTC and not configurable.
 */
export function utcDayStart(at: Date): Date {
	return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/** Midnight UTC on the following day; the exclusive end of the window. */
export function utcDayEnd(at: Date): Date {
	const start = utcDayStart(at);
	return new Date(start.getTime() + 86_400_000);
}

/** `YYYY-MM-DD` in UTC — the key `spendByDay` groups on. */
export function utcDayKey(at: Date): string {
	return utcDayStart(at).toISOString().slice(0, 10);
}

/**
 * The instant before which an unfinished reservation stops counting.
 *
 * A reservation whose process died never gets a final row, so without a horizon
 * it counts against the cap for the rest of the day — and, once a few of those
 * accumulate, ratchets the effective cap down to zero. The failure presents as
 * "we cannot start any sessions" next to a spend report showing almost no actual
 * usage, which is a genuinely baffling place to start debugging.
 *
 * The horizon is the agent turn timeout rather than a number of its own, and the
 * reasoning is that a reservation covers at most one turn: past the point where
 * the turn itself would have been killed, the reservation is definitionally
 * backing no live work. Reusing that setting also means an operator who raises
 * the turn timeout for a slow repo does not have to discover a second knob to
 * keep in step with it.
 */
function staleReservationCutoff(now: Date, overrides?: RepoOverrides): Date {
	return new Date(now.getTime() - setting("agentTurnTimeoutMs", overrides));
}

// ---------------------------------------------------------------------------
// Writing rows
// ---------------------------------------------------------------------------

/**
 * The largest value `cost_events.micro_usd` can hold: int4, about $2,147.
 *
 * This is **not** a tunable and does not belong in `src/config.ts`. It is the
 * range of a column; an operator cannot change it with an environment variable,
 * only with a migration. What it is here for is that Postgres does not wrap on
 * overflow — it raises, aborting the whole transaction — so a single charge
 * above the ceiling would not merely be recorded wrong, it would take out the
 * turn that produced it. A charge that large is split across rows instead, which
 * keeps the sum exact and every part idempotent.
 */
const MICRO_USD_COLUMN_CEILING = 2_147_483_647;

export interface CostWrite extends CostRef {
	kind: CostKind;
	/** Defaults to `final`; reservations are written by `reserveBudget`. */
	status?: CostStatus;
	repoId?: string | null;
	/** Null is legal and means an automation. See the file header. */
	actor?: string | null;
	provider?: string | null;
	/** Already stamped with a pricing version by `stampModel`, or a bare name. */
	model?: string | null;
	/** Tokens, seconds or calls — units follow `kind`. Telemetry, not money. */
	quantity?: number;
	microUsd: number;
	createdAt?: Date;
}

export interface CostWriteResult {
	ids: string[];
	microUsd: number;
	/** Rows this call actually inserted. Zero means every part already existed. */
	inserted: number;
	/** True when at least one part was already present — i.e. this was a retry. */
	duplicate: boolean;
}

/**
 * Write a cost row, idempotently.
 *
 * Safe to call twice with the same `ref`, `status` and `kind`: the id is derived
 * from them, so the second call collides on the primary key and is absorbed.
 * That is what makes it safe to record cost *after* a provider call — the window
 * where a crash would otherwise either lose the charge (record-after) or invent
 * one (record-before) is closed by the retry being a no-op.
 */
export async function recordCost(
	input: CostWrite,
	options: {
		/**
		 * Run the insert on the caller's transaction, so a cost row commits
		 * atomically with the state change it prices — a snapshot ref and its
		 * `provider_call` row are one fact. Same contract as `AppendOptions` in
		 * session-events.ts.
		 */
		executor?: Executor;
	} = {},
): Promise<CostWriteResult> {
	const status = input.status ?? "final";
	const microUsd = normalizeMicroUsd(input.microUsd, "recordCost");
	const createdAt = input.createdAt ?? new Date();
	const keyHash = spendKeyHash(input);
	const kindValue = encodeCostKind(status, input.kind, keyHash);

	// Quantity is clamped rather than split, and the asymmetry with money is on
	// purpose: quantity is telemetry, and a token count reported as "as many as
	// the column holds" is a cosmetic inaccuracy. Refusing the insert to protect
	// its precision would lose the *money*, which is the part nobody can
	// reconstruct afterwards.
	const quantity = Math.min(Math.max(Math.round(input.quantity ?? 0), 0), MICRO_USD_COLUMN_CEILING);

	const parts = splitMicroUsd(microUsd);
	const rows = parts.map((amount, index) => ({
		id: costEventId(input, status, input.kind, index),
		orgId: input.orgId,
		kind: kindValue,
		claimId: input.claimId ?? null,
		sessionId: input.sessionId ?? null,
		repoId: input.repoId ?? null,
		actor: input.actor ?? null,
		provider: input.provider ?? null,
		model: input.model ?? null,
		// The whole quantity rides on the first part so that summing quantity over
		// a split charge still gives the real token count.
		quantity: index === 0 ? quantity : 0,
		microUsd: amount,
		createdAt,
	}));

	const inserted = await (options.executor ?? db)
		.insert(costEvents)
		.values(rows)
		.onConflictDoNothing({ target: costEvents.id })
		.returning({ id: costEvents.id });

	return {
		ids: rows.map((row) => row.id),
		microUsd,
		inserted: inserted.length,
		duplicate: inserted.length < rows.length,
	};
}

/**
 * Price an agent's reported usage and record it, in one call.
 *
 * The pricing version is stamped into the `model` column here rather than left
 * to the caller, because a caller that forgets produces a row that looks priced
 * and cannot be recomputed — the worst of both states.
 */
export async function recordTokenUsage(
	input: CostRef & {
		repoId?: string | null;
		actor?: string | null;
		provider?: string | null;
		model: string | null;
		usage: TokenUsage;
		createdAt?: Date;
	},
): Promise<{ quote: PriceQuote; write: CostWriteResult }> {
	const quote = priceTokens(input.model, input.usage);
	const write = await recordCost({
		orgId: input.orgId,
		claimId: input.claimId,
		sessionId: input.sessionId,
		key: input.key,
		kind: "tokens",
		repoId: input.repoId,
		actor: input.actor,
		provider: input.provider ?? (quote.priced ? quote.provider : null),
		model: stampModel(input.model, quote),
		quantity:
			(input.usage.inputTokens ?? 0)
			+ (input.usage.outputTokens ?? 0)
			+ (input.usage.cacheReadTokens ?? 0)
			+ (input.usage.cacheWriteTokens ?? 0),
		microUsd: quote.microUsd,
		createdAt: input.createdAt,
	});
	return { quote, write };
}

/**
 * Price and record what a sandbox agent reported spending, in one call.
 *
 * This is the ingest route's cost primitive — the one that closes "model spend
 * writes no cost_events row". The bridge's `agent_finished`/`agent_failed`
 * payload carries an `AgentUsage` block, and every one of them lands here as a
 * `tokens` row: agent-reported money wins over the table price and is stamped
 * `agent_reported` (the agent's own bill is the fact; our table is the
 * estimate), `source: "unavailable"` records a zero-priced row that is VISIBLE
 * rather than invented, and the key is the prompt id so a re-sent batch — a
 * POST whose 200 was lost — derives the same row ids and is absorbed.
 */
export async function recordAgentUsage(
	input: CostRef & {
		repoId?: string | null;
		actor?: string | null;
		provider?: string | null;
		usage: Parameters<typeof priceAgentUsage>[0];
		createdAt?: Date;
	},
): Promise<{ quote: PriceQuote; write: CostWriteResult }> {
	const quote = priceAgentUsage(input.usage);
	const write = await recordCost({
		orgId: input.orgId,
		claimId: input.claimId,
		sessionId: input.sessionId,
		key: input.key,
		kind: "tokens",
		repoId: input.repoId,
		actor: input.actor,
		provider: input.provider ?? (quote.priced ? quote.provider : null),
		model: stampModel(input.usage.model, quote),
		quantity:
			input.usage.input_tokens
			+ input.usage.output_tokens
			+ (input.usage.cache_read_tokens ?? 0)
			+ (input.usage.cache_write_tokens ?? 0),
		microUsd: quote.microUsd,
		createdAt: input.createdAt,
	});
	return { quote, write };
}

/**
 * Record what a turn actually cost, superseding whatever was reserved for it.
 *
 * The `ref` must be the same one the reservation used — that is what makes the
 * hashes match and the estimate stop counting. Passing a different key does not
 * fail; it records a real charge and leaves the reservation standing until it
 * ages out, which double-counts the work for up to one turn timeout.
 */
export async function finalizeReservation(
	input: CostRef & {
		kind: CostKind;
		repoId?: string | null;
		actor?: string | null;
		provider?: string | null;
		model?: string | null;
		usage?: TokenUsage;
		microUsd?: number;
		quantity?: number;
		createdAt?: Date;
	},
): Promise<{ quote: PriceQuote | null; write: CostWriteResult }> {
	if (input.usage) {
		const quote = priceTokens(input.model ?? null, input.usage);
		const write = await recordCost({
			...input,
			status: "final",
			model: stampModel(input.model ?? null, quote),
			provider: input.provider ?? (quote.priced ? quote.provider : null),
			quantity:
				input.quantity
				?? (input.usage.inputTokens ?? 0)
					+ (input.usage.outputTokens ?? 0)
					+ (input.usage.cacheReadTokens ?? 0)
					+ (input.usage.cacheWriteTokens ?? 0),
			microUsd: quote.microUsd,
		});
		return { quote, write };
	}

	const write = await recordCost({
		...input,
		status: "final",
		microUsd: input.microUsd ?? 0,
	});
	return { quote: null, write };
}

/**
 * Give a reservation back when the work never happened.
 *
 * Implemented as a zero-valued final rather than a delete so the record still
 * says "we reserved this and it cost nothing" — which is a different and much
 * more debuggable statement than the absence of any row at all, especially when
 * the question being asked is why a spawn was refused an hour ago.
 */
export async function releaseReservation(
	input: CostRef & { kind: CostKind; repoId?: string | null; actor?: string | null },
): Promise<CostWriteResult> {
	return recordCost({ ...input, status: "final", microUsd: 0, quantity: 0 });
}

function normalizeMicroUsd(value: number, context: string): number {
	if (!Number.isFinite(value) || value < 0) {
		throw new HarborError(`${context}: micro_usd must be a non-negative finite number, got ${value}`);
	}
	return Math.round(value);
}

/** Split a charge into column-sized parts. Usually returns a single element. */
function splitMicroUsd(total: number): number[] {
	if (total <= MICRO_USD_COLUMN_CEILING) return [total];
	const parts: number[] = [];
	let remaining = total;
	while (remaining > 0) {
		const part = Math.min(remaining, MICRO_USD_COLUMN_CEILING);
		parts.push(part);
		remaining -= part;
	}
	return parts;
}

// ---------------------------------------------------------------------------
// Reading spend
// ---------------------------------------------------------------------------

/**
 * Bind an instant into a hand-written query as an explicit UTC timestamptz.
 *
 * Not `${date}`. Drizzle's raw-SQL path hands a `Date` to postgres-js already
 * typed as `timestamptz`, and the driver's encoder for that type expects a
 * string — it throws `ERR_INVALID_ARG_TYPE` at bind time, from inside the socket
 * handler, with a stack that names neither this file nor the query. Dates only
 * work through the query *builder*, which maps them first. An ISO string with an
 * explicit cast sidesteps the whole disagreement and is unambiguous about the
 * timezone, which every comparison in this module depends on.
 */
function instant(at: Date): SQL {
	return raw`${at.toISOString()}::timestamptz`;
}

/**
 * The predicate every spend query shares: finals, plus reservations that no
 * final has superseded and that are not stale.
 *
 * The `NOT EXISTS` is deliberately **not** scoped to the same day as the
 * reservation. A reservation taken at 23:59 UTC whose turn finishes at 00:01 has
 * its final on the next day; day-scoping the anti-join would count the estimate
 * on day one and the actual on day two, billing the org twice for one turn.
 * Unscoped, the money simply belongs to whichever day carries the surviving row,
 * and the cross-day total is right. Yesterday's number can therefore change
 * after midnight — that is the honest behaviour, and it is why reports name the
 * pricing version and the run time.
 */
function countedSpendWhere(
	orgId: string,
	from: Date,
	to: Date,
	reservationsNewerThan: Date,
	extra?: SQL,
): SQL {
	const finalLike = `${FINAL_PREFIX}%`;
	const reservedLike = `${RESERVED_PREFIX}%`;
	const base = raw`
		c.org_id = ${orgId}
		and c.created_at >= ${instant(from)}
		and c.created_at < ${instant(to)}
		and (
			c.kind like ${finalLike}
			or (
				c.kind like ${reservedLike}
				and c.created_at >= ${instant(reservationsNewerThan)}
				and split_part(c.kind, '#', 2) <> ''
				and not exists (
					select 1
					from cost_events f
					where f.org_id = c.org_id
						and f.kind like ${finalLike}
						and split_part(f.kind, '#', 2) = split_part(c.kind, '#', 2)
				)
			)
		)`;
	return extra ? raw`${base} and ${extra}` : base;
}

/**
 * Read a `sum(micro_usd)` back as an exact integer.
 *
 * The cast to text is the point. `sum()` over an int4 column returns bigint, and
 * postgres-js hands bigint back as a string rather than silently narrowing it to
 * a float64 — so parsing it here, and asserting the result is a safe integer, is
 * the last place a rounding error could enter the accounting and the only place
 * it would be caught.
 */
async function sumSpend(ex: Executor, where: SQL): Promise<number> {
	const rows = await ex.execute<{ total: string }>(
		raw`select coalesce(sum(c.micro_usd), 0)::text as total from cost_events c where ${where}`,
	);
	const raw0 = rows[0]?.total ?? "0";
	const total = Number(raw0);
	if (!Number.isSafeInteger(total)) {
		throw new HarborError(
			`cost: summed spend ${raw0} is outside the exactly-representable integer range; `
				+ "the accounting cannot be trusted and this is a bug, not a large bill.",
		);
	}
	return total;
}

export interface SpendWindow {
	/** Inclusive. Defaults to midnight UTC of `now`. */
	from?: Date;
	/** Exclusive. Defaults to midnight UTC of the following day. */
	to?: Date;
	now?: Date;
	repoOverrides?: RepoOverrides;
}

function resolveWindow(window: SpendWindow = {}) {
	const now = window.now ?? new Date();
	return {
		now,
		from: window.from ?? utcDayStart(now),
		to: window.to ?? utcDayEnd(now),
		cutoff: staleReservationCutoff(now, window.repoOverrides),
	};
}

/** Net spend for the current UTC day: finals plus live, unsuperseded estimates. */
export async function spendToday(orgId: string, window: SpendWindow = {}): Promise<number> {
	const { from, to, cutoff } = resolveWindow(window);
	return sumSpend(db, countedSpendWhere(orgId, from, to, cutoff));
}

async function groupedSpend(
	orgId: string,
	column: SQL,
	window: SpendWindow,
): Promise<Array<{ key: string | null; microUsd: number }>> {
	const { from, to, cutoff } = resolveWindow(window);
	const where = countedSpendWhere(orgId, from, to, cutoff);
	const rows = await db.execute<{ key: string | null; total: string }>(
		raw`select ${column} as key, coalesce(sum(c.micro_usd), 0)::text as total
			from cost_events c
			where ${where}
			group by 1
			order by sum(c.micro_usd) desc`,
	);
	return Array.from(rows, (row) => ({ key: row.key, microUsd: Number(row.total) }));
}

export async function spendByClaim(
	orgId: string,
	window: SpendWindow = {},
): Promise<Array<{ claimId: string | null; microUsd: number }>> {
	const rows = await groupedSpend(orgId, raw`c.claim_id::text`, window);
	return rows.map((row) => ({ claimId: row.key, microUsd: row.microUsd }));
}

export async function spendByRepo(
	orgId: string,
	window: SpendWindow = {},
): Promise<Array<{ repoId: string | null; microUsd: number }>> {
	const rows = await groupedSpend(orgId, raw`c.repo_id::text`, window);
	return rows.map((row) => ({ repoId: row.key, microUsd: row.microUsd }));
}

/**
 * Spend per human, with the automation bucket kept visible.
 *
 * The null-actor row is returned as `actor: null`, never filtered out and never
 * folded into another bucket. Filtering it would hide automation spend, and
 * automation spend is the largest amplification path in the system — the exact
 * number somebody looking at a surprise bill most needs to see.
 */
export async function spendByActor(
	orgId: string,
	window: SpendWindow = {},
): Promise<Array<{ actor: string | null; microUsd: number }>> {
	const rows = await groupedSpend(orgId, raw`c.actor`, window);
	return rows.map((row) => ({ actor: row.key, microUsd: row.microUsd }));
}

/**
 * Spend per UTC day, oldest first.
 *
 * `at time zone 'UTC'` is written out in the SQL rather than relying on the
 * session's `TimeZone`, because that setting is inherited from the server's
 * configuration and differs between a laptop, CI and a managed Postgres. Without
 * it the same query run in two places groups rows into different days.
 */
export async function spendByDay(
	orgId: string,
	window: SpendWindow & { days?: number } = {},
): Promise<Array<{ day: string; microUsd: number }>> {
	const now = window.now ?? new Date();
	const to = window.to ?? utcDayEnd(now);
	const from = window.from ?? new Date(utcDayStart(now).getTime() - (window.days ?? 7) * 86_400_000);
	const cutoff = staleReservationCutoff(now, window.repoOverrides);
	const where = countedSpendWhere(orgId, from, to, cutoff);
	const rows = await db.execute<{ day: string; total: string }>(
		raw`select to_char(c.created_at at time zone 'UTC', 'YYYY-MM-DD') as day,
				coalesce(sum(c.micro_usd), 0)::text as total
			from cost_events c
			where ${where}
			group by 1
			order by 1 asc`,
	);
	return Array.from(rows, (row) => ({ day: row.day, microUsd: Number(row.total) }));
}

// ---------------------------------------------------------------------------
// The cap
// ---------------------------------------------------------------------------

export interface BudgetStatus {
	capMicroUsd: number;
	spentMicroUsd: number;
	remainingMicroUsd: number;
	/**
	 * True once spend has reached the cap.
	 *
	 * What this must be read as is "stop admitting new claims", never "kill what
	 * is running". A turn interrupted at 90% has spent 90% of its tokens and
	 * produced nothing; the org pays for the work and gets a half-applied change
	 * to reason about. Refusing the next admission costs nobody anything already
	 * paid for.
	 */
	exhausted: boolean;
}

export async function budgetStatus(orgId: string, window: SpendWindow = {}): Promise<BudgetStatus> {
	const capMicroUsd = setting("maxSpendPerDayMicroUsd", window.repoOverrides);
	const spentMicroUsd = await spendToday(orgId, window);
	return {
		capMicroUsd,
		spentMicroUsd,
		remainingMicroUsd: Math.max(0, capMicroUsd - spentMicroUsd),
		exhausted: spentMicroUsd >= capMicroUsd,
	};
}

/**
 * Why a reservation was refused. Typed, and with "denied" separate from "could
 * not determine" — the distinction this whole codebase is built around.
 *
 * `org_cap_exhausted` and `actor_cap_exhausted` are *decisions*: the numbers were
 * read and they say no. `state_unavailable` is the absence of a decision — the
 * lock could not be taken, the query failed, the database is unreachable. A
 * caller that treats those as the same thing gets one of two bad outcomes, and
 * which one depends only on which way it happens to collapse them: fail open and
 * a database blip becomes unlimited spending, fail closed and it becomes a total
 * outage.
 *
 * Budget is **authority**, so the asymmetry stated across this codebase applies:
 * *liveness fails open, authority fails closed*. A sandbox whose status cannot be
 * determined is treated as alive, because wrongly reaping a live box destroys
 * work in flight; an authorisation that cannot be determined is treated as
 * absent, because wrongly admitting spend is unbounded and irreversible. Both
 * sites carry this comment because the two rules look contradictory read apart,
 * and somebody reading only one of them will "fix" it to match the other.
 */
export const BUDGET_REFUSAL_REASONS = [
	"org_cap_exhausted",
	"actor_cap_exhausted",
	"invalid_estimate",
	"state_unavailable",
] as const;
export type BudgetRefusalReason = (typeof BUDGET_REFUSAL_REASONS)[number];

/** Exhaustive; a new reason is a compile error here rather than a blank message. */
export function describeBudgetRefusal(reason: BudgetRefusalReason): string {
	switch (reason) {
		case "org_cap_exhausted":
			return "the organisation's daily spend cap is reached; running work continues, new work is not admitted";
		case "actor_cap_exhausted":
			return "this user's daily spend cap is reached";
		case "invalid_estimate":
			return "the requested reservation was not a non-negative whole number of micro-USD";
		case "state_unavailable":
			return "spend could not be determined, so the reservation was refused rather than assumed safe";
	}
	return assertNever(reason, "describeBudgetRefusal");
}

export type BudgetDecision =
	| {
			ok: true;
			reservationId: string;
			/** True when this exact reservation already existed — a retry, not a second charge. */
			duplicate: boolean;
			capMicroUsd: number;
			spentBeforeMicroUsd: number;
			reservedMicroUsd: number;
			remainingMicroUsd: number;
	  }
	| {
			ok: false;
			reason: BudgetRefusalReason;
			message: string;
			estimateMicroUsd: number;
			/** Null means "could not be determined", not "zero". */
			capMicroUsd: number | null;
			spentMicroUsd: number | null;
			remainingMicroUsd: number | null;
	  };

export interface ReserveBudgetOptions extends Omit<CostRef, "orgId"> {
	kind?: CostKind;
	repoId?: string | null;
	/**
	 * The human this is charged to, or null for an automation.
	 *
	 * Null is legal. See `actorCapMicroUsd` for what it does *not* mean.
	 */
	actor?: string | null;
	provider?: string | null;
	model?: string | null;
	quantity?: number;
	/**
	 * An optional per-user cap, applied on top of the org cap.
	 *
	 * When `actor` is null there is no user to cap, so this is not applied — and
	 * that is the whole hazard this option carries. "No per-user cap applies" must
	 * never become "no cap applies": an automation is the one caller in the system
	 * with no human watching it, and exempting it from the org cap would make the
	 * least supervised code path the only unbounded one. Automations roll up to
	 * the org cap like everything else, and `cost.test.ts` asserts it.
	 */
	actorCapMicroUsd?: number;
	repoOverrides?: RepoOverrides;
	now?: Date;
}

/**
 * Namespace for the per-org budget advisory lock.
 *
 * Advisory locks are global to the database and keyed only by integers, so two
 * unrelated features that both hash an org id into a lock key would silently
 * serialise against each other — and, worse, could deadlock if either ever took
 * the other's lock second. A fixed namespace in the first key word makes the
 * space disjoint by construction. The value spells `HBUD` in ASCII, which is
 * findable in `pg_locks` output when somebody is staring at a stuck query.
 *
 * The rejected alternative was `SELECT … FROM orgs WHERE id = $1 FOR UPDATE`,
 * which needs no new concept. It was rejected because it makes budget admission
 * contend with every unrelated write to the org row — renaming an org would
 * block every session start in it, and the connection between those two facts is
 * not something anybody would work out from the symptom.
 */
const BUDGET_LOCK_NAMESPACE = 0x48425544;

function orgLockKey(orgId: string): number {
	const digest = createHash("sha256").update(orgId, "utf8").digest();
	return digest.readInt32BE(0);
}

/**
 * Serialise budget decisions for one org.
 *
 * `pg_advisory_xact_lock` rather than the session-scoped variant: a transaction
 * lock is released by COMMIT or ROLLBACK, including the rollback Postgres does
 * for you when the connection dies. A session lock leaked by a crashed process
 * is held until that pooled connection is recycled, which is indefinitely — and
 * the symptom is every spawn in one org hanging forever while every other org is
 * fine.
 *
 * **This is only correct under READ COMMITTED**, which is Postgres's default and
 * what drizzle opens. READ COMMITTED takes a fresh snapshot per statement, so
 * the `sum()` that runs after the lock is acquired sees the reservation the
 * previous holder just committed. Under REPEATABLE READ the snapshot is taken
 * when the *first* statement starts — the lock acquisition itself, before the
 * other transaction committed — so the sum would be blind to exactly the row it
 * is waiting for, and twenty serialised callers would all read the same stale
 * total and all be admitted. The lock would be doing nothing at all, and the
 * tests would still pass on a single connection.
 */
async function lockOrgBudget(tx: Executor, orgId: string): Promise<void> {
	await tx.execute(
		raw`select pg_advisory_xact_lock(${BUDGET_LOCK_NAMESPACE}::int, ${orgLockKey(orgId)}::int)`,
	);
}

/**
 * Check the cap and take the money in the same transaction.
 *
 * This is the function the file exists for. The order inside the transaction is
 * load-bearing: lock, then read, then write. Reading before the lock reintroduces
 * the race the lock is there to close; writing before the read admits everybody.
 *
 * A refusal still commits — it wrote nothing, and rolling back would lose the
 * advisory lock's queue position for no benefit.
 */
export async function reserveBudget(
	orgId: string,
	estimateMicroUsd: number,
	options: ReserveBudgetOptions,
): Promise<BudgetDecision> {
	const now = options.now ?? new Date();
	const kind = options.kind ?? "provider_call";
	const capMicroUsd = setting("maxSpendPerDayMicroUsd", options.repoOverrides);

	if (!Number.isFinite(estimateMicroUsd) || estimateMicroUsd < 0) {
		return {
			ok: false,
			reason: "invalid_estimate",
			message: describeBudgetRefusal("invalid_estimate"),
			estimateMicroUsd,
			capMicroUsd,
			spentMicroUsd: null,
			remainingMicroUsd: null,
		};
	}
	const estimate = Math.round(estimateMicroUsd);

	const ref: CostRef = {
		orgId,
		claimId: options.claimId ?? null,
		sessionId: options.sessionId ?? null,
		key: options.key,
	};
	const keyHash = spendKeyHash(ref);
	const from = utcDayStart(now);
	const to = utcDayEnd(now);
	const cutoff = staleReservationCutoff(now, options.repoOverrides);

	let decision: BudgetDecision;
	try {
		decision = await db.transaction(async (tx) => {
			await lockOrgBudget(tx, orgId);

			// A retried reservation must not be charged twice, and must not be
			// refused for pushing the org over its own already-counted estimate.
			// Checked before the cap for exactly that reason: its amount is already
			// in the sum below, so comparing `spent + estimate` against the cap would
			// count this reservation twice and refuse a caller that already holds it.
			const reservationId = costEventId(ref, "reserved", kind, 0);
			const existing = await tx
				.select({ microUsd: costEvents.microUsd })
				.from(costEvents)
				.where(eq(costEvents.id, reservationId))
				.limit(1);
			if (existing.length > 0) {
				const spent = await sumSpend(tx, countedSpendWhere(orgId, from, to, cutoff));
				return {
					ok: true as const,
					reservationId,
					duplicate: true,
					capMicroUsd,
					spentBeforeMicroUsd: Math.max(0, spent - estimate),
					reservedMicroUsd: estimate,
					remainingMicroUsd: Math.max(0, capMicroUsd - spent),
				};
			}

			const spent = await sumSpend(tx, countedSpendWhere(orgId, from, to, cutoff));

			// The per-actor cap, and the branch that decides an automation's fate.
			// `actor === null` is an automation: there is no user, so no user cap can
			// apply — but control deliberately falls through to the org cap below
			// rather than returning. See `ReserveBudgetOptions.actorCapMicroUsd`.
			const actor = options.actor ?? null;
			if (actor !== null && options.actorCapMicroUsd !== undefined) {
				const actorSpent = await sumSpend(
					tx,
					countedSpendWhere(orgId, from, to, cutoff, raw`c.actor = ${actor}`),
				);
				if (actorSpent + estimate > options.actorCapMicroUsd) {
					return {
						ok: false as const,
						reason: "actor_cap_exhausted" as const,
						message: describeBudgetRefusal("actor_cap_exhausted"),
						estimateMicroUsd: estimate,
						capMicroUsd: options.actorCapMicroUsd,
						spentMicroUsd: actorSpent,
						remainingMicroUsd: Math.max(0, options.actorCapMicroUsd - actorSpent),
					};
				}
			}

			if (spent + estimate > capMicroUsd) {
				return {
					ok: false as const,
					reason: "org_cap_exhausted" as const,
					message: describeBudgetRefusal("org_cap_exhausted"),
					estimateMicroUsd: estimate,
					capMicroUsd,
					spentMicroUsd: spent,
					remainingMicroUsd: Math.max(0, capMicroUsd - spent),
				};
			}

			await tx
				.insert(costEvents)
				.values({
					id: reservationId,
					orgId,
					kind: encodeCostKind("reserved", kind, keyHash),
					claimId: ref.claimId,
					sessionId: ref.sessionId,
					repoId: options.repoId ?? null,
					actor,
					provider: options.provider ?? null,
					model: options.model ?? null,
					quantity: Math.max(0, Math.round(options.quantity ?? 0)),
					microUsd: Math.min(estimate, MICRO_USD_COLUMN_CEILING),
					createdAt: now,
				})
				.onConflictDoNothing({ target: costEvents.id });

			return {
				ok: true as const,
				reservationId,
				duplicate: false,
				capMicroUsd,
				spentBeforeMicroUsd: spent,
				reservedMicroUsd: estimate,
				remainingMicroUsd: Math.max(0, capMicroUsd - spent - estimate),
			};
		});
	} catch (error) {
		// The distinction the typed reasons exist for. We did not learn that the
		// org is over budget; we failed to learn anything. Refusing is the
		// fail-closed choice demanded of an authority decision — see the comment on
		// BUDGET_REFUSAL_REASONS for why this is the opposite of what the liveness
		// path does with the same kind of uncertainty.
		console.error("[cost] budget state unavailable:", error);
		return {
			ok: false,
			reason: "state_unavailable",
			message: describeBudgetRefusal("state_unavailable"),
			estimateMicroUsd: estimate,
			capMicroUsd,
			spentMicroUsd: null,
			remainingMicroUsd: null,
		};
	}

	// Outside the transaction on purpose: a NOTIFY is a side effect on a
	// listener, and firing it for a decision that later rolled back would show an
	// operator a breach that never happened.
	if (!decision.ok && decision.reason === "org_cap_exhausted") {
		await notifyChange(orgId, "budget_exhausted");
	}
	return decision;
}

/**
 * Convenience for the admission path: may this org start new work at all?
 *
 * Separate from `reserveBudget` because it answers a different question. This is
 * the cheap read a dashboard or a queue drain uses to decide whether to even try;
 * `reserveBudget` is the authoritative, serialised decision. Nothing may admit
 * work on the strength of this function alone — between the read and the spawn
 * there is a window, and closing that window is exactly what the reservation is
 * for.
 */
export async function canAdmitNewWork(
	orgId: string,
	window: SpendWindow = {},
): Promise<{ admit: boolean; status: BudgetStatus }> {
	const status = await budgetStatus(orgId, window);
	return { admit: !status.exhausted, status };
}

export { priceAgentUsage, priceTokens };
