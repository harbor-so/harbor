// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The Next.js tier's one-shot boot check.
 *
 * Until this file existed, `runStartupChecks()` had exactly one caller —
 * `src/mcp/server.ts` — so a deployment that ran only the dashboard got none of
 * it. That matters most for the part nobody would guess: ADR 0004 promises that a
 * deployment with no SCM OAuth configured *says so at startup*, naming the
 * guarantee it has lost, rather than letting somebody discover it weeks later in
 * a pull request's byline. On a web-only deployment that promise was simply not
 * kept. The addressing and database-TLS warnings have the same shape — all three
 * are misconfigurations that produce a deployment which looks like it works.
 *
 * Two decisions worth stating, because both look wrong at a glance.
 *
 * **The import is dynamic, and guarded on the runtime.** `src/lib/loops.ts`
 * transitively reaches `sandbox/manager.ts` → `sandbox/registry.ts` → every
 * provider. A static import here would pull that graph — a gRPC stack among it —
 * into the instrumentation chunk, which Next also evaluates for the edge runtime,
 * where none of it can load.
 *
 * **It logs; it does not exit.** The MCP server exits on a bad config and should:
 * it is a worker, and a worker that cannot do its job correctly should stop. The
 * web tier already has a better mechanism — `readiness()` calls `validateConfig()`
 * on every `GET /api/health`, so a bad config already returns 503 and the load
 * balancer already withholds traffic. Crash-looping the pod on top of that would
 * remove the operator's ability to `kubectl logs` or `curl` the explanation, which
 * turns a diagnosable misconfiguration into a silent restart loop. Refusing
 * traffic and staying inspectable are both available here; take both.
 */

export async function register(): Promise<void> {
	// The edge runtime has no filesystem, no `pg` and no need for any of this.
	if (process.env.NEXT_RUNTIME !== "nodejs") return;

	const { runStartupChecks } = await import("./app/lib/loops");

	try {
		const { warnings } = runStartupChecks();
		for (const warning of warnings) console.warn(`\nharbor: ${warning}\n`);
	} catch (error) {
		// Deliberately not fatal — see the header. `/api/health` is what refuses
		// traffic; this is what tells somebody why.
		console.error(
			`\nharbor: configuration is not valid, so /api/health will report unready and this `
				+ `deployment will not receive traffic.\n\n${(error as Error).message}\n`,
		);
	}
}
