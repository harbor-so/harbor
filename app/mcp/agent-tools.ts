// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The tools a background agent gets, which are NOT the five coordination tools.
 *
 * ## Why two MCP surfaces rather than one
 *
 * The coordination server promises five tools and `protocol.test.ts` asserts the
 * whole surface stays under a character budget. That promise is load-bearing:
 * every tool an MCP server exposes is re-read by the model on every single turn,
 * so the tool list is a recurring context cost paid forever, and the discipline
 * that keeps it at five is that new capability becomes a *parameter* on an
 * existing tool.
 *
 * Background-agent capability cannot follow that rule. "Open a pull request" is
 * not a parameter on `claim`. So rather than quietly widening a budget the README
 * makes a specific numeric claim about, these live on a second server that is
 * **only ever injected into a sandbox**, is scoped to one session by its token,
 * and has its own budget test.
 *
 * The two surfaces have genuinely different audiences, which is the real
 * justification. `harbor` is for an agent running on somebody's laptop that needs
 * to know what its colleagues are doing. `harbor-agent` is for an agent running
 * inside a sandbox Harbor booted, which already knows what it is working on and
 * instead needs to say what it has produced.
 *
 * ## Four tools, and why not five
 *
 * Everything here is something the agent alone knows and the control plane cannot
 * observe. Anything the control plane can work out for itself — which files
 * changed, how long a turn took, whether the tests passed — is deliberately absent,
 * because a tool that asks the agent to report a fact the server already has is a
 * tool that pays context on every turn to produce a number that can disagree with
 * the truth.
 */

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@core/schema/index";
import { artifacts, sandboxes, sessions } from "@core/schema/schema";
import { setting } from "@core/kernel/config";
import { HarborError } from "@core/kernel/work";

/**
 * A sandbox's authority, resolved from its token, and re-checked on every call.
 *
 * Not cached for the life of the connection. A sandbox whose lease lapsed halfway
 * through a long turn must stop being able to write, and a capability captured at
 * connect time would let it keep going until it disconnected — which is precisely
 * the window in which a second agent has legitimately taken the work.
 */
export interface AgentToolContext {
	orgId: string;
	sessionId: string;
	sandboxId: string;
	/** Validated per call by the caller. See `src/sandbox/manager.ts`. */
	fencingToken: number;
}

export interface AgentToolDefinition {
	name: string;
	description: string;
	schema: z.ZodRawShape;
	run: (ctx: AgentToolContext, args: Record<string, unknown>) => Promise<string>;
}

export const agentTools: AgentToolDefinition[] = [
	{
		name: "report_progress",
		description:
			"Post a short progress note to the humans watching this session, and to whichever "
			+ "Slack thread or Linear issue it came from. Use this at inflection points — you "
			+ "have understood the problem, you are about to make a large change, you are "
			+ "blocked — not for narration. People are watching a room, not reading a log.",
		schema: {
			text: z.string().max(1000).describe("One or two sentences, written for a human"),
			blocked: z
				.boolean()
				.optional()
				.describe("True if you need a person to answer something before you can continue"),
		},
		run: async (ctx, args) => {
			const { appendEvent } = await import("../lib/session-events.js");
			await appendEvent({
				orgId: ctx.orgId,
				sessionId: ctx.sessionId,
				type: args.blocked ? "agent_message" : "agent_message",
				actor: "agent",
				payload: {
					text: String(args.text),
					// The kind rides in the payload rather than in a new event type,
					// because a consumer that does not know about "blocked" should still
					// render the message rather than nothing at all.
					kind: args.blocked ? "needs_input" : "progress",
				},
			});
			return "ok";
		},
	},

	{
		name: "record_artifact",
		description:
			"Record something you produced that a human will want to open: a screenshot, a "
			+ "report, a deployed preview URL. Branches and pull requests are recorded "
			+ "automatically when you push — do not record those here.",
		schema: {
			kind: z.enum(["screenshot", "file", "log"]),
			title: z.string().max(200),
			url: z.string().max(2000).optional().describe("A URL a human can open, if there is one"),
		},
		run: async (ctx, args) => {
			await db.insert(artifacts).values({
				orgId: ctx.orgId,
				sessionId: ctx.sessionId,
				kind: String(args.kind),
				title: String(args.title),
				url: typeof args.url === "string" ? args.url : null,
			});
			const { appendEvent } = await import("../lib/session-events.js");
			await appendEvent({
				orgId: ctx.orgId,
				sessionId: ctx.sessionId,
				type: "artifact_created",
				actor: "agent",
				payload: { kind: args.kind, title: args.title, url: args.url ?? null },
			});
			return `ok recorded ${args.kind}`;
		},
	},

	{
		name: "spawn_child",
		description:
			"Split this work into a separate parallel session with its own sandbox. Use it for "
			+ "cross-repository research, or to break one large initiative into several small "
			+ "pull requests that can be reviewed independently. The child runs on its own and "
			+ "does not block you. Do not use it to parallelise work that belongs in one commit.",
		schema: {
			prompt: z.string().min(10).max(8000).describe("A complete, self-contained instruction"),
			title: z.string().max(120).optional(),
		},
		run: async (ctx, args) => {
			const parent = await db.query.sessions.findFirst({
				where: and(eq(sessions.id, ctx.sessionId), eq(sessions.orgId, ctx.orgId)),
			});
			if (!parent) throw new HarborError("This session no longer exists.");

			// Depth limit. Without it an agent that decides delegation is the answer
			// produces a tree, and the tree's cost is exponential in a system where
			// every node boots a container. The limit is deliberately shallow: one
			// level of fan-out is the useful case, two is almost always a mistake.
			const depth = countAncestors(parent.createdBy);
			if (depth >= 1) {
				throw new HarborError(
					"This session was itself spawned by an agent, and Harbor does not allow a "
						+ "third level. Do the work here, or ask a human to start a separate session.",
				);
			}

			const queued = await db
				.select({ id: sessions.id })
				.from(sessions)
				.where(and(eq(sessions.orgId, ctx.orgId), eq(sessions.status, "open")))
				.limit(setting("maxQueueDepth"));
			if (queued.length >= setting("maxQueueDepth")) {
				throw new HarborError(
					`There are already ${queued.length} open sessions, which is the configured `
						+ "cap. Finish or archive some before spawning more.",
				);
			}

			const { createSession } = await import("../lib/sessions.js");
			const { enqueueSessionPrompt } = await import("../lib/session-runner.js");
			const child = await createSession({
				orgId: ctx.orgId,
				title: typeof args.title === "string" ? args.title : String(args.prompt).slice(0, 120),
				// Provenance names the parent SESSION, not the parent's own creator, so
				// the chain is walkable and the depth check above is not a guess.
				createdBy: `agent:${ctx.sessionId}`,
			});

			await db
				.update(sessions)
				.set({
					repoId: parent.repoId,
					environmentId: parent.environmentId,
					baseBranch: parent.baseBranch,
					runtime: parent.runtime,
				})
				.where(eq(sessions.id, child.id));

			// The capped front door: agents spawning children is the other
			// human-free amplification path, and a refusal surfaces as this tool's
			// error text so the agent sees WHY instead of a silent no-op.
			const enqueued = await enqueueSessionPrompt({
				orgId: ctx.orgId,
				sessionId: child.id,
				author: `agent:${ctx.sessionId}`,
				authorKind: "agent",
				body: String(args.prompt),
			});
			if (!enqueued.ok) throw new HarborError(enqueued.message);

			return `ok spawned child session ${child.key} — it runs independently; you are not blocked`;
		},
	},

	{
		name: "get_session_context",
		description:
			"Read what the humans in this room have said, including anything queued while you "
			+ "were working. Call this when you finish a turn, before deciding what to do next — "
			+ "somebody may have corrected you mid-task.",
		schema: {},
		run: async (ctx) => {
			const { promptsOf } = await import("../lib/sessions.js");
			const prompts = await promptsOf(ctx.sessionId);
			if (prompts.length === 0) return "No prompts in this session yet.";
			return prompts
				.slice(-20)
				.map((p) => `#${p.seq} @${p.author} [${p.status}] ${p.body}`)
				.join("\n");
		},
	},
];

/** `agent:<uuid>` in `createdBy` means the session was spawned by another session. */
function countAncestors(createdBy: string): number {
	return createdBy.startsWith("agent:") ? 1 : 0;
}

/**
 * The budget, asserted by `agent-protocol.test.ts` for the same reason the
 * coordination server's is.
 *
 * Larger than the coordination budget because a sandbox agent has one connection
 * for one session and is not also carrying a repository's worth of other MCP
 * servers — but it is a budget, and it exists so that adding a fifth tool is a
 * deliberate decision with a failing test in front of it rather than a commit
 * nobody weighed.
 */
export const AGENT_TOOL_BUDGET_CHARS = 3_000;

export function agentToolSurfaceSize(): number {
	return agentTools.reduce(
		(total, tool) => total + tool.name.length + tool.description.length,
		0,
	);
}

/** Resolve a sandbox token to the session it may write to. Never cached. */
export async function contextForSandboxToken(
	tokenHash: string,
): Promise<AgentToolContext | null> {
	const sandbox = await db.query.sandboxes.findFirst({
		where: eq(sandboxes.authTokenHash, tokenHash),
	});
	if (!sandbox) return null;

	// A stopped, stale or failed sandbox keeps its token row but must not be able
	// to write. Persisted lifecycle state is the authority here, not whether the
	// process happens to still be running — which is the whole point of the
	// fencing design.
	const { isDeadSandboxStatus } = await import("../sandbox/decisions.js");
	if (isDeadSandboxStatus(sandbox.status)) return null;

	return {
		orgId: sandbox.orgId,
		sessionId: sandbox.sessionId,
		sandboxId: sandbox.id,
		fencingToken: 0,
	};
}
