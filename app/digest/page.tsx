// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { listDigests } from "../lib/dashboard.js";
import { currentSession } from "../lib/session.js";
import { Card, Empty, SectionLabel } from "../components/ui.js";
import { GenerateDigestButton } from "./generate-button.js";

export const dynamic = "force-dynamic";

export default async function DigestPage() {
	const session = await currentSession();
	if (!session) return <Empty title="No organisation yet" hint="Run npm run db:seed." />;

	const all = await listDigests(session.orgId);
	const [latest, ...history] = all;

	return (
		<div className="space-y-8">
			<div className="flex items-center justify-between">
				<SectionLabel>This week</SectionLabel>
				<GenerateDigestButton />
			</div>

			{latest ? (
				<Card>
					<div className="mb-2 text-xs text-muted-foreground">
						{latest.periodStart.toDateString()} — {latest.periodEnd.toDateString()}
					</div>
					<p className="whitespace-pre-wrap text-sm leading-relaxed">{latest.body}</p>
				</Card>
			) : (
				<Empty
					title="No digest yet"
					hint="Generate one once agents have completed work this week."
				/>
			)}

			{history.length > 0 ? (
				<section>
					<SectionLabel>Earlier</SectionLabel>
					<div className="space-y-3">
						{history.map((digest) => (
							<Card key={digest.id}>
								<div className="mb-2 text-xs text-muted-foreground">
									{digest.periodStart.toDateString()} — {digest.periodEnd.toDateString()}
								</div>
								<p className="whitespace-pre-wrap text-sm leading-relaxed">{digest.body}</p>
							</Card>
						))}
					</div>
				</section>
			) : null}
		</div>
	);
}
