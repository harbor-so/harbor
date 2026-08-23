"use client";
// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Card } from "../components/ui.js";

/**
 * The launch form, and the wall in front of it.
 *
 * When the runner is disabled the form is not merely greyed out — the reason and
 * the exact variables are stated. This is the one endpoint in Harbor that executes
 * a program rather than writing a row, and somebody enabling it should have to
 * read a sentence about what that means first.
 */
export function LaunchPanel({ enabled }: { enabled: boolean }) {
	const router = useRouter();
	const [runtime, setRuntime] = useState("claude-code");
	const [prompt, setPrompt] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (!enabled) {
		return (
			<Card>
				<p className="text-sm">Launching agents is off.</p>
				<p className="mt-2 text-xs text-muted-foreground">
					Harbor spawns a headless agent as a child process on this host — same user,
					same filesystem, no isolation. That is fine on your own machine against
					your own repo, and unsafe anywhere multi-tenant. Set{" "}
					<code>HARBOR_ENABLE_RUNNER=1</code> and <code>HARBOR_WORKSPACE_DIR=/path/to/repo</code>{" "}
					to turn it on.
				</p>
			</Card>
		);
	}

	async function launch() {
		setBusy(true);
		setError(null);
		try {
			const response = await fetch("/api/runs", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ runtime, prompt }),
			});
			const body = (await response.json()) as { error?: string };
			if (!response.ok) throw new Error(body.error ?? "Launch failed.");
			setPrompt("");
			router.refresh();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Card className="space-y-3">
			<div className="flex gap-2">
				{["claude-code", "codex"].map((id) => (
					<button
						className={`rounded-md px-3 py-1.5 text-sm ${
							runtime === id
								? "bg-primary text-primary-foreground"
								: "bg-muted text-muted-foreground"
						}`}
						key={id}
						onClick={() => setRuntime(id)}
						type="button"
					>
						{id}
					</button>
				))}
			</div>
			<textarea
				className="min-h-24 w-full rounded-md border border-border bg-background p-3 text-sm"
				onChange={(event) => setPrompt(event.target.value)}
				placeholder="What should this agent do? It will claim work through Harbor before it starts."
				value={prompt}
			/>
			<div className="flex items-center gap-3">
				<button
					className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
					disabled={busy || prompt.trim().length < 3}
					onClick={launch}
					type="button"
				>
					{busy ? "Launching…" : "Launch"}
				</button>
				{error ? <span className="text-xs text-destructive">{error}</span> : null}
			</div>
		</Card>
	);
}
