"use client";
// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0

import { useState, useTransition } from "react";
import { CONDITION_FIELDS, CONDITION_OPERATORS } from "../triggers/conditions.js";

/**
 * The form that creates an automation.
 *
 * Deliberately unglamorous and deliberately not optimistic: creating an
 * automation is committing to spend money without a human present, so the form
 * waits for the server to agree and then reloads to show the real row rather than
 * a hopeful one. It collapses by default — a page whose first job is surfacing a
 * paused automation should not open on a form — and expands on click.
 *
 * A cron automation needs a schedule; an event automation (webhook, sentry) needs
 * a signing secret and optional condition filters. The two sets of fields swap on
 * the source select so the form only ever asks for what the chosen source uses.
 */

type Target = { id: string; kind: "repo" | "environment"; label: string };
type Condition = { field: string; operator: string; value: string };

function randomSecret(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const input =
	"w-full rounded border border-border bg-background px-2 py-1 text-sm text-foreground";
const label = "block text-xs text-muted-foreground mb-1";

export function CreateForm({ targets, runtimes }: { targets: Target[]; runtimes: string[] }) {
	const [open, setOpen] = useState(false);
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);

	const [name, setName] = useState("");
	const [source, setSource] = useState("cron");
	const [target, setTarget] = useState(targets[0] ? `${targets[0].kind}:${targets[0].id}` : "");
	const [prompt, setPrompt] = useState("");
	const [runtime, setRuntime] = useState("");
	const [expression, setExpression] = useState("0 9 * * 1");
	const [timezone, setTimezone] = useState("UTC");
	const [secret, setSecret] = useState("");
	const [conditions, setConditions] = useState<Condition[]>([]);

	const isEvent = source !== "cron";

	const submit = () => {
		setError(null);
		const [targetKind, targetId] = target.split(":");
		const spec = isEvent
			? {
					secret,
					conditions: conditions
						.filter((c) => c.value.trim())
						.map((c) => ({
							field: c.field,
							operator: c.operator,
							value:
								c.operator === "any_of" || c.operator === "none_of"
									? c.value.split(",").map((v) => v.trim()).filter(Boolean)
									: c.value.trim(),
						})),
				}
			: { expression, timezone };

		startTransition(async () => {
			try {
				const response = await fetch("/api/automations", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						name,
						source,
						targetKind,
						targetId,
						prompt,
						runtime: runtime || null,
						spec,
					}),
				});
				const payload = (await response.json()) as { error?: string };
				if (response.ok) {
					window.location.reload();
				} else {
					setError(payload.error ?? "Failed to create automation.");
				}
			} catch (caught) {
				setError((caught as Error).message);
			}
		});
	};

	if (!open) {
		return (
			<button
				className="rounded border border-border px-3 py-1.5 text-sm text-foreground hover:bg-muted"
				onClick={() => setOpen(true)}
				type="button"
			>
				+ New automation
			</button>
		);
	}

	if (targets.length === 0) {
		return (
			<div className="rounded border border-border p-4 text-sm text-muted-foreground">
				Connect a repository or create an environment before adding an automation — an
				automation needs somewhere to run.
			</div>
		);
	}

	return (
		<div className="space-y-3 rounded border border-border p-4">
			<div className="grid grid-cols-2 gap-3">
				<div className="col-span-2">
					<label className={label}>Name</label>
					<input className={input} onChange={(e) => setName(e.target.value)} value={name} />
				</div>

				<div>
					<label className={label}>Trigger</label>
					<select className={input} onChange={(e) => setSource(e.target.value)} value={source}>
						<option value="cron">cron — on a schedule</option>
						<option value="webhook">webhook — on an inbound POST</option>
						<option value="sentry">sentry — on an alert</option>
					</select>
				</div>

				<div>
					<label className={label}>Target</label>
					<select className={input} onChange={(e) => setTarget(e.target.value)} value={target}>
						{targets.map((t) => (
							<option key={`${t.kind}:${t.id}`} value={`${t.kind}:${t.id}`}>
								{t.label}
							</option>
						))}
					</select>
				</div>

				{isEvent ? (
					<>
						<div className="col-span-2">
							<label className={label}>Signing secret (HMAC-SHA256 over the request body)</label>
							<div className="flex gap-2">
								<input
									className={input}
									onChange={(e) => setSecret(e.target.value)}
									placeholder="at least 16 characters"
									value={secret}
								/>
								<button
									className="shrink-0 rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-muted"
									onClick={() => setSecret(randomSecret())}
									type="button"
								>
									generate
								</button>
							</div>
						</div>
						<div className="col-span-2">
							<div className="flex items-center justify-between">
								<label className={label}>Conditions (all must match; none = fire on every delivery)</label>
								<button
									className="text-xs text-muted-foreground hover:text-foreground"
									onClick={() =>
										setConditions((c) => [...c, { field: "label", operator: "any_of", value: "" }])
									}
									type="button"
								>
									+ add
								</button>
							</div>
							{conditions.map((condition, index) => (
								<div className="mb-1 flex gap-2" key={index}>
									<select
										className={input}
										onChange={(e) =>
											setConditions((c) =>
												c.map((x, i) => (i === index ? { ...x, field: e.target.value } : x)),
											)
										}
										value={condition.field}
									>
										{CONDITION_FIELDS.map((f) => (
											<option key={f} value={f}>
												{f}
											</option>
										))}
									</select>
									<select
										className={input}
										onChange={(e) =>
											setConditions((c) =>
												c.map((x, i) => (i === index ? { ...x, operator: e.target.value } : x)),
											)
										}
										value={condition.operator}
									>
										{CONDITION_OPERATORS.map((o) => (
											<option key={o} value={o}>
												{o}
											</option>
										))}
									</select>
									<input
										className={input}
										onChange={(e) =>
											setConditions((c) =>
												c.map((x, i) => (i === index ? { ...x, value: e.target.value } : x)),
											)
										}
										placeholder="value, or comma-separated for any_of/none_of"
										value={condition.value}
									/>
								</div>
							))}
						</div>
					</>
				) : (
					<>
						<div>
							<label className={label}>Schedule (5-field cron)</label>
							<input
								className={input}
								onChange={(e) => setExpression(e.target.value)}
								value={expression}
							/>
						</div>
						<div>
							<label className={label}>Timezone</label>
							<input
								className={input}
								onChange={(e) => setTimezone(e.target.value)}
								value={timezone}
							/>
						</div>
					</>
				)}

				<div>
					<label className={label}>Runtime (optional)</label>
					<select className={input} onChange={(e) => setRuntime(e.target.value)} value={runtime}>
						<option value="">deployment default</option>
						{runtimes.map((r) => (
							<option key={r} value={r}>
								{r}
							</option>
						))}
					</select>
				</div>

				<div className="col-span-2">
					<label className={label}>Prompt</label>
					<textarea
						className={`${input} min-h-20`}
						onChange={(e) => setPrompt(e.target.value)}
						value={prompt}
					/>
				</div>
			</div>

			{error ? <p className="text-xs text-destructive">{error}</p> : null}

			<div className="flex items-center gap-2">
				<button
					className="rounded border border-primary/50 bg-primary/10 px-3 py-1.5 text-sm text-primary hover:bg-primary/20 disabled:opacity-50"
					disabled={pending}
					onClick={submit}
					type="button"
				>
					{pending ? "creating…" : "Create"}
				</button>
				<button
					className="rounded border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted"
					onClick={() => setOpen(false)}
					type="button"
				>
					Cancel
				</button>
			</div>
		</div>
	);
}
