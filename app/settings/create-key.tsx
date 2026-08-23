"use client";
// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Card } from "../components/ui.js";

/**
 * The key is shown exactly once, and the UI has to say so.
 *
 * Only a SHA-256 digest is stored, so there is no "show it again" — a user who
 * closes this without copying has to make a new key. Saying that at the moment
 * of creation is the difference between a mild annoyance and a support ticket.
 */
export function CreateKeyPanel() {
	const router = useRouter();
	const [created, setCreated] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function create() {
		setBusy(true);
		try {
			const response = await fetch("/api/keys", { method: "POST" });
			const body = (await response.json()) as { key?: string; error?: string };
			if (body.key) setCreated(body.key);
			router.refresh();
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="space-y-3">
			<button
				className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
				disabled={busy}
				onClick={create}
				type="button"
			>
				{busy ? "Creating…" : "Create API key"}
			</button>

			{created ? (
				<Card className="border-primary/40">
					<p className="text-xs text-muted-foreground">
						Copy this now — only its hash is stored, so it cannot be shown again.
					</p>
					<code className="mt-2 block overflow-x-auto text-sm text-primary">{created}</code>
				</Card>
			) : null}
		</div>
	);
}
