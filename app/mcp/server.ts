// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The MCP server, over Streamable HTTP.
 *
 * HTTP rather than stdio is the deployment decision that makes Harbor a shared
 * service instead of a per-laptop tool: one hosted URL and one API key per team,
 * pasted into every agent's config, so a Conductor worktree spun up at 2am sees
 * the same task list as an engineer's local Claude Code. A stdio fallback lives
 * in stdio.ts for self-hosting and local development, and both wrap the same
 * tool definitions — there is no second implementation to drift.
 *
 * Auth is a bearer token that names no org. The org is read off the row the
 * digest matched, so a request can prove which key it holds but cannot assert
 * which tenant it belongs to.
 *
 * Sessions are deliberately not persisted. Each request builds a transport in
 * stateless mode, which means any process can serve any request and a restart
 * loses nothing. Harbor has no per-session state worth keeping — a claim lives in
 * Postgres, not in a socket.
 */

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";
import { orgIdForKey } from "@core/kernel/auth.js";
import { runStartupChecks, startBackgroundLoops } from "../lib/loops.js";
import {
	authenticateSandbox,
	describeFenceRefusal,
	fencingTokenFrom,
} from "../lib/session-runner.js";
import { validateFence } from "../sandbox/manager.js";
import { buildAgentServer } from "./agent-build";
import { buildServer } from "@core/mcp/build.js";
import { tools } from "@core/mcp/tools.js";

export { buildServer };

/**
 * Express headers as a `Headers`.
 *
 * The auth helpers take `Headers` because they were written for the Next.js
 * routes, and reusing them is the point — a second implementation of "which
 * sandbox is this" that drifted from the first would be a security bug rather
 * than duplication. Express lower-cases incoming header names, and `Headers`
 * lookup is case-insensitive, so a repeated header arriving as an array is the
 * only shape needing care: it is joined rather than dropped, so a caller cannot
 * hide a value by sending the header twice.
 */
function headersFrom(req: Request): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(req.headers)) {
		if (value === undefined) continue;
		headers.set(name, Array.isArray(value) ? value.join(", ") : value);
	}
	return headers;
}

/** A JSON-RPC-shaped refusal, so a client sees a protocol error rather than HTML. */
function rpcError(res: Response, status: number, code: number, message: string): void {
	res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

/**
 * `HARBOR_MCP_PORT` before `PORT`, and the order is load-bearing.
 *
 * Render and Railway inject `PORT` into every service they run, and Fly's `[env]`
 * block is shared across all `[processes]`. On any of the three, a worker that
 * reads `PORT` first binds the *web* port — so it either collides with the web
 * process or answers health checks meant for the dashboard, and the failure
 * reads as "the MCP server is down" with nothing in the logs about why.
 * `HARBOR_MCP_PORT` is the escape hatch that lets one shared environment address
 * two processes; `PORT` stays supported so a single-process deployment still
 * works with no extra configuration.
 */
export const DEFAULT_MCP_PORT = 8788;
const PORT = Number(process.env.HARBOR_MCP_PORT ?? process.env.PORT ?? DEFAULT_MCP_PORT);

/**
 * Loopback by default. `listen(PORT)` alone bound every interface, which on a
 * laptop on a shared network exposes an endpoint whose only auth is a bearer
 * token to anyone who can reach the host.
 *
 * The container case is handled by the image (`ENV HOST=0.0.0.0` in the
 * Dockerfile), not by changing this default — inside a container `0.0.0.0` binds
 * only that container's network namespace, and what is actually reachable is
 * decided by which ports are published. So the safe default and the working
 * container are both available, and neither is traded for the other.
 * `HARBOR_MCP_HOST` exists for the same shared-environment reason as the port.
 */
const HOST = process.env.HARBOR_MCP_HOST ?? process.env.HOST ?? "127.0.0.1";



const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
	res.json({ ok: true, tools: tools.map((t) => t.name) });
});

app.all("/mcp", async (req: Request, res: Response) => {
	const orgId = await orgIdForKey(req.header("authorization"));
	if (!orgId) {
		res.status(401).json({
			jsonrpc: "2.0",
			error: { code: -32001, message: "Missing or invalid API key." },
			id: null,
		});
		return;
	}

	// `sessionIdGenerator: undefined` is the SDK's stateless mode, and it is
	// required rather than merely tidy: a new transport is built per request, so a
	// session id would be issued and then immediately forgotten, and every call
	// after `initialize` would be refused with "Server not initialized".
	//
	// Stateless is also the right shape for Harbor. A claim lives in Postgres, not
	// in a socket, so any process can serve any request and a restart loses
	// nothing — which is what lets this run behind a load balancer as one hosted
	// URL for a whole team.
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	const server = buildServer(orgId);

	// Both ends are per-request, so the sockets must be closed with the request or
	// a long-running server leaks a transport per call.
	res.on("close", () => {
		void transport.close();
		void server.close();
	});

	await server.connect(transport);
	await transport.handleRequest(req, res, req.body);
});

/**
 * The second surface: the tools a background agent gets, scoped to one session.
 *
 * Mounted here rather than in the Next.js app because the SDK's transport writes
 * to a raw Node `ServerResponse`, which the App Router does not expose — and
 * because this is the process a sandbox already talks to. It was written, tested
 * and never mounted, so `record_artifact` and `report_progress` were unreachable
 * from inside the box they exist for.
 *
 * Three checks, in the order the sandbox event route established, because each
 * one may only use facts the previous one settled:
 *
 *  1. **Authentication**, against the sandbox's own token digest. Proves which
 *     box is calling.
 *  2. **The fencing token.** Authentication is not enough and cannot be: a box
 *     whose lease lapsed still holds a genuine credential. Only the fence
 *     separates the current box from an honest zombie that is still running and
 *     still believes it holds the work.
 *  3. **The path id must be the authenticated box.** The id is in the URL and the
 *     token is in a header, so without this a sandbox with a valid token could
 *     name a different sandbox's id and write into its session.
 *
 * Re-checked on every request, never cached for the life of a connection. A lease
 * that lapses halfway through a long turn has to stop the writes at that moment,
 * and a capability resolved at connect time would let the box keep writing until
 * it happened to disconnect — precisely the window in which a second agent has
 * legitimately taken the work.
 */
app.all("/agent/:sandboxId/mcp", async (req: Request, res: Response) => {
	// Express types a route param as `string | string[]`. An array can only arise
	// from a repeated capture, which this pattern cannot produce — but taking the
	// first element rather than casting means a future pattern change degrades to
	// "wrong sandbox id, refused by `authenticateSandbox`" instead of a crash.
	const raw = req.params.sandboxId;
	const sandboxId = (Array.isArray(raw) ? raw[0] : raw) ?? "";
	const headers = headersFrom(req);

	const auth = await authenticateSandbox(sandboxId, headers);
	if (!auth.ok) {
		rpcError(res, 401, -32001, auth.message);
		return;
	}

	const presented = fencingTokenFrom(headers);
	if (!presented.ok) {
		rpcError(res, 409, -32002, presented.message);
		return;
	}

	const verdict = await validateFence(sandboxId, presented.token);
	if (!verdict.valid) {
		rpcError(res, 409, -32002, describeFenceRefusal(verdict));
		return;
	}

	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	const server = buildAgentServer({
		orgId: auth.sandbox.orgId,
		sessionId: auth.sandbox.sessionId,
		sandboxId: auth.sandbox.id,
		fencingToken: verdict.token,
	});

	res.on("close", () => {
		void transport.close();
		void server.close();
	});

	await server.connect(transport);
	await transport.handleRequest(req, res, req.body);
});

if (process.env.NODE_ENV !== "test") {
	app.listen(PORT, HOST, () => {
		// The bind address, not a hardcoded `localhost`. An operator who forgot
		// HOST in a container needs the log to say `127.0.0.1` — that one line is
		// the difference between "why is nothing reaching my MCP server" and a fix.
		console.log(`harbor mcp on http://${HOST}:${PORT}/mcp`);
		console.log(`tools: ${tools.map((t) => t.name).join(", ")}`);
	});

	// Configuration is validated here rather than left to fail at first use.
	// An incoherent combination — a stale-heartbeat threshold below the heartbeat
	// interval — produces a deployment where every healthy sandbox is killed
	// seconds after booting, with nothing in the logs pointing at configuration.
	// Failing loudly at startup with both variable names is much kinder. The same
	// call emits the SCM-attribution warning ADR 0004 promises at deploy time.
	try {
		// The addressing and database-TLS warnings are returned rather than logged by
		// the checks themselves, so that a test can assert their text without
		// capturing stdout. Printing them is therefore the caller's job.
		const { warnings } = runStartupChecks();
		for (const warning of warnings) console.warn(`\nharbor: ${warning}\n`);
	} catch (error) {
		console.error(`\n${(error as Error).message}\n`);
		process.exit(1);
	}

	// Every background loop, from the one registry in src/lib/loops.ts: claim
	// sweeps, automations, sandbox deadlines, session ticks, event compaction and
	// the provider-orphan sweep. This process owns them; the Next.js app runs
	// none (serverless-shaped). Safe on every replica — each loop takes an
	// advisory lock or is a compare-and-set, so a second replica adds timeliness,
	// not duplicate actions. Inline setIntervals were how three of the six sweeps
	// ended up written, tested and never scheduled; the registry is the fix.
	startBackgroundLoops();
}

export { app };
