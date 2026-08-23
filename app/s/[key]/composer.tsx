"use client";
// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Card } from "../../components/ui.js";

/**
 * The composer is always enabled, including while an agent is working.
 *
 * That is the point of a queue. Disabling input during a run is the design that
 * forces people to sit and wait, or worse, to interrupt — and interrupting is
 * what produces an agent following half of two instructions. Typing now and
 * having it arrive next is what people actually want.
 */
export function SessionComposer({ sessionKey }: { sessionKey: string }) {
	const router = useRouter();
	const [body, setBody] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function send() {
		setBusy(true);
		setError(null);
		try {
			const response = await fetch(`/api/sessions/${sessionKey}/prompts`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ body }),
			});
			const result = (await response.json()) as { error?: string };
			if (!response.ok) throw new Error(result.error ?? "Could not send.");
			setBody("");
			router.refresh();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Card className="space-y-2">
			<textarea
				className="min-h-20 w-full rounded-md border border-border bg-background p-3 text-sm"
				onChange={(event) => setBody(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void send();
				}}
				placeholder="Add to the queue — it arrives after whatever is already in flight."
				value={body}
			/>
			<div className="flex items-center gap-3">
				<button
					className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
					disabled={busy || body.trim().length === 0}
					onClick={send}
					type="button"
				>
					{busy ? "Queueing…" : "Queue prompt"}
				</button>
				<span className="text-xs text-muted-foreground">⌘↵</span>
				{error ? <span className="text-xs text-destructive">{error}</span> : null}
			</div>
		</Card>
	);
}

export function ShareLink({ sessionKey }: { sessionKey: string }) {
	const [copied, setCopied] = useState(false);

	return (
		<button
			className="text-xs text-muted-foreground hover:text-foreground"
			onClick={() => {
				void navigator.clipboard.writeText(`${window.location.origin}/s/${sessionKey}`);
				setCopied(true);
				setTimeout(() => setCopied(false), 2000);
			}}
			type="button"
		>
			{copied ? "link copied" : "copy share link"}
		</button>
	);
}
