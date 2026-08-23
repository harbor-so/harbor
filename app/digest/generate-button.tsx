"use client";
// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * The failure path is the interesting one.
 *
 * Digest generation needs ANTHROPIC_API_KEY, and a pilot will hit that before
 * they hit success. The error is shown verbatim rather than replaced with
 * "something went wrong", because the actual message names the missing variable
 * and that is the entire fix.
 */
export function GenerateDigestButton() {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function generate() {
		setBusy(true);
		setError(null);
		try {
			const response = await fetch("/api/digest/generate", { method: "POST" });
			const body = (await response.json()) as { error?: string };
			if (!response.ok) throw new Error(body.error ?? "Generation failed.");
			router.refresh();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="flex items-center gap-3">
			{error ? <span className="text-xs text-destructive">{error}</span> : null}
			<button
				className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
				disabled={busy}
				onClick={generate}
				type="button"
			>
				{busy ? "Generating…" : "Generate digest"}
			</button>
		</div>
	);
}
