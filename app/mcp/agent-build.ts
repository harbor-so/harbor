// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Building the session-scoped agent server, with no side effects.
 *
 * The mirror of `build.ts`, and separate from it for the reason stated at the top
 * of `agent-tools.ts`: these two surfaces have different audiences and different
 * budgets. `harbor` is for an agent on somebody's laptop that needs to know what
 * its colleagues are doing; `harbor-agent` is for an agent inside a sandbox
 * Harbor booted, which already knows what it is working on and instead needs to
 * say what it has produced.
 *
 * Same import-time rule as `build.ts`: nothing in this file may have a side
 * effect at import, because the server module that imports it also opens a
 * listener, and a test that wants the tool definitions must not get a socket.
 *
 * The context is passed in already authenticated and already fence-checked. This
 * file does no authorisation of its own — see the route in `server.ts` — because
 * a builder that took a token and resolved it would make the fence check optional
 * from the caller's point of view, and the fence is the only thing separating the
 * current box from an honest zombie that still holds a valid credential.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { agentTools, type AgentToolContext } from "./agent-tools.js";
import { toToolError } from "@core/mcp/tools";

export const AGENT_INSTRUCTIONS =
	"You are running inside a Harbor sandbox on one session. Use report_progress to "
	+ "say what you are doing as you go, record_artifact when you produce something "
	+ "durable such as a branch or a pull request, and spawn_child to fan work out "
	+ "into its own sandbox. Call get_session_context if you need the prompt history "
	+ "or the repositories you were given.";

export function buildAgentServer(ctx: AgentToolContext): McpServer {
	const server = new McpServer(
		{ name: "harbor-agent", version: "0.1.0" },
		{
			// Explicit, same as the coordination server: McpServer's default advertises
			// tools.listChanged: true, which cannot be honoured on a stateless transport
			// whose tool list is a frozen array and which has no stream to notify on.
			capabilities: { tools: {} },
			instructions: AGENT_INSTRUCTIONS,
		},
	);

	for (const tool of agentTools) {
		server.registerTool(
			tool.name,
			{ description: tool.description, inputSchema: tool.schema },
			async (args: Record<string, unknown>) => {
				try {
					return { content: [{ type: "text" as const, text: await tool.run(ctx, args) }] };
				} catch (error) {
					// Content with `isError`, not a thrown protocol exception, for the same
					// reason as the coordination tools: the model has to read what went
					// wrong and choose differently, and it cannot reason about a transport
					// fault. Deliberately no presence write here — a sandbox agent is not
					// a coordinating peer and does not belong in the presence table.
					return {
						content: [{ type: "text" as const, text: toToolError(error) }],
						isError: true,
					};
				}
			},
		);
	}

	return server;
}
