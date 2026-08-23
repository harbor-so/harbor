// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { scmIdentitySummary } from "../git/credentials.js";
import { listRepos } from "../lib/repos.js";
import { currentSession } from "../lib/session.js";
import { Card, Empty, SectionLabel } from "../components/ui.js";
import { ArchiveRepoButton } from "./archive-button.js";
import { ConnectRepoPanel } from "./connect.js";

/**
 * Repositories, and the reason there was no page here before.
 *
 * `connectRepo` — the function that performs Harbor's per-user access check —
 * had no caller, so onboarding a repository meant an INSERT and the check ran
 * nowhere. This page is the caller. It refuses to render a connect form for
 * somebody with no source-control identity, because every path behind the form
 * would refuse anyway and a button that cannot work is worse than an
 * explanation.
 */
export const dynamic = "force-dynamic";

export default async function ReposPage() {
	const viewer = await currentSession();
	if (!viewer) return <Empty title="No organisation yet" hint="Run npm run db:seed." />;

	const rows = await listRepos(viewer.orgId);
	const scm = viewer.userId ? await scmIdentitySummary(viewer.userId) : null;

	return (
		<div className="space-y-6">
			<SectionLabel>Repositories</SectionLabel>

			{scm?.connected ? (
				<ConnectRepoPanel />
			) : (
				<Card>
					<p className="text-xs text-muted-foreground">
						Connecting a repository is checked against <strong>your own</strong> GitHub account,
						not the shared app installation — otherwise every user of this deployment could reach
						every repository the app can. That needs a source-control identity, which you can
						connect from <a className="text-primary" href="/settings">Settings</a>.
					</p>
				</Card>
			)}

			{rows.length === 0 ? (
				<Empty
					title="No repositories connected"
					hint="A session clones what you connect here. Connect one by owner/name, or browse the ones your account can see."
				/>
			) : (
				<Card className="p-0">
					<table className="w-full text-sm">
						<tbody>
							{rows.map((repo) => (
								<tr className="border-b border-border last:border-0" key={repo.id}>
									<td className="px-4 py-2.5">
										{repo.owner}/{repo.name}
										{repo.description ? (
											<div className="text-xs text-muted-foreground">{repo.description}</div>
										) : null}
									</td>
									<td className="px-2 py-2.5 text-xs text-muted-foreground">
										{repo.defaultBranch}
									</td>
									<td className="px-4 py-2.5 text-right">
										<ArchiveRepoButton name={repo.name} owner={repo.owner} />
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</Card>
			)}
		</div>
	);
}
