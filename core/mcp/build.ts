// SPDX-License-Identifier: Apache-2.0
/**
 * Building an MCP server, with no side effects.
 *
 * Split out of server.ts because stdio.ts imported `buildServer` from there, and
 * importing that module ran its top-level block: `app.listen()` on every
 * interface, plus two `console.log` calls to **stdout**. On a stdio transport
 * stdout is the JSON-RPC channel, so `npm run mcp:stdio` corrupted its own
 * protocol stream with a banner before the client had finished connecting — and
 * opened a network listener nobody asked for.
 *
 * Nothing in this file may have a side effect at import time.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { touchPresence } from "../kernel/work.js";
import { toToolError, tools } from "./tools.js";

export const INSTRUCTIONS =
	"Harbor coordinates multiple coding agents working the same backlog. Before "
	+ "starting any work call list_work to see what is already claimed, then claim "
	+ "the task you intend to do. Release it when you finish, with a summary.";

export function buildServer(orgId: string): McpServer {
	const server = new McpServer(
		{ name: "harbor", version: "0.1.0" },
		{
			// Declared explicitly rather than inherited. McpServer's default advertises
			// tools.listChanged: true, which Harbor can never honour — the tool list is a
			// frozen array and each request gets a fresh server on a stateless
			// transport with no stream to deliver a notification on.
			capabilities: { tools: {} },
			instructions: INSTRUCTIONS,
		},
	);

	for (const tool of tools) {
		server.registerTool(
			tool.name,
			{ description: tool.description, inputSchema: tool.schema },
			async (args: Record<string, unknown>) => {
				try {
					const text = await tool.run({ orgId }, args);
					// Presence is recorded here, once, for all five tools — rather than as a
					// sixth `heartbeat` tool an agent has to remember to call and pays tokens
					// for. Deliberately not awaited into the response path beyond this point:
					// an agent's claim must never fail because the dashboard wanted to know
					// somebody was alive.
					const agentId = typeof args.agent_id === "string" ? args.agent_id : undefined;
					if (agentId) void touchPresence(orgId, agentId, tool.name);
					return { content: [{ type: "text" as const, text }] };
				} catch (error) {
					// Returned as content with isError rather than thrown: the model has to
					// read "that task is held by someone else" and choose differently, and a
					// protocol-level exception is not something it can reason about.
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
