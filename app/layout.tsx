// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import type { Metadata } from "next";
import Link from "next/link";
import { currentSession } from "./lib/session.js";
import "./styles/globals.css";

export const metadata: Metadata = {
	title: "Harbor",
	description: "Background coding agents your company can actually deploy.",
};

/**
 * Ordered by how often somebody actually opens it, not by hierarchy.
 *
 * A dashboard for a system that runs while you are not watching is opened to
 * answer "what happened" far more often than to configure anything, so the
 * read-only surfaces come first and everything you set up once is behind
 * Settings. Usage sits in the top row rather than under Settings because an
 * unexpected bill is the failure mode people most want early warning of.
 */
const NAV = [
	{ href: "/", label: "Activity" },
	{ href: "/channels", label: "Channels" },
	{ href: "/sessions", label: "Sessions" },
	{ href: "/repos", label: "Repos" },
	{ href: "/automations", label: "Automations" },
	{ href: "/usage", label: "Usage" },
	{ href: "/digest", label: "Digest" },
	{ href: "/connectors", label: "Connectors" },
	{ href: "/settings", label: "Settings" },
];

export default async function RootLayout({ children }: { children: React.ReactNode }) {
	const session = await currentSession();

	return (
		<html className="dark" lang="en" suppressHydrationWarning>
			<body className="min-h-screen bg-background text-foreground">
				<header className="border-b border-border">
					<div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
						<Link className="font-semibold tracking-tight" href="/">
							<span className="text-primary">◆</span> Harbor
						</Link>
						<nav className="flex gap-4 text-sm text-muted-foreground">
							{NAV.map((item) => (
								<Link className="hover:text-foreground" href={item.href} key={item.href}>
									{item.label}
								</Link>
							))}
						</nav>
						<div className="ml-auto text-xs text-muted-foreground">
							{session ? session.orgName : "no org"}
						</div>
					</div>
				</header>

				{/* A dashboard that is silently unauthenticated is worse than one that
				    refuses to load, so the bypass announces itself on every page. */}
				{session?.unauthenticated ? (
					<div className="border-b border-border bg-primary/10 px-6 py-2 text-center text-xs text-foreground">
						Development mode — no GitHub OAuth configured, showing the first org.
						Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to require sign-in.
					</div>
				) : null}

				<main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
			</body>
		</html>
	);
}
