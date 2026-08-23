"use client";
// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Keeps the page current without polling.
 *
 * `router.refresh()` re-runs the server components and streams down new HTML, so
 * the live layer needs no client-side data fetching, no duplicate query logic and
 * no second source of truth about what a task looks like — the same server code
 * renders the first paint and every update after it.
 *
 * Refreshes are coalesced into a 250ms window. Six agents releasing at once is
 * six notifies, and re-rendering six times in a tick would be visible as flicker
 * for no additional information.
 */
export function LiveRefresh() {
	const router = useRouter();
	const [connected, setConnected] = useState(false);

	useEffect(() => {
		const source = new EventSource("/api/stream");
		let timer: ReturnType<typeof setTimeout> | undefined;

		source.addEventListener("ready", () => setConnected(true));
		source.addEventListener("change", () => {
			clearTimeout(timer);
			timer = setTimeout(() => router.refresh(), 250);
		});
		// EventSource reconnects on its own; the flag just stops the dot lying
		// about being live while it is down.
		source.onerror = () => setConnected(false);

		return () => {
			clearTimeout(timer);
			source.close();
		};
	}, [router]);

	return (
		<span
			className="flex items-center gap-1.5 text-xs text-muted-foreground"
			title={connected ? "Live — updates stream in" : "Reconnecting…"}
		>
			<span
				className={`inline-block h-1.5 w-1.5 rounded-full ${
					connected ? "bg-success" : "bg-muted-foreground/40"
				}`}
			/>
			{connected ? "live" : "offline"}
		</span>
	);
}
