// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * May this session accept another prompt?
 *
 * One question, one total function, one place. The reason it is a module rather
 * than an `if` inside the runner is that the question is asked from at least four
 * places — the composer's POST, the runner's admission check, an automation that
 * targets an existing session, and a connector replying into a thread — and the
 * moment two of those disagree the product develops a state where the UI accepts
 * a message that the loop will never deliver. The user's experience of that bug is
 * "I typed and nothing happened", which is the least reportable failure there is.
 *
 * Two decisions here are deliberate and are the ones worth arguing about.
 *
 * **`completed` and `failed` are promptable.** Failure is precisely where a person
 * most wants to say "try again, differently". A session that locks itself the
 * moment a turn fails forces the user to open a new room, lose the transcript, and
 * re-explain the problem to a fresh agent — at exactly the moment they are already
 * annoyed. `completed` is the same argument in a better mood: "and now also do X"
 * is the single most common follow-up in a working session. Only an explicit human
 * act — archiving or cancelling — closes the door, because only a human knows that
 * the room is finished.
 *
 * **The switch has no `default`.** Adding a member to `SESSION_STATUSES` is a
 * compile error right here, which is the point: a new status must have its
 * promptability *decided* rather than inherited from whatever the fall-through
 * happened to do. A `default: return promptable` on this function is a silent
 * invitation to spend money in a state nobody thought about; a
 * `default: return refused` is a silent outage the first time somebody adds a
 * status. Neither is discoverable from the diff that introduces it.
 */

import { assertNever } from "../sandbox/decisions.js";

/**
 * Every state a session row can hold, as this build understands it.
 *
 * `sessions.status` is a `text` column with a default of `open` written by
 * `createSession`, so this list is a claim about our own code and not a guarantee
 * about the bytes in the row — an older process reads statuses a newer one wrote,
 * and `open` predates this vocabulary entirely. `classifySessionStatus` below is
 * the guard that keeps that reality out of the exhaustive switch.
 */
export const SESSION_STATUSES = [
	/** The room exists; nothing has run in it yet. */
	"created",
	/** A turn is in flight or the queue is being drained. */
	"active",
	/** The last turn ended normally. Still promptable — see the note above. */
	"completed",
	/** The last turn ended badly. Still promptable, and that is the whole point. */
	"failed",
	/** Filed away by a human. The one-way door. */
	"archived",
	/** Stopped by a human before it finished. Also a one-way door. */
	"cancelled",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * Strings in the column that are not in the vocabulary but are known to mean one
 * of its members.
 *
 * `open` is not hypothetical: it is what `createSession` writes today and what
 * every session in an existing deployment already holds. Treating it as an
 * unrecognised status would refuse every prompt in every pre-existing room the
 * moment this module shipped — a total outage caused by a rename. Aliases are
 * listed rather than pattern-matched so that each one is a decision somebody made
 * on purpose and can be deleted once a migration has rewritten the rows.
 */
const SESSION_STATUS_ALIASES: Readonly<Record<string, SessionStatus>> = {
	open: "active",
	running: "active",
	done: "completed",
	error: "failed",
};

/**
 * Map a raw column value onto the vocabulary, or say that it could not be mapped.
 *
 * Returning `null` rather than guessing is the whole reason this exists. The
 * alternative — coercing anything unfamiliar to `active` — means a status a newer
 * deployment invented to *stop* work would read, on an older process, as
 * permission to spend money on it.
 */
export function classifySessionStatus(raw: string): SessionStatus | null {
	const trimmed = raw.trim().toLowerCase();
	if ((SESSION_STATUSES as readonly string[]).includes(trimmed)) return trimmed as SessionStatus;
	return SESSION_STATUS_ALIASES[trimmed] ?? null;
}

/**
 * Why a prompt was refused. Typed, never a boolean, and note that the last member
 * is not a decision at all.
 *
 * `session_archived` and `session_cancelled` are *decisions*: the status was read,
 * it was understood, and the answer is no. `status_unrecognised` is the absence of
 * a decision — the column holds something this build has never heard of. Callers
 * that collapse the two get one of two bad outcomes and do not get to pick which
 * one they hit: treat "cannot determine" as promptable and a rolled-back deploy
 * silently accepts prompts into a state a newer version created to forbid them;
 * treat it as identical to "archived" and the user is told their session was
 * archived, which is a false statement about their data.
 *
 * Promptability is **authority** — it decides whether work may be admitted and
 * money may be spent — so the unrecognised case fails CLOSED, the same direction
 * as the org predicate in `appendEvents` and the budget reservation in `cost.ts`.
 * It is the opposite direction from the liveness checks in `src/sandbox`, where an
 * unknown status is treated as alive: wrongly reaping a live box destroys work in
 * flight, while wrongly admitting work is unbounded and irreversible. Both sites
 * carry this note because the two rules look contradictory when read apart.
 */
export const PROMPT_REFUSAL_REASONS = [
	"session_archived",
	"session_cancelled",
	"status_unrecognised",
] as const;
export type PromptRefusalReason = (typeof PROMPT_REFUSAL_REASONS)[number];

export type Promptability =
	| { promptable: true; status: SessionStatus }
	| {
			promptable: false;
			/** Null exactly when the status could not be classified at all. */
			status: SessionStatus | null;
			reason: PromptRefusalReason;
			/** Written for the person who typed the prompt, not for a log. */
			message: string;
	  };

/**
 * The total function. Every member of `SESSION_STATUSES`, no `default`.
 *
 * Total over the *type*, which is why `classifySessionStatus` has to run first for
 * anything that came out of the database — see `promptabilityOf`.
 */
export function promptability(status: SessionStatus): Promptability {
	switch (status) {
		case "created":
		case "active":
			return { promptable: true, status };

		// The two that look wrong and are not. A person whose agent just failed is
		// the person most likely to have something to say to it, and the transcript
		// they need in order to say it usefully lives in this session. Forcing a new
		// room throws that away at the worst possible moment.
		case "completed":
		case "failed":
			return { promptable: true, status };

		case "archived":
			return {
				promptable: false,
				status,
				reason: "session_archived",
				message:
					"This session is archived. Archiving is a deliberate human act, so it is not "
					+ "undone by typing into the room — unarchive it, or start a new session.",
			};

		case "cancelled":
			return {
				promptable: false,
				status,
				reason: "session_cancelled",
				message:
					"This session was cancelled. Somebody stopped it on purpose; a new prompt would "
					+ "quietly restart work they decided should not continue.",
			};
	}
	return assertNever(status, "promptability");
}

/**
 * The same question, asked about a raw column value.
 *
 * Separated from `promptability` so the exhaustive switch stays exhaustive over
 * the type. Folding the unrecognised case into that switch would require a
 * `default` branch, and the `default` branch is the exact thing this module exists
 * to avoid.
 */
export function promptabilityOf(rawStatus: string): Promptability {
	const status = classifySessionStatus(rawStatus);
	if (status === null) {
		return {
			promptable: false,
			status: null,
			reason: "status_unrecognised",
			message:
				`This session's status (${JSON.stringify(rawStatus)}) is not one this build `
				+ "understands, so Harbor cannot establish that prompting it is allowed. It is "
				+ "refusing rather than assuming — usually this means the control plane was rolled "
				+ "back to a version older than the one that wrote the row.",
		};
	}
	return promptability(status);
}
