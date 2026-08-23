"use client";
// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Card } from "../components/ui.js";

interface Available {
	owner: string;
	name: string;
	description: string | null;
	private: boolean;
	permission: string | null;
}

/**
 * Connect a repository — from a list, or by typing owner/name.
 *
 * Both paths exist because neither is sufficient. The list is read with the
 * viewer's own token and is what makes the first connect a click rather than a
 * lookup; but it is one page, it says so when there are more, and somebody with
 * four hundred repositories will always be faster typing the one they want.
 *
 * Failures are shown verbatim. The messages behind this button are the access
 * check's own — "not visible to your account" versus "GitHub returned 502 and
 * Harbor treats an unreadable permission as denied" — and paraphrasing them into
 * "could not connect" throws away the only sentence that tells the person which
 * of the two happened.
 */
export function ConnectRepoPanel() {
	const router = useRouter();
	const [available, setAvailable] = useState<Available[] | null>(null);
	const [truncated, setTruncated] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [manual, setManual] = useState("");

	async function loadAvailable() {
		setBusy(true);
		setError(null);
		try {
			const response = await fetch("/api/repos?available=1");
			const body = (await response.json()) as {
				repositories?: Available[];
				truncated?: boolean;
				error?: string;
			};
			if (body.error) setError(body.error);
			setAvailable(body.repositories ?? []);
			setTruncated(body.truncated === true);
		} finally {
			setBusy(false);
		}
	}

	async function connect(owner: string, name: string) {
		setBusy(true);
		setError(null);
		try {
			const response = await fetch("/api/repos", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ owner, name }),
			});
			const body = (await response.json()) as { error?: string };
			if (body.error) setError(body.error);
			else router.refresh();
		} finally {
			setBusy(false);
		}
	}

	function connectTyped() {
		const [owner, name] = manual.trim().split("/");
		if (!owner || !name) {
			setError("Type it as owner/name, the way it appears in the repository URL.");
			return;
		}
		void connect(owner, name);
	}

	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center gap-2">
				<input
					className="w-64 rounded-md border border-border bg-transparent px-3 py-1.5 text-sm"
					onChange={(event) => setManual(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") connectTyped();
					}}
					placeholder="owner/name"
					value={manual}
				/>
				<button
					className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
					disabled={busy}
					onClick={connectTyped}
					type="button"
				>
					Connect
				</button>
				<button
					className="rounded-md border border-border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
					disabled={busy}
					onClick={loadAvailable}
					type="button"
				>
					{busy ? "Loading…" : "Browse mine"}
				</button>
			</div>

			{error ? <p className="text-xs text-destructive">{error}</p> : null}

			{available ? (
				<Card className="p-0">
					{available.length === 0 ? (
						<p className="p-4 text-xs text-muted-foreground">
							GitHub returned no repositories for your account.
						</p>
					) : (
						<table className="w-full text-sm">
							<tbody>
								{available.map((repo) => (
									<tr
										className="border-b border-border last:border-0"
										key={`${repo.owner}/${repo.name}`}
									>
										<td className="px-4 py-2">
											{repo.owner}/{repo.name}
											{repo.private ? (
												<span className="ml-2 text-xs text-muted-foreground">private</span>
											) : null}
										</td>
										<td className="px-2 py-2 text-xs text-muted-foreground">
											{repo.permission ?? "permission not reported"}
										</td>
										<td className="px-4 py-2 text-right">
											<button
												className="text-xs font-medium text-primary disabled:opacity-50"
												disabled={busy}
												onClick={() => connect(repo.owner, repo.name)}
												type="button"
											>
												Connect
											</button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
					{truncated ? (
						<p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
							This is one page of your repositories, not all of them. Type the owner/name of
							anything that is missing.
						</p>
					) : null}
				</Card>
			) : null}
		</div>
	);
}
