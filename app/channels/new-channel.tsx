"use client";
// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ChatClient } from "../lib/chat-client.js";
import { ensureIdentity } from "../lib/identity-browser.js";

/**
 * Create a channel from the browser.
 *
 * Creating needs an identity, because a channel records its creator's pubkey as
 * provenance and seeds them as the first member — so this makes sure the device's
 * key exists and is registered before it asks the server to make the room. The
 * creator is a member like anyone else, not an owner.
 */
export function NewChannel({ viewerName }: { viewerName: string }) {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [title, setTitle] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function create() {
		const trimmed = title.trim();
		if (!trimmed) return;
		setBusy(true);
		setError(null);
		try {
			const keypair = await ensureIdentity(viewerName);
			const client = new ChatClient({ keypair, displayName: viewerName });
			const channel = await client.createChannel({ title: trimmed });
			router.push(`/c/${channel.key}`);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setBusy(false);
		}
	}

	if (!open) {
		return (
			<button
				className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
				onClick={() => setOpen(true)}
				type="button"
			>
				New channel
			</button>
		);
	}

	return (
		<div className="flex items-center gap-2">
			<input
				autoFocus
				className="rounded-md border border-border bg-background px-3 py-1.5 text-sm"
				onChange={(event) => setTitle(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") void create();
					if (event.key === "Escape") setOpen(false);
				}}
				placeholder="Channel title"
				value={title}
			/>
			<button
				className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
				disabled={busy || title.trim().length === 0}
				onClick={create}
				type="button"
			>
				{busy ? "Creating…" : "Create"}
			</button>
			{error ? <span className="text-xs text-destructive">{error}</span> : null}
		</div>
	);
}
