// SPDX-License-Identifier: Apache-2.0
/**
 * stdio transport, for self-hosting and local development.
 *
 * Same tools, same code path — this file only swaps how bytes move. The org
 * comes from HARBOR_API_KEY in the environment rather than a header, because a
 * stdio server has no request to carry one.
 *
 * Imports `buildServer` from build.ts, never from server.ts: importing server.ts
 * would run its listen-and-log block, and a banner on stdout corrupts the
 * JSON-RPC channel this transport is speaking on.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { orgIdForKey } from "../kernel/auth.js";
import { buildServer } from "./build.js";

const orgId = await orgIdForKey(process.env.HARBOR_API_KEY);
if (!orgId) {
	// stderr, never stdout: stdout is the JSON-RPC channel and a stray line there
	// corrupts the protocol for the client.
	console.error("HARBOR_API_KEY is missing or invalid.");
	process.exit(1);
}

await buildServer(orgId).connect(new StdioServerTransport());
