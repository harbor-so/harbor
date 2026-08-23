// SPDX-License-Identifier: Apache-2.0
/**
 * Every address Harbor knows about itself, resolved in one place.
 *
 * There were four behaviours for two variables before this file existed, and the
 * differences were accidents rather than decisions:
 *
 *   - `src/sandbox/manager.ts` threw when `HARBOR_PUBLIC_URL` was unset, with an
 *     excellent error explaining the container trap;
 *   - `src/lib/work.ts` fell back to `http://localhost:3000` with `||`;
 *   - `src/connectors/slack.ts` fell back with `??`, so the *empty* value that
 *     `.env.example` ships produced the link `/s/<key>` — a relative path posted
 *     into Slack, which is not a link at all;
 *   - three files each restated `http://localhost:8788/mcp`.
 *
 * What this file deliberately does NOT do is collapse the two URLs into one.
 * They are genuinely different values, and the difference is not cosmetic:
 *
 *   | deployment        | a browser needs      | a sandbox needs                |
 *   |-------------------|----------------------|--------------------------------|
 *   | laptop            | localhost:3000       | host.docker.internal:3000      |
 *   | Linux compose     | localhost:3000       | 172.17.0.1:3000                |
 *   | anything hosted   | https://harbor.you   | https://harbor.you             |
 *
 * A sandbox that calls `localhost:3000` reaches *itself*. A Slack message linking
 * to `host.docker.internal:3000` is unclickable. Collapsing them means one of
 * those two is always broken, so `linkBaseUrl()` and `requirePublicUrl()` stay
 * separate functions with deliberately different failure modes: links degrade to
 * a localhost guess, because a wrong link is better than a dropped notification,
 * while a spawn refuses outright, because a box with the wrong callback address
 * fails silently and presents as "sandboxes always time out".
 *
 * Everything is read at call time, never captured at import — same reason as
 * `src/config.ts`: a module-level read happens before a test can set the variable.
 */

/**
 * The port every doc, the Settings page and `scripts/agents.ts` already name.
 *
 * It lives here rather than in `src/mcp/server.ts` so that the Settings page can
 * name the port without importing the MCP server — which would pull `express`,
 * and through it the whole server graph, into the Next.js bundle.
 */
export const DEFAULT_MCP_PORT = 8788;

/** Trailing slashes are stripped so callers can concatenate `/s/<key>` freely. */
function normalize(raw: string | undefined): string | null {
	const trimmed = raw?.trim().replace(/\/+$/, "");
	return trimmed ? trimmed : null;
}

/**
 * `HARBOR_PUBLIC_URL`, or `null` if it is unset *or blank*.
 *
 * The blank case matters more than it looks: `.env.example` ships
 * `HARBOR_PUBLIC_URL=http://localhost:3000`, but an operator templating their env
 * from a secret store routinely ends up with the key present and the value empty,
 * and `??` treats that as configured.
 */
export function publicUrl(): string | null {
	return normalize(process.env.HARBOR_PUBLIC_URL);
}

/**
 * The one wording of the missing-callback-address failure.
 *
 * Exported because `src/sandbox/manager.ts` must raise it as a `HarborError`
 * rather than a plain `Error`, and a second copy of a message this specific is a
 * second copy to fall out of date. It is long on purpose: the symptom of getting
 * this wrong is every sandbox timing out during boot, which is a very long way
 * from "an environment variable is unset", and an operator who has to work that
 * out from a timeout is an operator who gives up.
 *
 * The three named addresses are the three that are actually right, in the order
 * an operator meets them — see the table at the top of this file.
 */
export const PUBLIC_URL_MISSING_MESSAGE =
	"HARBOR_PUBLIC_URL is not set, so a sandbox would have no address to call back "
	+ "on. It must be a URL reachable FROM INSIDE a sandbox. On Docker Desktop that is "
	+ "usually http://host.docker.internal:3000 and on Linux http://172.17.0.1:3000 — "
	+ "not http://localhost:3000, which from inside a container resolves to the "
	+ "container itself. On any remote provider (fly, e2b, modal, daytona and the "
	+ "rest) it must be a publicly resolvable HTTPS origin: a sandbox in someone "
	+ "else's cloud cannot reach host.docker.internal or a private address at all, "
	+ "and will simply hang until the boot timeout.";

/** Where a sandbox should call us back. Fatal when unset. */
export function requirePublicUrl(): string {
	const url = publicUrl();
	if (!url) throw new Error(PUBLIC_URL_MISSING_MESSAGE);
	return url;
}

/**
 * The base for links Harbor posts into Slack, Linear and email.
 *
 * Degrades to localhost rather than throwing: a connector that refuses to post
 * because a link would be wrong has turned a cosmetic problem into a dropped
 * notification. `warnAboutAddressing()` is what makes the degradation visible.
 */
export function linkBaseUrl(): string {
	return publicUrl() ?? "http://localhost:3000";
}

/** Where the coordination MCP surface is, for config snippets and launched agents. */
export function mcpUrl(): string {
	return normalize(process.env.HARBOR_MCP_URL) ?? `http://localhost:${DEFAULT_MCP_PORT}/mcp`;
}

/**
 * Where the `harbor-agent` MCP surface is reachable from inside a sandbox.
 *
 * Unset returns `null` rather than throwing, unlike `requirePublicUrl`. A sandbox
 * with no control-plane address cannot report anything and is a deployment fault;
 * a sandbox with no MCP address simply has no Harbor tools, which is a smaller
 * product with no broken part in it.
 */
export function agentMcpUrl(): string | null {
	return normalize(process.env.HARBOR_AGENT_MCP_URL);
}

/** The dashboard's own origin, as shown in copyable snippets. */
export function dashboardUrl(): string {
	return normalize(process.env.HARBOR_URL) ?? linkBaseUrl();
}

/**
 * Addressing problems worth saying out loud at startup.
 *
 * Returned rather than logged so `runStartupChecks()` owns the one place warnings
 * are emitted, and so a test can assert the text without capturing stdout.
 */
export function warnAboutAddressing(): string[] {
	const warnings: string[] = [];
	const url = publicUrl();
	const production = process.env.NODE_ENV === "production";

	if (!url) {
		warnings.push(
			"HARBOR_PUBLIC_URL is not set. Sandboxes cannot be spawned at all (the spawn "
				+ "refuses rather than booting a box with an address that reaches itself), and "
				+ "links posted to Slack and Linear will point at http://localhost:3000.",
		);
	} else if (production && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url)) {
		warnings.push(
			`HARBOR_PUBLIC_URL is ${url} while NODE_ENV=production. A loopback address is `
				+ "reachable only from the machine that serves it, so every sandbox callback and "
				+ "every link Harbor posts will fail. Set it to the URL your users actually visit.",
		);
	}

	return warnings;
}
