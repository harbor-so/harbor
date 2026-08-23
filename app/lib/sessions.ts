// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Multiplayer sessions.
 *
 * A session is a room with work in it. Anyone with the link is in it, every
 * prompt carries its author, and input queues rather than interleaving.
 *
 * Three decisions here are corrections of the obvious design, and each fixes a
 * failure that is expensive to discover late:
 *
 *   1. NO OWNER. `sessions.createdBy` is provenance and confers nothing. The
 *      moment a session belongs to one person, "send it to a colleague and let
 *      them take it home" stops being retrofittable — permission checks, queries
 *      and UI all quietly assume one identity, and undoing that is a rewrite.
 *
 *   2. ATTRIBUTION IS NOT OPTIONAL. `author` is NOT NULL on every prompt. A room
 *      with three people steering has to answer "who asked for this?" months
 *      later, and attribution added afterwards is missing for everything already
 *      said.
 *
 *   3. INPUT QUEUES. When two people type at once, splicing both into a running
 *      agent's context mid-turn yields an agent following half of each
 *      instruction. That failure is silent and reads as the model being stupid
 *      rather than as a race, which is the worst kind of bug to ship. A queue
 *      makes ordering explicit and lets a second thought arrive while the agent
 *      is still working on the first — which is what people actually do.
 */

import { and, asc, desc, eq, sql as raw } from "drizzle-orm";
import { db } from "@core/schema/index.js";
import {
	sessionParticipants,
	sessionPrompts,
	sessions,
	tasks,
} from "@core/schema/schema.js";
import { snapshotSessionRepos } from "./repos.js";
import { HarborError, notifyChange } from "@core/kernel/work.js";

/**
 * 22 characters of base32, ~110 bits.
 *
 * The link is the credential, so it has to be unguessable — but it is also typed
 * into chat and read aloud, so the alphabet drops i/l/o/u to survive that trip.
 */
const KEY_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export function mintSessionKey(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(22));
	let key = "";
	for (const byte of bytes) key += KEY_ALPHABET[byte % KEY_ALPHABET.length];
	return key;
}

export interface CreateSessionInput {
	orgId: string;
	title: string;
	createdBy: string;
	taskId?: string;
	/**
	 * The repositories this session works in, primary first. Optional, because a
	 * session is a room and a room with no repository is a legitimate thing —
	 * somebody opening one to talk before there is anything to check out.
	 *
	 * Access is **not** checked here. It is checked at the door, against the
	 * requesting user's own token, before this is called: `createSession` has no
	 * token and no viewer, and giving it an optional one is how an access check
	 * ends up skipped on the path that did not pass it.
	 */
	repoIds?: string[];
	baseBranch?: string | null;
}

export async function createSession(input: CreateSessionInput) {
	const [session] = await db
		.insert(sessions)
		.values({
			orgId: input.orgId,
			key: mintSessionKey(),
			title: input.title,
			createdBy: input.createdBy,
			taskId: input.taskId ?? null,
			// The primary repository, denormalised onto the session for the places
			// that want one repo without joining. `session_repos` stays the truth.
			repoId: input.repoIds?.[0] ?? null,
			baseBranch: input.baseBranch ?? null,
		})
		.returning();

	if (input.repoIds && input.repoIds.length > 0) {
		await snapshotSessionRepos({
			orgId: input.orgId,
			sessionId: session!.id,
			repoIds: input.repoIds,
			baseBranch: input.baseBranch ?? null,
		});
	}

	// The creator is a participant like anybody else — not an owner, just the
	// first person through the door.
	await joinSession(session!.id, input.orgId, input.createdBy, "human");
	await notifyChange(input.orgId, "session_created");
	return session!;
}

/** Resolve a shareable key. Scoped by org so a key from another tenant misses. */
export async function sessionByKey(orgId: string, key: string) {
	return db.query.sessions.findFirst({
		where: and(eq(sessions.orgId, orgId), eq(sessions.key, key)),
	});
}

/**
 * Opening the link is joining.
 *
 * Idempotent, because the common case is somebody reloading the page, and a
 * second row would double them in the participant list.
 */
export async function joinSession(
	sessionId: string,
	orgId: string,
	participant: string,
	kind: "human" | "agent" = "human",
) {
	const now = new Date();
	await db
		.insert(sessionParticipants)
		.values({ orgId, sessionId, participant, kind, joinedAt: now, lastSeenAt: now })
		.onConflictDoUpdate({
			target: [sessionParticipants.sessionId, sessionParticipants.participant],
			set: { lastSeenAt: now },
		});
	await notifyChange(orgId, "session_joined");
}

export async function participantsOf(sessionId: string) {
	return db
		.select()
		.from(sessionParticipants)
		.where(eq(sessionParticipants.sessionId, sessionId))
		.orderBy(asc(sessionParticipants.joinedAt));
}

/**
 * Add a prompt to the back of the queue.
 *
 * The sequence number comes from a counter on the session row, bumped with
 * UPDATE ... RETURNING inside the same transaction as the insert.
 *
 * The obvious alternative — `select max(seq) + 1` — is wrong, and wrong in a way
 * that only shows up under the exact concurrency this feature exists to support.
 * Under READ COMMITTED two simultaneous callers cannot see each other's
 * uncommitted rows, both read the same maximum, and the unique index rejects the
 * loser. The visible symptom is somebody's message silently vanishing when two
 * people type at once. An UPDATE takes a row lock, so the second caller waits
 * and is handed the next number.
 *
 * The unique index on (session_id, seq) remains as a backstop: if this is ever
 * refactored back into a read-then-write, the failure is loud.
 */
export async function queuePrompt(input: {
	orgId: string;
	sessionId: string;
	author: string;
	authorKind?: "human" | "agent";
	/**
	 * The author's git identity, when the caller has one on file. Stored so the
	 * commands route can send the prompt down as `attributed-user`; absent, the
	 * prompt runs `agent-only` with bot-attributed commits rather than being
	 * refused by the sandbox's identity check.
	 */
	authorEmail?: string | null;
	/**
	 * The signed-in user behind the prompt, when there is one. This is the
	 * identity whose OAuth token opens the pull request for the resulting work,
	 * which is why it is stored rather than re-derived from `authorEmail` later:
	 * `users.email` is nullable and not unique, and a near-miss there would open a
	 * pull request in the wrong person's name.
	 */
	authorUserId?: string | null;
	body: string;
}) {
	const body = input.body.trim();
	if (!body) throw new HarborError("A prompt cannot be empty.");
	if (body.length > 8000) throw new HarborError("Prompt is too long (max 8000 characters).");

	const prompt = await db.transaction(async (tx) => {
		const [session] = await tx
			.update(sessions)
			.set({ nextSeq: raw`${sessions.nextSeq} + 1`, lastActivityAt: new Date() })
			.where(and(eq(sessions.id, input.sessionId), eq(sessions.orgId, input.orgId)))
			.returning({ seq: sessions.nextSeq });
		if (!session) throw new HarborError("No such session.");

		// `nextSeq` is post-increment, so the value this prompt gets is one less.
		const seq = session.seq - 1;

		const [row] = await tx
			.insert(sessionPrompts)
			.values({
				orgId: input.orgId,
				sessionId: input.sessionId,
				author: input.author,
				authorKind: input.authorKind ?? "human",
				authorEmail: input.authorEmail ?? null,
				authorUserId: input.authorUserId ?? null,
				body,
				seq,
			})
			.returning();
		return row!;
	});

	await notifyChange(input.orgId, "session_prompt");
	return prompt;
}

/** The conversation so far, oldest first, with every author intact. */
export async function promptsOf(sessionId: string) {
	return db
		.select()
		.from(sessionPrompts)
		.where(eq(sessionPrompts.sessionId, sessionId))
		.orderBy(asc(sessionPrompts.seq));
}

/**
 * Take the next queued prompt for an agent to act on.
 *
 * `FOR UPDATE SKIP LOCKED` so two workers polling the same session cannot both
 * take the same prompt: the second skips the locked row rather than blocking on
 * it. This is the same discipline `claim()` uses for tasks, applied to the queue
 * — a session with two agents attached is a supported state, not an accident.
 */
export async function dequeuePrompt(orgId: string, sessionId: string) {
	return db.transaction(async (tx) => {
		const [next] = await tx
			.select()
			.from(sessionPrompts)
			.where(
				and(
					eq(sessionPrompts.sessionId, sessionId),
					eq(sessionPrompts.orgId, orgId),
					eq(sessionPrompts.status, "queued"),
				),
			)
			.orderBy(asc(sessionPrompts.seq))
			.for("update", { skipLocked: true })
			.limit(1);

		if (!next) return null;

		await tx
			.update(sessionPrompts)
			.set({ status: "delivered", deliveredAt: new Date() })
			.where(eq(sessionPrompts.id, next.id));
		return next;
	});
}

export async function listSessions(orgId: string, limit = 20) {
	return db
		.select({
			id: sessions.id,
			key: sessions.key,
			title: sessions.title,
			status: sessions.status,
			createdBy: sessions.createdBy,
			createdAt: sessions.createdAt,
			lastActivityAt: sessions.lastActivityAt,
			taskTitle: tasks.title,
		})
		.from(sessions)
		.leftJoin(tasks, eq(sessions.taskId, tasks.id))
		.where(eq(sessions.orgId, orgId))
		.orderBy(desc(sessions.lastActivityAt))
		.limit(limit);
}
