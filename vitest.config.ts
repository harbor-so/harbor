import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	// Vitest does not read `paths` out of tsconfig.json — Next.js and tsx both do,
	// so `@core/...` resolves everywhere else and would fail only under test, which
	// is the worst place to discover it. Declared here by hand rather than with
	// vite-tsconfig-paths: it is four lines, and a dependency whose whole job is to
	// copy four lines out of a file we already control is not worth the supply chain.
	//
	// `runtime/` deliberately does not use these aliases and must keep relative
	// specifiers — see the comment in sandbox/Dockerfile. It is compiled by its own
	// tsconfig with no `paths` and the emit runs under bare Node with no
	// node_modules, where an `@app/...` specifier cannot resolve.
	resolve: {
		alias: {
			"@core": path.resolve(root, "core"),
			"@app": path.resolve(root, "app"),
		},
	},
	test: {
		// The coordination tests share one Postgres and truncate between cases, so
		// they must not run in parallel files.
		fileParallelism: false,
		// ...and, for the same reason, two RUNS must not overlap either. This takes a
		// Postgres advisory lock for the lifetime of the suite and fails fast with an
		// explanation if another run holds it. See vitest.setup.ts: the failure mode
		// it prevents does not look like a concurrency problem, it looks like rows
		// vanishing immediately after they were inserted, and it costs an afternoon.
		globalSetup: ["./vitest.setup.ts"],
		// The protocol suite boots an HTTP server and opens real MCP clients; tearing
		// those down plus the Postgres pool can exceed the 10s default.
		hookTimeout: 30_000,
		testTimeout: 30_000,
		env: {
			DATABASE_URL: process.env.DATABASE_URL ?? "postgres://harbor:harbor@localhost:5433/harbor",
		},
	},
});
