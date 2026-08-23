// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * `docker run harbor doctor` — what is this deployment actually configured to do?
 *
 * Two audiences, one script.
 *
 * For an **operator**, this is the 2am command. `GET /api/health/config` shows the
 * same settings but requires a signed-in session, which is precisely what you do
 * not have when the dashboard will not start. This runs before anything is
 * serving, needs no session, and prints the three things that are wrong most
 * often: an address that is unreachable from inside a sandbox, a database URL
 * that is not verifying certificates or is behind a transaction pooler, and a
 * sandbox provider whose credentials are absent.
 *
 * For **CI**, it is the end-to-end proof that the image is assembled correctly,
 * and it works with **no credentials and no network**. Provider construction is
 * lazy by design — every vendor client is built on first call, never in a
 * constructor — so instantiating all thirteen proves the modules load, the vendor
 * SDKs resolved, and `npm ci --omit=dev` did not prune something the runtime
 * needs. That is the class of mistake a Dockerfile makes, and nothing else in the
 * suite would catch it.
 *
 * It deliberately does NOT connect to Postgres. A doctor that cannot run because
 * the database is down is useless on the day the database is down.
 */

import { describeConfig, validateConfig } from "@core/kernel/config.js";
import { databaseUrl } from "@core/schema/index.js";
import { describeDatabaseTls } from "@core/schema/tls.js";
import { agentMcpUrl, mcpUrl, publicUrl, warnAboutAddressing } from "@core/kernel/urls.js";
import { SANDBOX_PROVIDER_NAMES, providerFor } from "@app/sandbox/registry.js";

const problems: string[] = [];

function heading(text: string): void {
	console.log(`\n\x1b[1m${text}\x1b[0m`);
}

// ---------------------------------------------------------------------------
// Addressing
// ---------------------------------------------------------------------------

heading("Addressing");
console.log(`  HARBOR_PUBLIC_URL     ${publicUrl() ?? "(unset — sandboxes cannot be spawned)"}`);
console.log(`  HARBOR_MCP_URL        ${mcpUrl()}`);
console.log(`  HARBOR_AGENT_MCP_URL  ${agentMcpUrl() ?? "(unset — agents run without Harbor tools)"}`);
problems.push(...warnAboutAddressing());

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

heading("Database");
const url = databaseUrl();
const tls = describeDatabaseTls(url);
// Never print the DSN itself: it carries the password, and `doctor` output is
// exactly the thing somebody pastes into an issue.
console.log(`  host                  ${safeHost(url)}`);
console.log(`  sslmode               ${tls.mode}`);
console.log(`  encrypted             ${tls.encrypted}`);
console.log(`  certificate verified  ${tls.verified}`);
problems.push(...tls.warnings);

function safeHost(raw: string): string {
	try {
		const parsed = new URL(raw);
		return `${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`;
	} catch {
		return "(unparseable DATABASE_URL)";
	}
}

// ---------------------------------------------------------------------------
// Sandbox providers
// ---------------------------------------------------------------------------

heading("Sandbox providers");
for (const name of SANDBOX_PROVIDER_NAMES) {
	try {
		const provider = providerFor(name);
		console.log(`  ✓ ${name.padEnd(12)} ${provider.kind}`);
	} catch (error) {
		// A construction failure here is an IMAGE fault, not a configuration one —
		// credentials are read lazily, so nothing here should need them.
		console.log(`  ✗ ${name.padEnd(12)} ${(error as Error).message}`);
		problems.push(`Sandbox provider ${name} failed to construct: ${(error as Error).message}`);
	}
}

// ---------------------------------------------------------------------------
// Settings, and the verdict
// ---------------------------------------------------------------------------

heading("Settings (non-default only)");
const overridden = describeConfig().filter((s) => s.source !== "default");
if (overridden.length === 0) {
	console.log("  (all defaults — run with --all to see every setting and why)");
} else {
	for (const s of overridden) console.log(`  ${s.key.padEnd(34)} ${s.value}  [${s.source}]`);
}

if (process.argv.includes("--all")) {
	heading("Settings (all, with derivation)");
	for (const s of describeConfig()) {
		console.log(`  ${s.key} = ${s.value}  [${s.source}, ${s.env}]\n      ${s.derivation}`);
	}
}

try {
	validateConfig();
} catch (error) {
	problems.push((error as Error).message);
}

heading(problems.length === 0 ? "No problems found" : `${problems.length} problem(s)`);
for (const problem of problems) console.log(`\n  • ${problem}`);
console.log("");

// Non-zero on a real problem, so this is usable as a CI gate and a container
// health check rather than something a human has to read and interpret.
process.exit(problems.length === 0 ? 0 : 1);
