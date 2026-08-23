"use client";
// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Archive, said in the word that describes what happens.
 *
 * Not "Remove" and not a bin icon. `archiveRepo` keeps the row precisely so that
 * `session_repos` — the record of what past sessions actually worked on —
 * survives, and a label promising deletion would make the honest behaviour look
 * like a bug the first time somebody noticed the history was still there.
 */
export function ArchiveRepoButton({ owner, name }: { owner: string; name: string }) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);

	async function archive() {
		setBusy(true);
		try {
			await fetch(`/api/repos/${owner}/${name}/archive`, { method: "POST" });
			router.refresh();
		} finally {
			setBusy(false);
		}
	}

	return (
		<button
			className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
			disabled={busy}
			onClick={archive}
			type="button"
		>
			{busy ? "Archiving…" : "Archive"}
		</button>
	);
}
