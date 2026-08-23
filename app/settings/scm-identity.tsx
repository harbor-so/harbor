"use client";
// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Connect and disconnect, and say what each one costs.
 *
 * The disconnect button is the interesting one. Removing an identity silently
 * downgrades every future pull request for this person to a compare URL, and a
 * person who clicks it in a tidying-up mood should read that sentence *before*
 * the first PR fails to appear — not three weeks later while wondering whether
 * Harbor is broken.
 */
export function ScmIdentityPanel({ connected, login }: { connected: boolean; login: string | null }) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [note, setNote] = useState<string | null>(null);

	async function disconnect() {
		setBusy(true);
		try {
			const response = await fetch("/api/auth/scm/disconnect", { method: "POST" });
			const body = (await response.json()) as { consequence?: string; error?: string };
			setNote(body.error ?? body.consequence ?? null);
			router.refresh();
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="space-y-3">
			{connected ? (
				<div className="flex flex-wrap items-center gap-3">
					<span className="text-sm">
						Connected as <strong>{login ?? "unknown"}</strong>
					</span>
					<button
						className="rounded-md border border-border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
						disabled={busy}
						onClick={disconnect}
						type="button"
					>
						{busy ? "Disconnecting…" : "Disconnect"}
					</button>
				</div>
			) : (
				<a
					className="inline-block rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
					href="/api/auth/scm"
				>
					Connect GitHub for pull-request authorship
				</a>
			)}

			{note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
		</div>
	);
}
