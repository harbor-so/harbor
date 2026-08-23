// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The dashboard's primitives.
 *
 * These are hand-written rather than copied from shadcn, and the reason is
 * proportion: the upstream Badge and Button pull in Radix and
 * class-variance-authority to provide polymorphic `asChild` rendering and
 * variant algebra that a four-page status dashboard never exercises. The design
 * tokens are what carry the visual language across, and those live in
 * globals.css — not in the component library that happened to consume them.
 *
 * If Harbor's dashboard grows real interaction — dialogs, menus, focus traps —
 * take shadcn then. Radix earns its weight on those; it does not on a <span>.
 */

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/**
 * Status tones.
 *
 * One tone per meaning, reused everywhere, so `claimed` is the same colour in
 * the task table and the event feed. A conflict is the one thing rendered in the
 * alarm colour — it is the event the product exists to produce, and it should be
 * findable by scanning the page rather than by reading it.
 */
const TONES = {
	open: "bg-muted text-muted-foreground",
	claimed: "bg-primary/15 text-primary",
	completed: "bg-success/15 text-success",
	released: "bg-muted text-muted-foreground",
	expired: "bg-destructive/10 text-destructive",
	conflict: "bg-destructive/15 text-destructive",
	neutral: "bg-muted text-muted-foreground",
} as const;

export type Tone = keyof typeof TONES;

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: React.ReactNode }) {
	return (
		<span
			className={cn(
				"inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium",
				TONES[tone] ?? TONES.neutral,
			)}
		>
			{children}
		</span>
	);
}

export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
	return (
		<div className={cn("rounded-lg border border-border bg-card p-4", className)}>{children}</div>
	);
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
	return (
		<h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
			{children}
		</h2>
	);
}

/**
 * Empty states always carry a hint.
 *
 * "No tasks yet" tells someone the query worked and nothing else. The hint is
 * the part that tells them what to do next, and on a dashboard whose whole job
 * is to be glanced at, a dead end is a bug.
 */
export function Empty({ title, hint }: { title: string; hint?: string }) {
	return (
		<div className="rounded-lg border border-dashed border-border px-4 py-10 text-center">
			<p className="text-sm text-foreground">{title}</p>
			{hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
		</div>
	);
}

export function Stat({ value, label }: { value: string | number; label: string }) {
	return (
		<Card className="flex-1">
			<div className="nums text-2xl font-semibold text-foreground">{value}</div>
			<div className="mt-1 text-xs text-muted-foreground">{label}</div>
		</Card>
	);
}
