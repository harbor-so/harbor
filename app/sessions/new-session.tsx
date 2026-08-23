"use client";
// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

interface ConnectedRepo {
	id: string;
	owner: string;
	name: string;
	default_branch: string;
}

/**
 * Start a session, optionally against a repository.
 *
 * The repository is optional and stays optional. A session is a room, and a room
 * with nothing checked out is a real thing — somebody opening one to talk about
 * what the work should be before there is any. Forcing a repository at creation
 * would make that impossible and would also make the first-run experience, with
 * nothing connected yet, a dead end.
 *
 * The list here is what the ORG has connected; whether *this viewer* may use it
 * is re-checked server-side at creation against their own token, because a
 * picker rendered five minutes ago is not evidence of anything.
 */
export function NewSessionButton() {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [title, setTitle] = useState("");
	const [repos, setRepos] = useState<ConnectedRepo[]>([]);
	const [repoId, setRepoId] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) return;
		void (async () => {
			const response = await fetch("/api/repos");
			const body = (await response.json()) as { repos?: ConnectedRepo[] };
			setRepos(body.repos ?? []);
		})();
	}, [open]);

	async function create() {
		if (!title.trim()) return;
		setBusy(true);
		setError(null);
		try {
			const response = await fetch("/api/sessions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ title, repoIds: repoId ? [repoId] : [] }),
			});
			const body = (await response.json()) as { key?: string; error?: string };
			// The refusal here is the repository access check's own sentence, which
			// distinguishes "not visible to your account" from "GitHub was unreachable
			// so this was treated as denied". Both matter and they are not the same.
			if (body.error) setError(body.error);
			else if (body.key) router.push(`/s/${body.key}`);
		} finally {
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
				New session
			</button>
		);
	}

	return (
		<div className="flex flex-wrap items-center gap-2">
			<input
				autoFocus
				className="w-64 rounded-md border border-border bg-transparent px-3 py-1.5 text-sm"
				onChange={(event) => setTitle(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") void create();
					if (event.key === "Escape") setOpen(false);
				}}
				placeholder="What is this session about?"
				value={title}
			/>
			<select
				className="rounded-md border border-border bg-transparent px-2 py-1.5 text-sm"
				onChange={(event) => setRepoId(event.target.value)}
				value={repoId}
			>
				<option value="">No repository</option>
				{repos.map((repo) => (
					<option key={repo.id} value={repo.id}>
						{repo.owner}/{repo.name}
					</option>
				))}
			</select>
			<button
				className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
				disabled={busy || !title.trim()}
				onClick={create}
				type="button"
			>
				{busy ? "Creating…" : "Create"}
			</button>
			<button
				className="text-xs text-muted-foreground"
				onClick={() => setOpen(false)}
				type="button"
			>
				Cancel
			</button>
			{error ? <p className="w-full text-xs text-destructive">{error}</p> : null}
		</div>
	);
}
