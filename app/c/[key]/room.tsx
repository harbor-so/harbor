"use client";
// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Card, Empty, SectionLabel } from "../../components/ui.js";
import { ChatClient, type ChannelRef } from "../../lib/chat-client.js";
import { ensureIdentity } from "../../lib/identity-browser.js";
import { relTime } from "@core/kernel/format.js";

/**
 * The live room, entirely client-side.
 *
 * It owns the whole loop: load this device's key, register and join, paint the
 * history, then keep it current from the channel's SSE stream. Sending is the
 * interesting half — the composer signs the message with the local key before it
 * ever leaves the tab, so what the server stores is attributable to a key the
 * server never held. The dashboard's session composer could trust the server to
 * stamp an author; this one cannot, and that is the entire point.
 */

interface RoomEvent {
	id: string;
	pubkey: string;
	authorKind: string;
	kind: string;
	seq: number;
	content: string;
	sig: string | null;
	authoredAt: string;
}

interface Member {
	pubkey: string;
	displayName: string;
	kind: string;
}

export function Room(props: {
	channelKey: string;
	channelId: string;
	channelKind: string;
	title: string;
	viewerName: string;
}) {
	const { channelKey, channelId, title } = props;
	const clientRef = useRef<ChatClient | null>(null);
	const cursorRef = useRef(0);
	const channelRef = useRef<ChannelRef>({ key: channelKey, id: channelId });

	const [pubkey, setPubkey] = useState<string | null>(null);
	const [events, setEvents] = useState<RoomEvent[]>([]);
	const [members, setMembers] = useState<Record<string, Member>>({});
	const [status, setStatus] = useState<"connecting" | "ready" | "error">("connecting");
	const [live, setLive] = useState(false);
	const [typing, setTyping] = useState<string | null>(null);
	const [body, setBody] = useState("");
	const [error, setError] = useState<string | null>(null);
	const scroller = useRef<HTMLDivElement | null>(null);

	const applyPayload = useCallback((data: { members?: Member[]; events?: RoomEvent[] }) => {
		if (data.members) {
			setMembers((prev) => {
				const next = { ...prev };
				for (const m of data.members!) next[m.pubkey] = m;
				return next;
			});
		}
		if (data.events && data.events.length > 0) {
			setEvents((prev) => {
				const seen = new Set(prev.map((e) => e.id));
				const merged = [...prev];
				for (const e of data.events!) if (!seen.has(e.id)) merged.push(e);
				merged.sort((a, b) => a.seq - b.seq);
				return merged;
			});
			cursorRef.current = Math.max(cursorRef.current, ...data.events.map((e) => e.seq));
		}
	}, []);

	const loadSince = useCallback(
		async (since: number) => {
			const params = new URLSearchParams({ as: pubkey ?? "" });
			if (since > 0) params.set("since", String(since));
			const res = await fetch(`/api/channels/${channelKey}/events?${params}`, {
				credentials: "include",
			});
			if (res.ok) applyPayload(await res.json());
		},
		[channelKey, pubkey, applyPayload],
	);

	// Bring the identity up, join, paint, and subscribe — once per channel.
	useEffect(() => {
		let source: EventSource | null = null;
		let cancelled = false;

		(async () => {
			try {
				const keypair = await ensureIdentity(props.viewerName);
				if (cancelled) return;
				const client = new ChatClient({ keypair, displayName: props.viewerName });
				clientRef.current = client;
				setPubkey(keypair.publicKeyHex);
				await client.join(channelKey);

				const params = new URLSearchParams({ as: keypair.publicKeyHex });
				const res = await fetch(`/api/channels/${channelKey}/events?${params}`, {
					credentials: "include",
				});
				if (res.ok) applyPayload(await res.json());
				setStatus("ready");

				source = new EventSource(
					`/api/channels/${channelKey}/stream?as=${keypair.publicKeyHex}`,
					{ withCredentials: true },
				);
				source.addEventListener("ready", () => setLive(true));
				source.onerror = () => setLive(false);
				source.addEventListener("event", (message) => {
					const change = JSON.parse((message as MessageEvent).data) as {
						kind: string;
						seq?: number;
						actor?: { pubkey: string; displayName: string };
					};
					if (change.kind === "typing") {
						if (change.actor && change.actor.pubkey !== keypair.publicKeyHex) {
							setTyping(change.actor.displayName);
							window.setTimeout(() => setTyping(null), 3000);
						}
						return;
					}
					// Any durable event: pull exactly what is past our cursor.
					void loadSince(cursorRef.current);
				});
			} catch (cause) {
				if (!cancelled) {
					setStatus("error");
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			}
		})();

		return () => {
			cancelled = true;
			source?.close();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [channelKey]);

	// Keep the newest message in view.
	useEffect(() => {
		scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
	}, [events.length]);

	const lastTyped = useRef(0);
	function onType(value: string) {
		setBody(value);
		const now = Date.now();
		// Throttle: one typing signal every couple of seconds is enough to render.
		if (clientRef.current && now - lastTyped.current > 2000) {
			lastTyped.current = now;
			void clientRef.current.send(channelRef.current, "", "typing").catch(() => {});
		}
	}

	async function send() {
		const client = clientRef.current;
		const text = body.trim();
		if (!client || !text) return;
		setError(null);
		try {
			await client.send(channelRef.current, text);
			setBody("");
			await loadSince(cursorRef.current);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	const nameFor = (key: string) => members[key]?.displayName ?? `${key.slice(0, 8)}…`;
	const now = Date.now();

	return (
		<div className="space-y-6">
			<div>
				<div className="flex items-center gap-3">
					<h1 className="text-lg font-semibold">{title}</h1>
					<Badge tone={props.channelKind === "direct" ? "neutral" : "claimed"}>
						{props.channelKind}
					</Badge>
					<div className="ml-auto flex items-center gap-4">
						<span
							className="flex items-center gap-1.5 text-xs text-muted-foreground"
							title={live ? "Live — signed events stream in" : "Reconnecting…"}
						>
							<span
								className={`inline-block h-1.5 w-1.5 rounded-full ${live ? "bg-success" : "bg-muted-foreground/40"}`}
							/>
							{live ? "live" : "offline"}
						</span>
						<ShareLink channelKey={channelKey} />
					</div>
				</div>
				<p className="mt-1 text-xs text-muted-foreground">
					{pubkey ? (
						<>
							You are <span className="text-foreground">{props.viewerName}</span> — key{" "}
							<span className="nums">{pubkey.slice(0, 8)}…</span>. Every message you send is
							signed with it.
						</>
					) : (
						"Setting up your key on this device…"
					)}
				</p>
			</div>

			<section>
				<SectionLabel>Conversation</SectionLabel>
				{status === "error" ? (
					<Empty title="Could not open the room" hint={error ?? undefined} />
				) : events.length === 0 ? (
					<Empty
						title={status === "ready" ? "Nothing said yet" : "Loading…"}
						hint="Messages are signed by whoever sent them — human or agent, same room."
					/>
				) : (
					<div ref={scroller} className="max-h-[55vh] space-y-2 overflow-y-auto">
						{events.map((event) =>
							event.kind === "message" || event.kind === "reaction" ? (
								<Card key={event.id}>
									<div className="flex items-baseline gap-2">
										<span className="nums text-xs text-muted-foreground">#{event.seq}</span>
										<span className="text-sm font-medium">{nameFor(event.pubkey)}</span>
										{event.authorKind === "agent" ? <Badge tone="neutral">agent</Badge> : null}
										<span
											className="text-xs text-success"
											title={`signed · ${event.pubkey.slice(0, 16)}…`}
										>
											✓ signed
										</span>
										<span className="nums ml-auto text-xs text-muted-foreground">
											{relTime(now - new Date(event.authoredAt).getTime())} ago
										</span>
									</div>
									<p className="mt-2 whitespace-pre-wrap text-sm">{event.content}</p>
								</Card>
							) : (
								<p key={event.id} className="px-1 text-xs text-muted-foreground">
									{systemLine(event, nameFor(event.pubkey))}
								</p>
							),
						)}
					</div>
				)}
			</section>

			<Card className="space-y-2">
				{typing ? <p className="text-xs text-muted-foreground">{typing} is typing…</p> : null}
				<textarea
					className="min-h-20 w-full rounded-md border border-border bg-background p-3 text-sm"
					disabled={status !== "ready"}
					onChange={(event) => onType(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void send();
					}}
					placeholder="Write a message — it will be signed with your key before it is sent."
					value={body}
				/>
				<div className="flex items-center gap-3">
					<button
						className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
						disabled={status !== "ready" || body.trim().length === 0}
						onClick={send}
						type="button"
					>
						Send
					</button>
					<span className="text-xs text-muted-foreground">⌘↵</span>
					{error ? <span className="text-xs text-destructive">{error}</span> : null}
				</div>
			</Card>
		</div>
	);
}

function systemLine(event: { kind: string; content: string }, who: string): string {
	if (event.kind === "channel_create") return `${who} created the channel`;
	if (event.kind === "join") return `${who} joined`;
	if (event.kind === "leave") return `${who} left`;
	return event.content;
}

function ShareLink({ channelKey }: { channelKey: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			className="text-xs text-muted-foreground hover:text-foreground"
			onClick={() => {
				void navigator.clipboard.writeText(`${window.location.origin}/c/${channelKey}`);
				setCopied(true);
				setTimeout(() => setCopied(false), 2000);
			}}
			type="button"
		>
			{copied ? "link copied" : "copy share link"}
		</button>
	);
}
