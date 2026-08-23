// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { setting } from "@core/kernel/config.js";
import type { SandboxEvent, SandboxEventType, SessionEventType } from "../../../../contracts/index.js";
import { SANDBOX_EVENT_TYPES } from "../../../../contracts/index.js";
import { db } from "@core/schema/index.js";
import { artifacts, claims, sandboxes, sessions } from "@core/schema/schema.js";
import { openPullRequestForBranch } from "../../../../git/pull-request.js";
import { pinWorkingBranch, resolvePushBranch } from "../../../../git/working-branch.js";
import { assertNever } from "../../../../sandbox/decisions.js";
import { markSandboxReady, validateFence } from "../../../../sandbox/manager.js";
import { recordAgentUsage } from "../../../../lib/cost.js";
import { appendEvents } from "../../../../lib/session-events.js";
import {
	authenticateSandbox,
	completeTurn,
	describeFenceRefusal,
	fencingTokenFrom,
} from "../../../../lib/session-runner.js";

/**
 * The bridge's uplink: everything happening inside a sandbox, in batches.
 *
 * HTTP POST up and SSE down, rather than a WebSocket, and that is a deployment
 * decision rather than a preference — see the note on `SANDBOX_EVENT_TYPES` in
 * `src/contracts`. Every load balancer, corporate proxy and ingress controller an
 * adopter already runs handles POST without configuration; a meaningful fraction
 * of them mangle a protocol upgrade, and "works everywhere except behind your
 * customer's proxy" is not a property a self-hostable product can ship with.
 *
 * Three guards, in this order, and the order is deliberate:
 *
 *  1. **Size, from the declared length.** Cheapest, needs no database, and it is
 *     the one an unauthenticated caller can otherwise use to make the control
 *     plane buffer megabytes per request. Enforced again while reading, because
 *     `content-length` is a claim by the sender and this endpoint's whole premise
 *     is that the sender is not trusted.
 *  2. **Authentication**, against the sandbox's own token digest.
 *  3. **The fencing token.** Authentication is not enough and cannot be: a box
 *     whose lease lapsed still holds a genuine credential. Only the fence
 *     distinguishes the current box from an honest zombie, and without it two
 *     agents interleave sentences into one transcript — a failure that reads as
 *     the model being incoherent rather than as two writers.
 */
export const dynamic = "force-dynamic";

/** The shape `session_prompts.id` has, checked before a payload value reaches it. */
const PROMPT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The ceiling on one ingest body.
 *
 * Derived from two settings that already exist rather than invented here: a batch
 * may carry at most `maxSnapshotEvents` events, and each event's payload is
 * truncated at `maxEventPayloadChars` before it is stored, so anything larger than
 * their product could not survive storage even if it were accepted. Deriving it
 * means an operator who raises either limit does not discover a second, hidden one
 * halfway down this file.
 *
 * A dedicated `maxIngestBodyBytes` would be better — this product overestimates by
 * whatever JSON overhead the payloads do not use — but adding a setting is a change
 * to `src/config.ts`, which this file does not own.
 */
function ingestCeilingBytes(): number {
	return setting("maxSnapshotEvents") * setting("maxEventPayloadChars");
}

/**
 * Read the body, refusing rather than buffering past the ceiling.
 *
 * `request.text()` would be one line and would buffer whatever arrives. The point
 * of a cap that is only checked after the read is that it is not a cap: the memory
 * has already been spent by the time it fires, which is exactly what a caller
 * sending a gigabyte wants.
 */
async function readBounded(request: Request, ceiling: number): Promise<string | "too_large"> {
	const body = request.body;
	if (!body) return "";

	const reader = body.getReader();
	const decoder = new TextDecoder();
	let total = 0;
	let text = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > ceiling) {
			// Cancel rather than drain. Reading the rest to be polite is reading the
			// rest, which is the thing being refused.
			await reader.cancel().catch(() => {});
			return "too_large";
		}
		text += decoder.decode(value, { stream: true });
	}
	text += decoder.decode();
	return text;
}

/**
 * How a sandbox event becomes a timeline event, exhaustively and with no `default`.
 *
 * `null` means "not for the timeline", and every one of those is a decision rather
 * than an omission:
 *
 *  - `heartbeat` is liveness. It updates a column; putting it on the timeline
 *    would bury every session under four events a minute of nothing happening.
 *  - `log` is a log. `session_events` is a timeline, and the difference is the
 *    whole reason that table is not a log pipeline — see the note on
 *    `maxEventPayloadChars`.
 *  - `snapshot_taken` records a provider handle on the sandbox row. There is no
 *    timeline variant for it, and inventing one here would break the rule that a
 *    new event type lands in `src/contracts` first.
 *
 * `agent_failed` maps to `agent_finished` carrying `failed: true`, deliberately
 * NOT to `session_error`. The contract reserves `session_error` for Harbor itself
 * breaking; an agent that could not do the task did its job badly, which is a
 * different fact. Merging them makes "how often do agents fail" and "how often
 * does the platform fail" the same unanswerable number.
 */
function timelineTypeFor(type: SandboxEventType): SessionEventType | null {
	switch (type) {
		case "boot_started":
		case "boot_progress":
			return "sandbox_spawning";
		case "boot_ready":
			return "sandbox_ready";
		case "boot_failed":
			return "sandbox_failed";
		case "heartbeat":
			return null;
		case "agent_message":
			return "agent_message";
		case "agent_tool_call":
			return "agent_tool_call";
		case "agent_finished":
		case "agent_failed":
			return "agent_finished";
		case "branch_pushed":
			return "artifact_created";
		case "snapshot_taken":
			return null;
		case "log":
			return null;
	}
	return assertNever(type, "timelineTypeFor");
}

function isSandboxEventType(value: unknown): value is SandboxEventType {
	return typeof value === "string" && (SANDBOX_EVENT_TYPES as readonly string[]).includes(value);
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const ceiling = ingestCeilingBytes();

	const declared = Number(request.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > ceiling) {
		return NextResponse.json(
			{
				error: `That batch is ${declared} bytes; the ceiling is ${ceiling}.`,
				reason: "body_too_large",
			},
			{ status: 413 },
		);
	}

	const auth = await authenticateSandbox(id, request.headers);
	if (!auth.ok) {
		return NextResponse.json({ error: auth.message, reason: auth.reason }, { status: 401 });
	}

	const header = fencingTokenFrom(request.headers);
	if (!header.ok) {
		return NextResponse.json({ error: header.message, reason: header.reason }, { status: 409 });
	}
	const fence = await validateFence(auth.sandbox.id, header.token);
	if (!fence.valid) {
		// 409, not 403. The request was authentic and the caller is not forbidden in
		// general — it is out of date, and the difference is what tells a bridge
		// author to stop and re-register rather than to check its credentials.
		return NextResponse.json(
			{ error: describeFenceRefusal(fence), reason: fence.reason },
			{ status: 409 },
		);
	}

	const raw = await readBounded(request, ceiling);
	if (raw === "too_large") {
		return NextResponse.json(
			{
				error:
					`That batch exceeds ${ceiling} bytes. Send fewer events per call; the bridge's `
					+ "buffer is bounded for the same reason this is.",
				reason: "body_too_large",
			},
			{ status: 413 },
		);
	}

	let parsed: unknown;
	try {
		parsed = raw.trim() === "" ? [] : JSON.parse(raw);
	} catch {
		return NextResponse.json(
			{ error: "Body is not JSON.", reason: "malformed_body" },
			{ status: 400 },
		);
	}

	const incoming: unknown[] = Array.isArray(parsed)
		? parsed
		: Array.isArray((parsed as { events?: unknown }).events)
			? ((parsed as { events: unknown[] }).events)
			: [];

	const countCap = setting("maxSnapshotEvents");
	if (incoming.length > countCap) {
		return NextResponse.json(
			{
				error: `That batch carries ${incoming.length} events; the cap is ${countCap}.`,
				reason: "too_many_events",
			},
			{ status: 413 },
		);
	}

	const events = incoming.filter(
		(entry): entry is SandboxEvent =>
			typeof entry === "object" && entry !== null && "type" in entry,
	);

	// A sandbox may write into exactly one session's transcript: its own. The
	// session comes from the row, never from the body — a box that could name its
	// session could write into any room in the org, which is the same class of hole
	// as a client naming its own prompt author. One mismatched event refuses the
	// whole batch rather than being dropped quietly, because a bridge that has the
	// wrong session id is broken and should be told, not partially served.
	const foreign = events.find(
		(event) => typeof event.session_id === "string" && event.session_id !== auth.sandbox.sessionId,
	);
	if (foreign) {
		return NextResponse.json(
			{
				error: "That event names a session this sandbox does not belong to.",
				reason: "session_mismatch",
			},
			{ status: 403 },
		);
	}

	const now = new Date();
	// Any authenticated, correctly fenced call proves the box is alive, so liveness
	// is a byproduct of the traffic rather than a separate message that a busy
	// bridge can starve. The same reasoning as `agent_presence` in `work.ts`.
	await db
		.update(sandboxes)
		.set({ lastHeartbeatAt: now })
		.where(eq(sandboxes.id, auth.sandbox.id));

	const appendable: Array<{
		type: SessionEventType;
		payload: Record<string, unknown> | null;
		actor: string | null;
	}> = [];
	let ignored = 0;
	const finishes: Array<{ outcome: "completed" | "failed"; payload: Record<string, unknown> }> = [];
	let readyReport: { bootMode: string | null } | null = null;
	const pushes: Array<Record<string, unknown>> = [];

	for (const event of events) {
		// An unrecognised type is counted and skipped rather than failing the batch.
		// A newer bridge sending one variant this build has never heard of must not
		// cost the operator the ninety-nine events around it — the whole point of
		// batching is that one bad element is not a lost turn.
		if (!isSandboxEventType(event.type)) {
			ignored += 1;
			continue;
		}

		// The bridge's buffer-overflow gap marker rides on `log`, and it is the
		// one log that is RECORD rather than log: the bridge dropped events during
		// a partition and built a visible marker saying so. `timelineTypeFor` is a
		// type-only function and correctly maps `log` to null, so the marker is
		// picked out here by its code, before that mapping discards it. This route
		// used to drop it with the rest of the logs — the visible-gap design was
		// built, tested, sent, and thrown away at the receiving end, so the
		// transcript showed an unbroken timeline across a window where events
		// were destroyed.
		if (event.type === "log") {
			const code = (event.payload as { code?: unknown } | undefined)?.code;
			if (code === "bridge.buffer_overflow") {
				appendable.push({
					type: "transcript_gap",
					actor: "harbor",
					payload: gapPayloadFrom(event, auth.sandbox.id, fence.token),
				});
				continue;
			}
			ignored += 1;
			continue;
		}

		const timelineType = timelineTypeFor(event.type);
		if (timelineType === null) {
			ignored += 1;
			continue;
		}

		const payload: Record<string, unknown> = {
			...(event.payload ?? {}),
			sandbox_event: event.type,
			sandbox_id: auth.sandbox.id,
			fencing_token: fence.token,
		};
		if (event.trace_id) payload.trace_id = event.trace_id;
		// The sandbox's own clock, carried for display and never for ordering. Order
		// is `seq`, allocated here, because two boxes with skewed clocks would
		// otherwise interleave a transcript by whichever machine was running fast.
		if (event.at) payload.sandbox_at = event.at;
		if (event.type === "agent_failed") payload.failed = true;

		appendable.push({ type: timelineType, payload, actor: "agent" });

		// `boot_ready` is the only event in the batch that carries a *lifecycle*
		// transition and not just a timeline entry, and it has to be applied to the
		// sandbox row rather than merely recorded. Without it nothing anywhere writes
		// `sandboxes.ready_at`, so `evaluateConnectingTimeout` still sees a box that
		// has never said hello — and `onConnectingTimeout` reaps every healthy sandbox
		// in the fleet exactly `sandboxBootTimeoutMs` after it was created, mid-turn,
		// reporting `boot_timeout` for a box that booted successfully minutes earlier.
		if (event.type === "boot_ready") {
			const mode = (event.payload as { mode?: unknown } | undefined)?.mode;
			readyReport = { bootMode: typeof mode === "string" ? mode : null };
		}

		// `branch_pushed` is the third event that carries a STATE TRANSITION and not
		// merely a timeline entry — alongside `boot_ready` above and `agent_finished`
		// below. Before this, it mapped to an `artifact_created` row and stopped
		// there: no branch was pinned, no artifact was inserted, and nothing ever
		// called `openPullRequest`. The whole pull-request half of the product was
		// unreachable because of the four lines that are now here.
		if (event.type === "branch_pushed") pushes.push(payload);

		if (event.type === "agent_finished" || event.type === "agent_failed") {
			finishes.push({
				outcome: event.type === "agent_finished" ? "completed" : "failed",
				payload,
			});
		}
	}

	// Applied before the batch is appended so that a box which reports ready and
	// then immediately streams output cannot be reaped by a sweep running between
	// the two writes. `announce: false` because the `sandbox_ready` entry is already
	// in `appendable`, carrying the bridge's own boot payload.
	if (readyReport !== null) {
		await markSandboxReady(auth.sandbox.id, {
			now,
			bootMode: readyReport.bootMode,
			announce: false,
		});
	}

	const appended = await appendEvents({
		orgId: auth.sandbox.orgId,
		sessionId: auth.sandbox.sessionId,
		events: appendable,
	});

	// Pushes are handled BEFORE the turn is closed, so the pull request link is on
	// the timeline while the person who asked is still watching the turn run —
	// rather than arriving after the room has already said the agent finished.
	//
	// A failure here never fails the ingest. The branch is pushed either way; the
	// transcript is the priority; and `sweepDeferredPullRequests` picks up anything
	// this pass could not finish.
	for (const push of pushes) {
		try {
			await recordBranchPush({
				orgId: auth.sandbox.orgId,
				sessionId: auth.sandbox.sessionId,
				payload: push,
			});
		} catch (error) {
			console.error("[ingest] branch push recorded on the timeline but not opened:", error);
		}
	}

	// The turn is closed *after* its events are on the timeline. The other order
	// puts `prompt_finished` at a lower seq than the agent's last sentence, so a
	// client that stops rendering at the finish marker loses the end of the answer.
	for (const finish of finishes) {
		// The prompt is NAMED, never inferred. `completeTurn` falls back to the oldest
		// in-flight prompt when it is not told which one, and that fallback closes the
		// wrong turn under two ordinary conditions: a batch re-sent after its response
		// was lost (the POST committed, the bridge never saw the 200, and the retry's
		// `agent_finished` would then finish whatever prompt is running *now*), and a
		// session with a second prompt already delivered behind the one that just
		// ended. The visible failure is a running turn marked completed, its lease
		// handed back, and the answer that arrives afterwards closing yet another
		// prompt. Naming it makes the retry an exact no-op instead: the named row is no
		// longer `delivered`, so nothing matches.
		// Shape-checked before it reaches a `uuid` column: the payload is written by
		// the sandbox, and a non-uuid there would raise `invalid input syntax for type
		// uuid` and turn an authenticated caller's typo into a 500. A malformed id
		// falls back to the oldest in-flight prompt, which is what this endpoint did
		// for every event before this change.
		// Recorded whether the turn completed or failed: a failed turn still advanced
		// the agent's conversation, and resuming it is what lets the next prompt say
		// "that didn't work, try the other way" and be understood.
		try {
			await rememberResumeToken({
				orgId: auth.sandbox.orgId,
				sessionId: auth.sandbox.sessionId,
				payload: finish.payload,
			});
		} catch (error) {
			console.error("[ingest] resume token not persisted (the turn is recorded):", error);
		}

		const promptId = finish.payload.prompt_id;
		const namedPrompt = typeof promptId === "string" && PROMPT_UUID.test(promptId);
		const completion = await completeTurn({
			orgId: auth.sandbox.orgId,
			sessionId: auth.sandbox.sessionId,
			outcome: finish.outcome,
			...(namedPrompt ? { promptId: promptId as string } : {}),
			detail: { sandbox_id: auth.sandbox.id, trace_id: finish.payload.trace_id ?? null },
			now,
		});

		// THE COST ROW. Every finished turn carries the agent's usage block, and
		// this is where it becomes a `cost_events` row attributed to the session's
		// lease — the write that makes the daily cap mean something, because a cap
		// checked against a table nothing writes to can never trip.
		//
		// A failure here is logged and never fails the ingest: the transcript is
		// the priority, and this batch is retryable — the row's id is derived from
		// the prompt id, so the bridge's retry of a lost 200 records it then and a
		// double-recorded batch is absorbed as a duplicate.
		const usage = usageFrom(finish.payload);
		const costKey =
			(namedPrompt ? (promptId as string) : null) ?? completion.finished[0] ?? null;
		if (usage !== null && costKey !== null) {
			try {
				await recordAgentUsage({
					orgId: auth.sandbox.orgId,
					sessionId: auth.sandbox.sessionId,
					claimId: await activeClaimForSession(auth.sandbox.sessionId),
					key: costKey,
					usage,
					createdAt: now,
				});
			} catch (error) {
				console.error(
					`[ingest] cost row for prompt ${costKey} failed (turn is recorded, spend is not):`,
					error,
				);
			}
		}
	}

	return NextResponse.json({
		ok: true,
		appended: appended.length,
		ignored,
		through_seq: appended.length > 0 ? appended[appended.length - 1]!.seq : null,
	});
}

/**
 * A reported push becomes a pinned branch, an artifact, and a pull request.
 *
 * The order is the recovery story. The branch is pinned first, so a crash after
 * this point cannot leave a later turn deriving a *second* branch from a newer
 * lease. The artifact is written second, so the work is findable in the room even
 * if the pull request never opens. The pull request is last, because it is the
 * only step that depends on an external host and therefore the only one that can
 * be slow or unavailable.
 *
 * Every field is read out of the payload by name and shape-checked. The sandbox
 * wrote this object and the sandbox is not trusted — spreading it into a database
 * row would let a compromised bridge choose its own branch, or its own repo.
 */
async function recordBranchPush(input: {
	orgId: string;
	sessionId: string;
	payload: Record<string, unknown>;
}): Promise<void> {
	const reported = typeof input.payload.branch === "string" ? input.payload.branch.trim() : "";
	if (reported === "") return;

	// The repository is resolved from the session, never from the payload. A box
	// that could name its own repo could have Harbor open a pull request against
	// any repository the installation can reach.
	const target = await resolvePushBranch(input.orgId, input.sessionId);
	if (!target.repoId) return;

	// AND SO IS THE BRANCH. The sandbox is told where to push on the prompt
	// command; what it reports back is only an acknowledgement, and it is checked
	// against the answer rather than believed. A box that could name its own
	// branch could report `main`, and Harbor would pin `main` as the session's
	// working branch — after which every later boot checks `main` out as the
	// working branch and every later push from this session targets it. The
	// credential broker cannot stop that: pushing to `main` is inside the scope of
	// a legitimately minted write token. Only this comparison stops it.
	//
	// Once pinned, `target.branch` IS the pin, so a second push is checked against
	// the same value the first one established.
	if (target.branch === null || reported !== target.branch) {
		console.error(
			`[ingest] session ${input.sessionId} reported a push to ${JSON.stringify(reported)}, `
				+ `which is not the branch it was given (${JSON.stringify(target.branch)}). Nothing was `
				+ "pinned and no pull request was opened.",
		);
		return;
	}

	const pinned = await pinWorkingBranch({
		sessionId: input.sessionId,
		repoId: target.repoId,
		branch: reported,
	});

	// The branch artifact is inserted once. A second push to the same branch — the
	// ordinary case for a multi-turn session — updates a pull request that already
	// exists and needs no new row.
	const existing = await db
		.select({ id: artifacts.id, payload: artifacts.payload })
		.from(artifacts)
		.where(
			and(
				eq(artifacts.orgId, input.orgId),
				eq(artifacts.sessionId, input.sessionId),
				eq(artifacts.kind, "branch"),
			),
		);
	const already = existing.some(
		(row) => (row.payload as { branch?: unknown } | null)?.branch === pinned,
	);

	if (!already) {
		await db.insert(artifacts).values({
			orgId: input.orgId,
			sessionId: input.sessionId,
			repoId: target.repoId,
			kind: "branch",
			title: pinned,
			url: null,
			payload: {
				branch: pinned,
				base: target.base,
				commit_sha: typeof input.payload.commit_sha === "string" ? input.payload.commit_sha : null,
				commits: typeof input.payload.commits === "number" ? input.payload.commits : null,
				// Surfaced rather than silently dropped: the agent stopped with edits it
				// never committed, and those edits are not in the branch.
				uncommitted_changes: input.payload.uncommitted_changes === true,
			},
		});
	}

	await openPullRequestForBranch({
		orgId: input.orgId,
		sessionId: input.sessionId,
		repoId: target.repoId,
		branch: pinned,
		base: target.base,
		promptId: typeof input.payload.prompt_id === "string" ? input.payload.prompt_id : null,
	});
}

/**
 * Carry the agent's own conversation id across a sandbox replacement.
 *
 * Written from `agent_finished` on the fenced ingest path — the same payload this
 * route already reads `prompt_id` out of — and read back by `resumeTokenForBoot`,
 * which hands it to a new box **only** when that box restored the filesystem the
 * transcript lives on.
 *
 * Stored with the runtime that minted it. A session's `runtime` column is
 * editable, and a Claude Code session id handed to OpenCode's `--session` is an
 * opaque first-turn failure rather than a useful resume.
 */
async function rememberResumeToken(input: {
	orgId: string;
	sessionId: string;
	payload: Record<string, unknown>;
}): Promise<void> {
	const token = input.payload.resume_token;
	// Null is meaningful and is NOT written: an adapter that reported no id this
	// turn has not forgotten the thread, and overwriting a good token with null
	// would lose the conversation on the next reboot. `createResumeTokenAccumulator`
	// applies the same rule inside the box.
	if (typeof token !== "string" || token.trim() === "") return;

	const [session] = await db
		.select({ runtime: sessions.runtime })
		.from(sessions)
		.where(and(eq(sessions.id, input.sessionId), eq(sessions.orgId, input.orgId)))
		.limit(1);

	await db
		.update(sessions)
		.set({ agentResumeToken: token.trim(), agentResumeRuntime: session?.runtime ?? null })
		.where(and(eq(sessions.id, input.sessionId), eq(sessions.orgId, input.orgId)));
}

/**
 * The gap marker's timeline payload: the KNOWN fields copied one by one, never
 * the whole payload spread. The sandbox wrote this object, and spreading it
 * verbatim would let a compromised bridge plant arbitrary keys on a
 * harbor-actored event — the one actor a reader trusts.
 */
function gapPayloadFrom(
	event: SandboxEvent,
	sandboxId: string,
	fencingToken: number,
): Record<string, unknown> {
	const payload = (event.payload ?? {}) as Record<string, unknown>;
	const copy = (value: unknown) =>
		typeof value === "number" || typeof value === "string" ? value : null;
	return {
		dropped_events: copy(payload.dropped_events),
		first_dropped_at: copy(payload.first_dropped_at),
		last_dropped_at: copy(payload.last_dropped_at),
		message: copy(payload.message),
		sandbox_event: event.type,
		sandbox_id: sandboxId,
		fencing_token: fencingToken,
		...(event.at ? { sandbox_at: event.at } : {}),
	};
}

/**
 * The agent's usage block, shape-checked field by field — this payload is
 * written by the sandbox, and the sandbox is not trusted. A malformed block
 * returns null and the turn is simply unbilled-but-visible, never a 500.
 */
function usageFrom(payload: Record<string, unknown>): Parameters<typeof recordAgentUsage>[0]["usage"] | null {
	const raw = payload.usage;
	if (typeof raw !== "object" || raw === null) return null;
	const candidate = raw as Record<string, unknown>;
	if (candidate.source !== "agent_reported" && candidate.source !== "unavailable") return null;
	if (typeof candidate.input_tokens !== "number" || !Number.isFinite(candidate.input_tokens)) {
		return null;
	}
	if (typeof candidate.output_tokens !== "number" || !Number.isFinite(candidate.output_tokens)) {
		return null;
	}
	const optionalNumber = (value: unknown): number | undefined =>
		typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
	return {
		source: candidate.source,
		input_tokens: Math.max(0, Math.round(candidate.input_tokens)),
		output_tokens: Math.max(0, Math.round(candidate.output_tokens)),
		cache_read_tokens: optionalNumber(candidate.cache_read_tokens),
		cache_write_tokens: optionalNumber(candidate.cache_write_tokens),
		model: typeof candidate.model === "string" ? candidate.model : null,
		micro_usd: optionalNumber(candidate.micro_usd),
	};
}

/**
 * The lease this spend attributes to: the active claim on the session's task.
 *
 * Null when the session has no task or the lease already lapsed — a legal row
 * (the spend rolls up to the org), not an error. A read failure also returns
 * null rather than throwing, because attribution must never be the reason a
 * transcript batch is refused; the money is still counted against the org cap.
 */
async function activeClaimForSession(sessionId: string): Promise<string | null> {
	try {
		const [session] = await db
			.select({ taskId: sessions.taskId })
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1);
		if (!session?.taskId) return null;
		const [holder] = await db
			.select({ id: claims.id })
			.from(claims)
			.where(and(eq(claims.taskId, session.taskId), isNull(claims.releasedAt)))
			.limit(1);
		return holder?.id ?? null;
	} catch {
		return null;
	}
}
