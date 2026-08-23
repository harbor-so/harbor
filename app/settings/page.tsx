// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Keys, and the config snippet that makes them useful.
 *
 * The snippet is the point of this page. A pilot's time-to-first-value is
 * "paste this into your agent and it works", and every step between reading a
 * key and having a working `.mcp.json` is a step where a team gives up. So the
 * page renders the real block, with the real URL, ready to copy.
 */

import { scmIdentitySummary } from "../git/credentials.js";
import { listApiKeys } from "../lib/dashboard.js";
import { signInGrantsAuthorship } from "../lib/github-oauth.js";
import { currentSession, oauthConfigured } from "../lib/session.js";
import { dashboardUrl, mcpUrl } from "@core/kernel/urls.js";
import { Badge, Card, Empty, SectionLabel } from "../components/ui.js";
import { CreateKeyPanel } from "./create-key.js";
import { ScmIdentityPanel } from "./scm-identity.js";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
	const session = await currentSession();
	if (!session) return <Empty title="No organisation yet" hint="Run npm run db:seed." />;

	const keys = await listApiKeys(session.orgId);
	const scm = session.userId
		? await scmIdentitySummary(session.userId)
		: { connected: false, login: null, scopes: null, expires_at: null, connected_at: null };
	const mcpEndpoint = mcpUrl();
	const appUrl = dashboardUrl();

	return (
		<div className="space-y-8">
			<section>
				<SectionLabel>Pull-request authorship</SectionLabel>
				<Card>
					<p className="text-xs text-muted-foreground">
						Harbor opens each pull request with <strong>your</strong> GitHub token, not a bot&rsquo;s.
						GitHub does not let an author approve their own pull request, so agent code cannot be
						merged without a second pair of eyes — a structural guarantee rather than a policy.
						That needs the <code>repo</code> scope, which is why it is a separate consent from
						signing in.
					</p>

					{!oauthConfigured() ? (
						<p className="mt-3 text-xs text-destructive">
							This deployment has no GitHub OAuth app configured, so nobody can connect an
							identity. Harbor will push branches and hand back compare URLs instead of opening
							pull requests. Set <code>GITHUB_CLIENT_ID</code> and{" "}
							<code>GITHUB_CLIENT_SECRET</code>.
						</p>
					) : !session.userId ? (
						<p className="mt-3 text-xs text-destructive">
							You are on the development sign-in bypass, which has no user row to store an
							identity against. Configure GitHub OAuth and sign in to connect one.
						</p>
					) : scm.connected ? (
						<p className="mt-3 text-xs text-muted-foreground">
							Pull requests from your prompts are authored by you.
							{scm.expires_at ? ` This grant expires ${new Date(scm.expires_at).toDateString()}; Harbor refreshes it automatically.` : null}
						</p>
					) : (
						<p className="mt-3 text-xs text-destructive">
							No identity connected. Your prompts still run and still push branches, but Harbor
							will not open the pull request — it refuses to open one as the bot, because then
							you could approve your own agent&rsquo;s changes and nothing would record that the
							guarantee had lapsed. You will get a compare URL instead.
						</p>
					)}

					<div className="mt-4">
						<ScmIdentityPanel connected={scm.connected} login={scm.login} />
					</div>

					{signInGrantsAuthorship() ? (
						<p className="mt-3 text-xs text-muted-foreground">
							This deployment sets <code>HARBOR_GITHUB_OAUTH_SCOPES</code> to include{" "}
							<code>repo</code>, so signing in already collects this grant.
						</p>
					) : null}
				</Card>
			</section>

			<section>
				<SectionLabel>API keys</SectionLabel>
				<CreateKeyPanel />
				{keys.length === 0 ? (
					<Empty title="No keys yet" hint="Create one to connect an agent." />
				) : (
					<Card className="mt-4 p-0">
						<table className="w-full text-sm">
							<tbody>
								{keys.map((key) => (
									<tr className="border-b border-border last:border-0" key={key.id}>
										<td className="px-4 py-2.5">{key.label ?? "unlabelled"}</td>
										<td className="px-2 py-2.5 text-xs text-muted-foreground">
											{key.createdAt.toDateString()}
										</td>
										<td className="px-4 py-2.5 text-right">
											<Badge tone={key.revokedAt ? "expired" : "completed"}>
												{key.revokedAt ? "revoked" : "active"}
											</Badge>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</Card>
				)}
			</section>

			<section>
				<SectionLabel>Claude Code — .mcp.json at your repo root</SectionLabel>
				<Card>
					<pre className="overflow-x-auto text-xs leading-relaxed text-muted-foreground">
{`{
  "mcpServers": {
    "harbor": {
      "type": "http",
      "url": "${mcpEndpoint}",
      "headers": { "Authorization": "Bearer \${HARBOR_API_KEY}" }
    }
  }
}`}
					</pre>
				</Card>
				<p className="mt-2 text-xs text-muted-foreground">
					Commit this file. Claude Code interpolates <code>{"${HARBOR_API_KEY}"}</code> from the
					environment, so the key never enters version control — and a committed
					<code> .mcp.json</code> is what every Conductor workspace inherits automatically.
				</p>
				<p className="mt-2 text-xs text-muted-foreground">
					Add to CLAUDE.md: “Before starting any task, call harbor.list_work() to see what is
					already claimed, and harbor.claim(task_id, agent_id) before beginning work. Release
					the claim when done, with a summary.”
				</p>
			</section>

			<section>
				<SectionLabel>Codex — ~/.codex/config.toml</SectionLabel>
				<Card>
					<pre className="overflow-x-auto text-xs leading-relaxed text-muted-foreground">
{`[mcp_servers.harbor]
url = "${mcpEndpoint}"
bearer_token_env_var = "HARBOR_API_KEY"`}
					</pre>
				</Card>
				<p className="mt-2 text-xs text-muted-foreground">
					<code>bearer_token_env_var</code> is purpose-built for this and keeps the key out of
					the file. Put the same instruction in AGENTS.md.
				</p>
			</section>

			<section>
				<SectionLabel>Conductor</SectionLabel>
				<Card>
					<p className="text-xs text-muted-foreground">
						Nothing to configure. Conductor does not define its own MCP format — it loads
						whatever Claude Code and Codex load, and a <code>.mcp.json</code> at your repo
						root is inherited by every workspace it spawns. Commit the block above once and
						all parallel worktrees see Harbor.
					</p>
				</Card>
			</section>

			<section>
				<SectionLabel>Activity tracking — record every tool call</SectionLabel>
				<Card>
					<p className="text-xs text-muted-foreground">
						The five MCP tools capture what an agent <em>claims</em>. Activity tracking captures
						what it actually <em>does</em> — every <code>Bash</code>, <code>Edit</code>,{" "}
						<code>Read</code> and shell call — by tapping each tool&rsquo;s hooks. Every host posts
						to one endpoint, authenticated by the same key above:
					</p>
					<pre className="mt-3 overflow-x-auto text-xs leading-relaxed text-muted-foreground">
{`POST ${appUrl}/api/hooks/<runtime>
Authorization: Bearer \${HARBOR_API_KEY}
# <runtime> = claude-code | codex | cursor | opencode | conductor`}
					</pre>
				</Card>
				<p className="mt-2 text-xs text-muted-foreground">
					<strong>Claude Code:</strong> merge{" "}
					<code>integrations/claude-code/settings.hooks.json</code> into{" "}
					<code>.claude/settings.json</code>. It POSTs over a native HTTP hook — no script needed.
				</p>
				<p className="mt-2 text-xs text-muted-foreground">
					<strong>Codex &amp; Cursor:</strong> their hooks run local commands only, so point{" "}
					<code>.codex/hooks.json</code> / <code>.cursor/hooks.json</code> at the shared{" "}
					<code>integrations/harbor-forward.sh</code>, which curls the payload here.
				</p>
				<p className="mt-2 text-xs text-muted-foreground">
					<strong>opencode:</strong> drop <code>integrations/opencode/harbor-activity.ts</code> in
					your plugin directory; it <code>fetch()</code>es directly.
				</p>
				<p className="mt-2 text-xs text-muted-foreground">
					<strong>Conductor:</strong> it has no hook format of its own — it runs Claude Code or
					Codex under the hood. Commit that tool&rsquo;s config above and every Conductor workspace
					inherits it; the <code>conductor</code> runtime endpoint parses either dialect.
				</p>
				<p className="mt-2 text-xs text-muted-foreground">
					<strong>Devin:</strong> a cloud agent with no hooks to fire, so it is <em>pulled</em>, not
					pushed. Drop a token — a <code>devin</code> connector with <code>config.apiToken</code>, or{" "}
					<code>DEVIN_API_TOKEN</code> — then register a session with{" "}
					<code>POST {appUrl}/api/devin/sessions</code> (same <code>Bearer</code> key), passing{" "}
					<code>{`{ devinSessionId }`}</code> to observe an existing session or{" "}
					<code>{`{ prompt }`}</code> to start and track a new one. A background loop then polls it
					and its activity — and any pull request it opens — shows up like every other runtime.
				</p>
			</section>

		</div>
	);
}
