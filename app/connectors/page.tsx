// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * What Harbor is connected to, and what it is allowed to do there.
 *
 * The largest thing on each card is not a green dot — it is the list of writes the
 * connector may perform. "Is it connected?" is a question people ask once; "what
 * can it do to my Slack workspace?" is the question a security reviewer asks, and
 * answering it in the product rather than in a doc is what gets a pilot approved.
 *
 * The list is read from each connector's `outboundWrites` declaration rather than
 * from a hand-maintained table in this file, which is the change that makes the
 * page trustworthy. A hand-maintained table is a table that is wrong the first
 * time somebody adds a capability and forgets — and it is wrong in the direction
 * of under-reporting, which is the direction that gets a deployment approved on a
 * false premise. Now the page cannot under-report without the code changing.
 *
 * `triggeredBy` is shown next to every call for the same reason. "Can post
 * messages" and "posts one message when a session finishes" are very different
 * risk statements and only the second is useful.
 */

import { allConnectors } from "./registry.js";
import { listConnectors } from "../lib/dashboard.js";
import { currentSession } from "../lib/session.js";
import { Badge, Card, Empty, SectionLabel } from "../components/ui.js";

export const dynamic = "force-dynamic";

/**
 * The half that genuinely cannot be derived from code: what Harbor *reads*, and
 * what it deliberately never touches.
 *
 * Reads are not declared in the interface because they are a property of the
 * webhook subscription and the OAuth scope, which live outside this process — so
 * declaring them here would be the same false assurance the writes table exists to
 * avoid. These strings are prose, and `CONNECTORS.md` is the authority.
 */
const READS: Record<string, { name: string; reads: string; never: string }> = {
	github: {
		name: "GitHub",
		reads: "Issue and pull-request metadata: number, title, body, state. The installation id, as the tenant key.",
		never:
			"Repository contents are never read through the connector. Cloning happens inside "
			+ "the sandbox with a short-lived brokered credential.",
	},
	linear: {
		name: "Linear",
		reads: "Issue create and update: id, identifier, title, description, state type.",
		never: "No state changes, no assignee changes, no issue creation.",
	},
	slack: {
		name: "Slack",
		reads:
			"Message text, user id, channel id and thread timestamp — only for messages that "
			+ "@-mention the bot, or replies in a thread Harbor already has a session for.",
		never:
			"Channel history is never read and members are never enumerated. A plain channel "
			+ "message that is neither a mention nor in a known thread is ignored rather than "
			+ "classified.",
	},
};

export default async function ConnectorsPage() {
	const session = await currentSession();
	if (!session) return <Empty title="No organisation yet" hint="Run npm run db:seed." />;

	const installed = await listConnectors(session.orgId);
	const byType = new Map(installed.map((row) => [row.type, row]));

	return (
		<div className="space-y-8">
			<section>
				<SectionLabel>Connectors</SectionLabel>
				<div className="grid gap-3 lg:grid-cols-2">
					{allConnectors().map((connector) => {
						const row = byType.get(connector.type);
						const prose = READS[connector.type];

						return (
							<Card key={connector.type}>
								<div className="flex items-center justify-between">
									<span className="font-medium">{prose?.name ?? connector.type}</span>
									<Badge tone={row ? "completed" : "neutral"}>
										{row ? row.status : "not connected"}
									</Badge>
								</div>

								<dl className="mt-3 space-y-3 text-xs">
									{prose ? (
										<div>
											<dt className="text-muted-foreground">Reads</dt>
											<dd>{prose.reads}</dd>
										</div>
									) : null}

									<div>
										<dt className="text-muted-foreground">
											Writes {connector.outboundWrites.length === 0 ? "" : "— from the code"}
										</dt>
										<dd>
											{connector.outboundWrites.length === 0 ? (
												<span className="text-muted-foreground">
													Nothing. Inbound sync only.
												</span>
											) : (
												<ul className="mt-1 space-y-2">
													{connector.outboundWrites.map((write) => (
														<li
															className="rounded border border-border bg-background/40 p-2"
															key={write.action}
														>
															<code className="text-foreground">{write.action}</code>
															<span className="ml-2 text-muted-foreground">
																needs {write.scope}
															</span>
															<p className="mt-1 text-muted-foreground">
																{write.description}
															</p>
															<p className="mt-1 text-muted-foreground">
																<span className="text-foreground">When: </span>
																{write.triggeredBy}
															</p>
														</li>
													))}
												</ul>
											)}
										</dd>
									</div>

									{prose ? (
										<div>
											<dt className="text-muted-foreground">Never</dt>
											<dd className="text-muted-foreground">{prose.never}</dd>
										</div>
									) : null}
								</dl>

								<p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
									{row?.lastSyncedAt
										? `Last delivery ${row.lastSyncedAt.toISOString().slice(0, 16).replace("T", " ")}`
										: `Point a webhook at /api/webhooks/${connector.type} to connect.`}
									{row && !row.externalAccountId ? (
										<span className="ml-2 text-foreground">
											· account not yet resolved — it is recorded on the first verified
											delivery, which is what scopes this row to one workspace
										</span>
									) : null}
								</p>
							</Card>
						);
					})}
				</div>
			</section>

			<section>
				<SectionLabel>Adding one</SectionLabel>
				<Card>
					<p className="text-xs text-muted-foreground">
						A connector is one file implementing one interface, plus a line in{" "}
						<code className="text-foreground">src/connectors/registry.ts</code> — not a
						separately deployed service. Declare every external call in{" "}
						<code className="text-foreground">outboundWrites</code> and run{" "}
						<code className="text-foreground">npm run docs:connectors</code>; a test fails
						the build if the security document and the code disagree.
					</p>
					<p className="mt-2 text-xs text-muted-foreground">
						See <code className="text-foreground">CONNECTORS.md</code>, which is written
						for a security reviewer.
					</p>
				</Card>
			</section>
		</div>
	);
}
