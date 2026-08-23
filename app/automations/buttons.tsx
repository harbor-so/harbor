"use client";
// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0

import { useState, useTransition } from "react";

/**
 * The two buttons that fix an automation, and both are deliberately plain.
 *
 * "Run now" exists because the first thing anybody does after creating an
 * automation is want to know whether it works, and making them wait an hour to
 * find out is a good way to have them never create a second one.
 *
 * Neither optimistically updates. An automation run spawns a sandbox and spends
 * money, so showing success before the server has agreed is the wrong direction
 * to be wrong in — the user needs to know what actually happened, not what
 * probably happened.
 */
function useAction(path: string) {
	const [pending, startTransition] = useTransition();
	const [result, setResult] = useState<string | null>(null);

	const run = () => {
		setResult(null);
		startTransition(async () => {
			try {
				const response = await fetch(path, { method: "POST" });
				const body = (await response.json()) as { error?: string; outcome?: string };
				setResult(response.ok ? (body.outcome ?? "done") : (body.error ?? "failed"));
				if (response.ok) window.location.reload();
			} catch (error) {
				setResult((error as Error).message);
			}
		});
	};

	return { run, pending, result };
}

export function RunNowButton({ automationId }: { automationId: string }) {
	const { run, pending, result } = useAction(`/api/automations/${automationId}/run`);
	return (
		<span className="inline-flex items-center gap-2">
			{result ? <span className="text-xs text-muted-foreground">{result}</span> : null}
			<button
				className="rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50"
				disabled={pending}
				onClick={run}
				type="button"
			>
				{pending ? "running…" : "Run now"}
			</button>
		</span>
	);
}

export function ResumeButton({ automationId }: { automationId: string }) {
	const { run, pending } = useAction(`/api/automations/${automationId}/resume`);
	return (
		<button
			className="rounded border border-primary/50 bg-primary/10 px-2 py-1 text-xs text-primary hover:bg-primary/20 disabled:opacity-50"
			disabled={pending}
			onClick={run}
			type="button"
		>
			{pending ? "…" : "Resume"}
		</button>
	);
}
