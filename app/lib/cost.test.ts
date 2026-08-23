// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Against the real Postgres from docker-compose, never a mock.
 *
 * The claim this module makes — that a budget cap holds under concurrency — is a
 * claim about Postgres transactions, advisory locks and statement-level
 * snapshots. A mocked database would assert that the code does what the code
 * does, and would pass just as happily against the read-then-write cap that this
 * whole design exists to replace. The twenty-concurrent-reservations test is the
 * only thing here that would notice the difference, and it can only run against
 * a real server.
 *
 * The pure arithmetic in `pricing.ts` is tested with zero mocks and at exact
 * boundary values, because rounding bugs in money are invisible until they are
 * expensive.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, sql } from "@core/schema/index.js";
import { claims, costEvents, orgs, repos, sessions, tasks } from "@core/schema/schema.js";
import {
	budgetStatus,
	canAdmitNewWork,
	costEventId,
	decodeCostKind,
	encodeCostKind,
	finalizeReservation,
	recordCost,
	recordTokenUsage,
	releaseReservation,
	reserveBudget,
	spendByActor,
	spendByClaim,
	spendByDay,
	spendByRepo,
	spendKeyHash,
	spendToday,
	utcDayEnd,
	utcDayKey,
	utcDayStart,
} from "./cost.js";
import {
	AGENT_REPORTED_STAMP,
	decodeModelStamp,
	lookupPrice,
	normalizeModelId,
	priceAgentUsage,
	priceTokens,
	PRICING_VERSION,
	stampModel,
} from "./pricing.js";

let orgId: string;
let claimId: string;
let sessionId: string;
let repoId: string;

/** A fixed instant well inside a UTC day, so boundary maths is unambiguous. */
const NOW = new Date("2026-03-15T12:00:00.000Z");

/**
 * Overrides passed to every budget call instead of mutating `process.env`.
 *
 * `setting()` resolves repo overrides ahead of the environment, so this exercises
 * the same code path an operator's per-repo configuration would, and two tests
 * that want different caps cannot leak into one another.
 */
const CAP_5_USD = { maxSpendPerDayMicroUsd: 5_000_000 } as const;

beforeEach(async () => {
	// TRUNCATE CASCADE rather than ordered DELETEs: immune to foreign-key
	// ordering, and it resets cleanly even if a previous test left a connection
	// in a bad state.
	await sql`truncate table cost_events, session_prompts, session_participants, sessions, runs, agent_presence, events, claims, tasks, repos, projects, api_keys, digests, connectors, users, orgs cascade`;

	const [org] = await db.insert(orgs).values({ name: "Cost Org" }).returning();
	orgId = org!.id;

	const [task] = await db
		.insert(tasks)
		.values({ orgId, title: "Reduce spend", status: "open" })
		.returning();
	const [claim] = await db
		.insert(claims)
		.values({
			orgId,
			scope: `harbor:${task!.id}`,
			taskId: task!.id,
			agentId: "claude-code:wt-1",
			intent: "Measure and reduce the daily spend baseline.",
			expiresAt: new Date(Date.now() + 3_600_000),
		})
		.returning();
	claimId = claim!.id;

	const [session] = await db
		.insert(sessions)
		.values({ orgId, key: "sesskey0000000000000a", title: "Session", createdBy: "ana" })
		.returning();
	sessionId = session!.id;

	const [repo] = await db
		.insert(repos)
		.values({ orgId, owner: "harbor", name: "praia" })
		.returning();
	repoId = repo!.id;
});

afterAll(async () => {
	await sql.end();
});

// ---------------------------------------------------------------------------
// The reason this file exists
// ---------------------------------------------------------------------------

describe("reserveBudget", () => {
	it("admits exactly five of twenty concurrent reservations against a cap that permits five", async () => {
		// Each caller asks for $1 against a $5 cap. A read-then-write cap lets all
		// twenty through, because all twenty read "$0 spent" before any of them
		// writes. The reservation row is what makes the next reader see a bigger
		// number, and the advisory lock is what stops them reading simultaneously.
		const decisions = await Promise.all(
			Array.from({ length: 20 }, (_unused, index) =>
				reserveBudget(orgId, 1_000_000, {
					key: `spawn-${index}`,
					claimId,
					sessionId,
					repoId,
					actor: `human-${index}`,
					kind: "sandbox_spawn",
					repoOverrides: CAP_5_USD,
					now: NOW,
				}),
			),
		);

		const admitted = decisions.filter((decision) => decision.ok);
		const refused = decisions.filter((decision) => !decision.ok);
		expect(admitted).toHaveLength(5);
		expect(refused).toHaveLength(15);

		// Every refusal is a decision, not an error: the caller is told the cap, what
		// has been spent, and that nothing remains.
		for (const decision of refused) {
			if (decision.ok) throw new Error("unreachable");
			expect(decision.reason).toBe("org_cap_exhausted");
			expect(decision.capMicroUsd).toBe(5_000_000);
			expect(decision.spentMicroUsd).toBe(5_000_000);
			expect(decision.remainingMicroUsd).toBe(0);
		}

		// And the database agrees with the decisions: exactly five reservations, and
		// spend landed on the cap rather than over it.
		const rows = await db.select().from(costEvents).where(eq(costEvents.orgId, orgId));
		expect(rows).toHaveLength(5);
		expect(await spendToday(orgId, { now: NOW, repoOverrides: CAP_5_USD })).toBe(5_000_000);
	});

	it("counts a reservation against the cap the moment it is taken", async () => {
		const first = await reserveBudget(orgId, 4_000_000, {
			key: "turn-1",
			claimId,
			actor: "ana",
			repoOverrides: CAP_5_USD,
			now: NOW,
		});
		expect(first.ok).toBe(true);

		const second = await reserveBudget(orgId, 2_000_000, {
			key: "turn-2",
			claimId,
			actor: "ana",
			repoOverrides: CAP_5_USD,
			now: NOW,
		});
		expect(second.ok).toBe(false);
		if (second.ok) throw new Error("unreachable");
		expect(second.reason).toBe("org_cap_exhausted");
		expect(second.spentMicroUsd).toBe(4_000_000);
	});

	it("is idempotent: a retried reservation neither double-charges nor is refused", async () => {
		const first = await reserveBudget(orgId, 3_000_000, {
			key: "turn-1",
			claimId,
			actor: "ana",
			repoOverrides: CAP_5_USD,
			now: NOW,
		});
		const retry = await reserveBudget(orgId, 3_000_000, {
			key: "turn-1",
			claimId,
			actor: "ana",
			repoOverrides: CAP_5_USD,
			now: NOW,
		});

		expect(first.ok).toBe(true);
		expect(retry.ok).toBe(true);
		if (!first.ok || !retry.ok) throw new Error("unreachable");
		expect(retry.duplicate).toBe(true);
		expect(retry.reservationId).toBe(first.reservationId);
		// Two calls, one charge. Without the pre-check the retry would also have
		// been refused, because its own already-counted $3 plus another $3 exceeds
		// the $5 cap — a caller punished for surviving a crash.
		expect(await spendToday(orgId, { now: NOW, repoOverrides: CAP_5_USD })).toBe(3_000_000);
	});

	it("refuses a negative estimate as invalid rather than as over budget", async () => {
		const decision = await reserveBudget(orgId, -1, {
			key: "turn-1",
			repoOverrides: CAP_5_USD,
			now: NOW,
		});
		expect(decision.ok).toBe(false);
		if (decision.ok) throw new Error("unreachable");
		// A caller retrying on "over budget" would wait for tomorrow; a caller
		// seeing "invalid estimate" fixes its own arithmetic. Distinct reasons.
		expect(decision.reason).toBe("invalid_estimate");
		expect(decision.spentMicroUsd).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Automations
// ---------------------------------------------------------------------------

describe("automations", () => {
	it("charges an automation with no actor to the org cap, not to nobody", async () => {
		// The failure this guards: a per-user cap is configured, the automation has
		// no user, and an implementation that returns early when it cannot find a
		// user leaves the one unattended loop in the system uncapped.
		const filler = await reserveBudget(orgId, 4_500_000, {
			key: "human-turn",
			claimId,
			actor: "ana",
			actorCapMicroUsd: 10_000_000,
			repoOverrides: CAP_5_USD,
			now: NOW,
		});
		expect(filler.ok).toBe(true);

		const automation = await reserveBudget(orgId, 1_000_000, {
			key: "automation-run-1",
			claimId,
			actor: null,
			actorCapMicroUsd: 10_000_000,
			repoOverrides: CAP_5_USD,
			now: NOW,
		});

		expect(automation.ok).toBe(false);
		if (automation.ok) throw new Error("unreachable");
		expect(automation.reason).toBe("org_cap_exhausted");
	});

	it("records automation spend with a null actor and still attributes it to the claim", async () => {
		await recordCost({
			orgId,
			claimId,
			repoId,
			key: "automation-run-1",
			kind: "tokens",
			actor: null,
			microUsd: 250_000,
			createdAt: NOW,
		});

		const byActor = await spendByActor(orgId, { now: NOW });
		// The null bucket survives the grouping. Filtering it would hide the single
		// largest amplification path in the product from the one report that exists
		// to find it.
		expect(byActor).toEqual([{ actor: null, microUsd: 250_000 }]);

		const byClaim = await spendByClaim(orgId, { now: NOW });
		expect(byClaim).toEqual([{ claimId, microUsd: 250_000 }]);
	});

	it("applies a per-user cap to a human while the org still has room", async () => {
		const decision = await reserveBudget(orgId, 900_000, {
			key: "turn-1",
			claimId,
			actor: "ana",
			actorCapMicroUsd: 500_000,
			repoOverrides: CAP_5_USD,
			now: NOW,
		});

		expect(decision.ok).toBe(false);
		if (decision.ok) throw new Error("unreachable");
		expect(decision.reason).toBe("actor_cap_exhausted");
		expect(decision.capMicroUsd).toBe(500_000);
		// Nothing was written: a refusal is not a charge.
		expect(await spendToday(orgId, { now: NOW, repoOverrides: CAP_5_USD })).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Estimated versus final
// ---------------------------------------------------------------------------

describe("reservations and finals", () => {
	it("stops counting a reservation once its final lands, and never counts both", async () => {
		const reservation = await reserveBudget(orgId, 2_000_000, {
			key: "turn-1",
			claimId,
			sessionId,
			actor: "ana",
			kind: "provider_call",
			repoOverrides: CAP_5_USD,
			now: NOW,
		});
		expect(reservation.ok).toBe(true);
		expect(await spendToday(orgId, { now: NOW })).toBe(2_000_000);

		await finalizeReservation({
			orgId,
			claimId,
			sessionId,
			key: "turn-1",
			kind: "tokens",
			actor: "ana",
			microUsd: 750_000,
			createdAt: NOW,
		});

		// Estimate $2, actual $0.75. Net spend is the actual — both rows are still
		// on disk, which is what makes the estimate auditable after the fact.
		expect(await spendToday(orgId, { now: NOW })).toBe(750_000);
		const rows = await db.select().from(costEvents).where(eq(costEvents.orgId, orgId));
		expect(rows).toHaveLength(2);
	});

	it("frees the whole estimate when the work never ran", async () => {
		await reserveBudget(orgId, 4_000_000, {
			key: "turn-1",
			claimId,
			actor: "ana",
			repoOverrides: CAP_5_USD,
			now: NOW,
		});
		await releaseReservation({ orgId, claimId, key: "turn-1", kind: "provider_call" });

		expect(await spendToday(orgId, { now: NOW })).toBe(0);
		const next = await reserveBudget(orgId, 4_000_000, {
			key: "turn-2",
			claimId,
			actor: "ana",
			repoOverrides: CAP_5_USD,
			now: NOW,
		});
		expect(next.ok).toBe(true);
	});

	it("moves the money to the day the final landed rather than counting it twice", async () => {
		// A reservation at 23:59 whose turn finishes at 00:01. A day-scoped
		// supersession check would bill the estimate on day one and the actual on
		// day two — one turn, two charges, and no query that shows why.
		const boundary = utcDayStart(new Date("2026-03-15T00:00:00.000Z"));
		const reservedAt = new Date(boundary.getTime() - 60_000);
		const finalAt = new Date(boundary.getTime() + 60_000);
		const now = new Date(boundary.getTime() + 120_000);

		await recordCost({
			orgId,
			claimId,
			key: "turn-1",
			kind: "provider_call",
			status: "reserved",
			actor: "ana",
			microUsd: 900_000,
			createdAt: reservedAt,
		});
		await recordCost({
			orgId,
			claimId,
			key: "turn-1",
			kind: "tokens",
			status: "final",
			actor: "ana",
			microUsd: 400_000,
			createdAt: finalAt,
		});

		expect(await spendToday(orgId, { now })).toBe(400_000);
		const yesterday = new Date(boundary.getTime() - 3_600_000);
		expect(
			await spendToday(orgId, {
				now,
				from: utcDayStart(yesterday),
				to: utcDayEnd(yesterday),
			}),
		).toBe(0);
	});

	it("drops a reservation that outlived a turn, at exactly the horizon", async () => {
		// Without this, a crashed process's reservation counts against the cap for
		// the rest of the day; a few of those ratchet the effective cap to zero and
		// the symptom is "nothing starts" beside a spend report showing no usage.
		const overrides = { maxSpendPerDayMicroUsd: 5_000_000, agentTurnTimeoutMs: 600_000 };
		const cutoff = new Date(NOW.getTime() - 600_000);

		await recordCost({
			orgId,
			claimId,
			key: "alive",
			kind: "provider_call",
			status: "reserved",
			microUsd: 1_000_000,
			createdAt: cutoff,
		});
		await recordCost({
			orgId,
			claimId,
			key: "abandoned",
			kind: "provider_call",
			status: "reserved",
			microUsd: 1_000_000,
			createdAt: new Date(cutoff.getTime() - 1),
		});

		// Exactly on the horizon still counts; one millisecond older does not.
		expect(await spendToday(orgId, { now: NOW, repoOverrides: overrides })).toBe(1_000_000);
	});
});

// ---------------------------------------------------------------------------
// Idempotent writes
// ---------------------------------------------------------------------------

describe("recordCost", () => {
	it("collides with its own retry instead of charging twice", async () => {
		const write = { orgId, claimId, key: "turn-1", kind: "tokens" as const, microUsd: 123_456 };
		const first = await recordCost({ ...write, createdAt: NOW });
		const second = await recordCost({ ...write, createdAt: NOW });

		expect(first.duplicate).toBe(false);
		expect(second.duplicate).toBe(true);
		expect(second.inserted).toBe(0);
		expect(second.ids).toEqual(first.ids);
		expect(await spendToday(orgId, { now: NOW })).toBe(123_456);
	});

	it("derives the same id from the same tuple and a different one otherwise", () => {
		const ref = { orgId, claimId, sessionId, key: "turn-1" };
		expect(costEventId(ref, "final", "tokens", 0)).toBe(costEventId(ref, "final", "tokens", 0));
		// A reservation and its final are two rows and must not collide.
		expect(costEventId(ref, "final", "tokens", 0)).not.toBe(
			costEventId(ref, "reserved", "tokens", 0),
		);
		expect(costEventId(ref, "final", "tokens", 0)).not.toBe(
			costEventId({ ...ref, key: "turn-2" }, "final", "tokens", 0),
		);
		// v5 shape, so anything that parses UUIDs sees an ordinary one.
		expect(costEventId(ref, "final", "tokens", 0)).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});

	it("splits a charge larger than the column can hold instead of aborting the transaction", async () => {
		// int4 tops out near $2,147. Postgres raises rather than wrapping, which
		// would take down the turn that earned the charge.
		const write = await recordCost({
			orgId,
			claimId,
			key: "huge",
			kind: "provider_call",
			microUsd: 3_000_000_000,
			quantity: 42,
			createdAt: NOW,
		});

		expect(write.ids).toHaveLength(2);
		expect(write.inserted).toBe(2);
		expect(await spendToday(orgId, { now: NOW })).toBe(3_000_000_000);

		const rows = await db.select().from(costEvents).where(eq(costEvents.orgId, orgId));
		// Quantity rides entirely on the first part, so summing it stays truthful.
		expect(rows.reduce((total, row) => total + row.quantity, 0)).toBe(42);

		// And the split is still idempotent as a whole.
		const retry = await recordCost({
			orgId,
			claimId,
			key: "huge",
			kind: "provider_call",
			microUsd: 3_000_000_000,
			quantity: 42,
			createdAt: NOW,
		});
		expect(retry.inserted).toBe(0);
	});

	it("prices and stamps token usage in one call", async () => {
		const { quote, write } = await recordTokenUsage({
			orgId,
			claimId,
			sessionId,
			repoId,
			key: "turn-1",
			actor: "ana",
			model: "claude-opus-5",
			usage: { inputTokens: 1_000_000, outputTokens: 100_000 },
			createdAt: NOW,
		});

		expect(quote.priced).toBe(true);
		expect(quote.microUsd).toBe(5_000_000 + 2_500_000);
		expect(write.microUsd).toBe(7_500_000);

		const [row] = await db.select().from(costEvents).where(eq(costEvents.orgId, orgId));
		expect(row!.model).toBe(`claude-opus-5@${PRICING_VERSION}`);
		expect(row!.provider).toBe("anthropic");
		expect(row!.quantity).toBe(1_100_000);
		expect(decodeModelStamp(row!.model)).toEqual({
			model: "claude-opus-5",
			pricingVersion: PRICING_VERSION,
			unpriced: false,
		});
	});

	it("marks a row from an unknown model unpriced rather than guessing a number", async () => {
		const { quote } = await recordTokenUsage({
			orgId,
			claimId,
			key: "turn-1",
			model: "some-model-that-does-not-exist",
			usage: { inputTokens: 5_000, outputTokens: 5_000 },
			createdAt: NOW,
		});

		expect(quote.priced).toBe(false);
		expect(quote.microUsd).toBe(0);

		const [row] = await db.select().from(costEvents).where(eq(costEvents.orgId, orgId));
		expect(row!.microUsd).toBe(0);
		const decoded = decodeModelStamp(row!.model);
		// The gap is visible in the row itself, and it still says which price list
		// failed to price it — so re-pricing after the table is updated is possible.
		expect(decoded?.unpriced).toBe(true);
		expect(decoded?.pricingVersion).toBe(PRICING_VERSION);
	});
});

// ---------------------------------------------------------------------------
// UTC day semantics
// ---------------------------------------------------------------------------

describe("UTC day boundaries", () => {
	it("includes midnight UTC and excludes the millisecond before it", async () => {
		const start = utcDayStart(NOW);

		await recordCost({
			orgId,
			claimId,
			key: "at-midnight",
			kind: "tokens",
			microUsd: 10,
			createdAt: start,
		});
		await recordCost({
			orgId,
			claimId,
			key: "before-midnight",
			kind: "tokens",
			microUsd: 999,
			createdAt: new Date(start.getTime() - 1),
		});
		await recordCost({
			orgId,
			claimId,
			key: "at-next-midnight",
			kind: "tokens",
			microUsd: 555,
			createdAt: utcDayEnd(NOW),
		});

		expect(await spendToday(orgId, { now: NOW })).toBe(10);
	});

	it("computes day keys in UTC regardless of the host's timezone", () => {
		// 23:30 UTC is already the next day in Sydney and still the previous one in
		// Los Angeles. Both must agree that it is the 15th, or two operators running
		// the same report disagree and neither is wrong.
		const late = new Date("2026-03-15T23:30:00.000Z");
		expect(utcDayKey(late)).toBe("2026-03-15");
		expect(utcDayStart(late).toISOString()).toBe("2026-03-15T00:00:00.000Z");
		expect(utcDayEnd(late).toISOString()).toBe("2026-03-16T00:00:00.000Z");
	});

	it("groups spendByDay on the UTC calendar", async () => {
		await recordCost({
			orgId,
			claimId,
			key: "a",
			kind: "tokens",
			microUsd: 100,
			createdAt: new Date("2026-03-14T23:59:59.999Z"),
		});
		await recordCost({
			orgId,
			claimId,
			key: "b",
			kind: "tokens",
			microUsd: 200,
			createdAt: new Date("2026-03-15T00:00:00.000Z"),
		});

		const days = await spendByDay(orgId, { now: NOW, days: 3 });
		expect(days).toEqual([
			{ day: "2026-03-14", microUsd: 100 },
			{ day: "2026-03-15", microUsd: 200 },
		]);
	});
});

// ---------------------------------------------------------------------------
// Reporting and the breach policy
// ---------------------------------------------------------------------------

describe("budgetStatus", () => {
	it("reports the cap, the spend and what is left", async () => {
		await recordCost({
			orgId,
			claimId,
			key: "turn-1",
			kind: "tokens",
			microUsd: 1_500_000,
			createdAt: NOW,
		});

		const status = await budgetStatus(orgId, { now: NOW, repoOverrides: CAP_5_USD });
		expect(status).toEqual({
			capMicroUsd: 5_000_000,
			spentMicroUsd: 1_500_000,
			remainingMicroUsd: 3_500_000,
			exhausted: false,
		});

		const admission = await canAdmitNewWork(orgId, { now: NOW, repoOverrides: CAP_5_USD });
		expect(admission.admit).toBe(true);
	});

	it("stops admitting new work on breach but still records what running work spends", async () => {
		await recordCost({
			orgId,
			claimId,
			key: "turn-1",
			kind: "tokens",
			microUsd: 5_000_000,
			createdAt: NOW,
		});

		const status = await budgetStatus(orgId, { now: NOW, repoOverrides: CAP_5_USD });
		expect(status.exhausted).toBe(true);
		expect(status.remainingMicroUsd).toBe(0);

		const refused = await reserveBudget(orgId, 1, {
			key: "turn-2",
			claimId,
			repoOverrides: CAP_5_USD,
			now: NOW,
		});
		expect(refused.ok).toBe(false);

		// The turn that is already running keeps writing its own cost. Refusing this
		// would not save the money — it is already spent — it would only delete the
		// record of it, which is the one thing that makes the overspend explicable.
		const write = await recordCost({
			orgId,
			claimId,
			key: "turn-1-continued",
			kind: "tokens",
			microUsd: 400_000,
			createdAt: NOW,
		});
		expect(write.inserted).toBe(1);
		expect(await spendToday(orgId, { now: NOW, repoOverrides: CAP_5_USD })).toBe(5_400_000);
	});

	it("groups spend by repo", async () => {
		await recordCost({
			orgId,
			claimId,
			repoId,
			key: "a",
			kind: "tokens",
			microUsd: 300,
			createdAt: NOW,
		});
		await recordCost({ orgId, claimId, key: "b", kind: "tokens", microUsd: 100, createdAt: NOW });

		expect(await spendByRepo(orgId, { now: NOW })).toEqual([
			{ repoId, microUsd: 300 },
			{ repoId: null, microUsd: 100 },
		]);
	});
});

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

describe("cost kind encoding", () => {
	it("round-trips status, kind and supersession key", () => {
		const hash = spendKeyHash({ orgId, claimId, key: "turn-1" });
		const encoded = encodeCostKind("reserved", "sandbox_seconds", hash);
		expect(encoded).toBe(`reserved:sandbox_seconds#${hash}`);
		expect(decodeCostKind(encoded)).toEqual({
			ok: true,
			status: "reserved",
			kind: "sandbox_seconds",
			keyHash: hash,
		});
	});

	it("distinguishes a hand-written row from one written by a newer deploy", () => {
		// Both are "cannot decode", and treating them alike sends somebody hunting
		// for corruption during what is actually a normal rolling deploy.
		expect(decodeCostKind("tokens")).toEqual({ ok: false, reason: "malformed", raw: "tokens" });
		expect(decodeCostKind("final:carbon_offset#abcd")).toEqual({
			ok: false,
			reason: "unknown_kind",
			raw: "final:carbon_offset#abcd",
		});
		expect(decodeCostKind("pending:tokens#abcd")).toEqual({
			ok: false,
			reason: "unknown_status",
			raw: "pending:tokens#abcd",
		});
	});

	it("gives the same supersession key to a reservation and its final", () => {
		const ref = { orgId, claimId, sessionId, key: "turn-1" };
		// The kind is deliberately outside the hash: a spawn estimate is superseded
		// by the token row that records what the turn actually cost.
		expect(spendKeyHash(ref)).toBe(spendKeyHash({ ...ref }));
		expect(spendKeyHash(ref)).not.toBe(spendKeyHash({ ...ref, key: "turn-2" }));
	});
});

// ---------------------------------------------------------------------------
// Pricing: pure, zero mocks, boundary values
// ---------------------------------------------------------------------------

describe("pricing", () => {
	it("prices input, output and cache tokens at their own rates", () => {
		const quote = priceTokens("claude-sonnet-5", {
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
			cacheReadTokens: 1_000_000,
			cacheWriteTokens: 1_000_000,
		});
		if (!quote.priced) throw new Error("expected a priced quote");
		// $3 input + $15 output + $0.30 cache read + $3.75 cache write. Folding a
		// cache read into the input rate would overstate this row tenfold, on
		// exactly the long-context workload Harbor runs most of.
		expect(quote.microUsd).toBe(3_000_000 + 15_000_000 + 300_000 + 3_750_000);
		expect(quote.pricingVersion).toBe(PRICING_VERSION);
		expect(quote.provider).toBe("anthropic");
	});

	it("rounds half up at exactly a half micro-USD", () => {
		// Claude Haiku 3 input is $0.25/MTok, i.e. a quarter of a micro-USD per
		// token — the only place the arithmetic has to decide anything.
		expect(priceTokens("claude-3-haiku-20240307", { inputTokens: 1, outputTokens: 0 })).toMatchObject({
			microUsd: 0,
		});
		expect(priceTokens("claude-3-haiku-20240307", { inputTokens: 2, outputTokens: 0 })).toMatchObject({
			microUsd: 1,
		});
		expect(priceTokens("claude-3-haiku-20240307", { inputTokens: 3, outputTokens: 0 })).toMatchObject({
			microUsd: 1,
		});
		// Truncating instead would lose a fraction of a micro-USD on every row, in
		// the same direction, and an org would quietly exceed a cap it believes it
		// is under.
	});

	it("stays exact where float64 multiplication has already lost precision", () => {
		const tokens = 9_876_543_210_987;
		const perMillion = 150_000; // gpt-4o-mini input
		expect(Number.isSafeInteger(tokens * perMillion)).toBe(false);
		const quote = priceTokens("gpt-4o-mini", { inputTokens: tokens, outputTokens: 0 });
		expect(quote.microUsd).toBe(1_481_481_481_648);
	});

	it("prices zero tokens at zero without claiming to be unpriced", () => {
		const quote = priceTokens("claude-opus-5", { inputTokens: 0, outputTokens: 0 });
		expect(quote.priced).toBe(true);
		expect(quote.microUsd).toBe(0);
	});

	it("never guesses a price for a model it does not know", () => {
		const quote = priceTokens("gpt-9-omni", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
		expect(quote).toEqual({
			priced: false,
			microUsd: 0,
			pricingVersion: PRICING_VERSION,
			model: "gpt-9-omni",
			provider: null,
			reason: "unknown_model",
		});
	});

	it("separates a missing model from a missing price and from missing usage", () => {
		expect(priceTokens(null, { inputTokens: 10, outputTokens: 10 })).toMatchObject({
			reason: "no_model_reported",
		});
		expect(priceTokens("claude-opus-5", { inputTokens: -5, outputTokens: 0 })).toMatchObject({
			reason: "invalid_usage",
		});
		expect(
			priceAgentUsage({
				source: "unavailable",
				input_tokens: 0,
				output_tokens: 0,
				model: "claude-opus-5",
			}),
		).toMatchObject({ reason: "usage_unavailable" });
	});

	it("defers to the agent's own money and says so in the stamp", () => {
		// The adapter has seen the provider's accounting for that call, including
		// discounts this table cannot know about. Re-pricing it would replace a real
		// figure with an estimate that disagrees with the invoice.
		const quote = priceAgentUsage({
			source: "agent_reported",
			input_tokens: 1_000,
			output_tokens: 1_000,
			model: "claude-opus-5",
			micro_usd: 4_242,
		});
		expect(quote).toMatchObject({ priced: true, microUsd: 4_242 });
		if (!quote.priced) throw new Error("unreachable");
		expect(quote.pricingVersion).toBe(AGENT_REPORTED_STAMP);
		expect(stampModel("claude-opus-5", quote)).toBe(`claude-opus-5@${AGENT_REPORTED_STAMP}`);
	});

	it("folds dated, Bedrock and Vertex spellings onto the model they name", () => {
		expect(normalizeModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
		expect(normalizeModelId("us.anthropic.claude-opus-5")).toBe("claude-opus-5");
		expect(normalizeModelId("claude-opus-4-5@20251101")).toBe("claude-opus-4-5");
		expect(normalizeModelId("anthropic/claude-sonnet-5")).toBe("claude-sonnet-5");
		// Decoration is removed; nothing is ever mapped onto a *different* model.
		expect(normalizeModelId("claude-quasar-9-20260101")).toBeNull();
		expect(lookupPrice("us.anthropic.claude-opus-5")?.outputPerMillion).toBe(25_000_000);
	});

	it("reads an unstamped model as un-reproducible rather than as priced", () => {
		expect(decodeModelStamp("claude-opus-5")).toEqual({
			model: "claude-opus-5",
			pricingVersion: null,
			unpriced: true,
		});
		expect(decodeModelStamp(null)).toBeNull();
	});
});
