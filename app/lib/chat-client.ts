// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The client half of the protocol, used identically by a browser tab and an
 * agent process.
 *
 * There is one implementation because there is one protocol: sign an event with
 * your Ed25519 key, POST it, read the log back. A browser holds a non-extractable
 * key and authenticates with its session cookie; an agent holds its own key and
 * authenticates with an org API key. Nothing else differs, so nothing else is
 * forked — the same `send()` runs in both, which is the point of putting the
 * signature in the client rather than trusting the server to attribute.
 *
 * Isomorphic on purpose: `fetch` and `crypto.subtle` are the only ambient
 * globals it touches, both present in a modern browser and in Node ≥20.
 */

import { signEvent, type EventKind, type Keypair, type SignedEvent } from "./signing.js";

export interface ChannelRef {
	/** URL key (what /c/<key> uses). */
	key: string;
	/** UUID (what a signed event's channelId must equal). */
	id: string;
	kind?: string;
	title?: string;
}

export interface ChatClientOptions {
	/** Origin to talk to. "" (default) means same-origin, for the browser. */
	baseUrl?: string;
	/** Org API key, for an agent. A browser omits this and relies on its cookie. */
	apiKey?: string;
	keypair: Keypair;
	displayName: string;
}

export class ChatClient {
	private readonly baseUrl: string;
	private readonly apiKey?: string;
	readonly keypair: Keypair;
	readonly displayName: string;

	constructor(options: ChatClientOptions) {
		this.baseUrl = options.baseUrl ?? "";
		this.apiKey = options.apiKey;
		this.keypair = options.keypair;
		this.displayName = options.displayName;
	}

	get pubkey(): string {
		return this.keypair.publicKeyHex;
	}

	private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
		const headers = new Headers(init.headers);
		headers.set("content-type", "application/json");
		if (this.apiKey) headers.set("authorization", `Bearer ${this.apiKey}`);
		const response = await fetch(`${this.baseUrl}${path}`, {
			...init,
			headers,
			// The browser needs the session cookie; an agent ignores this.
			credentials: "include",
		});
		const data = (await response.json().catch(() => ({}))) as T & { error?: string };
		if (!response.ok) throw new Error(data.error ?? `${path} failed (${response.status})`);
		return data;
	}

	/** Announce this key to the org. Idempotent; call it once on startup. */
	async register(): Promise<void> {
		await this.req("/api/principals", {
			method: "POST",
			body: JSON.stringify({ pubkey: this.pubkey, displayName: this.displayName }),
		});
	}

	async createChannel(input: {
		title: string;
		kind?: "group" | "direct" | "task";
		members?: Array<{ pubkey: string; displayName: string; kind?: "human" | "agent" }>;
	}): Promise<ChannelRef> {
		const result = await this.req<{ key: string; id: string }>("/api/channels", {
			method: "POST",
			body: JSON.stringify({ ...input, createdBy: this.pubkey }),
		});
		return { key: result.key, id: result.id, kind: input.kind, title: input.title };
	}

	async listChannels(): Promise<ChannelRef[]> {
		const query = this.apiKey ? `?as=${this.pubkey}` : "";
		const result = await this.req<{ channels: ChannelRef[] }>(`/api/channels${query}`);
		return result.channels;
	}

	async join(key: string): Promise<{ id: string; joined: boolean }> {
		return this.req(`/api/channels/${key}/join`, {
			method: "POST",
			body: JSON.stringify({ pubkey: this.pubkey, displayName: this.displayName }),
		});
	}

	/** Sign an event for a channel — exposed so a browser can sign then send in two steps. */
	async sign(channel: ChannelRef, content: string, kind: EventKind = "message", tags: string[][] = []): Promise<SignedEvent> {
		return signEvent(
			{
				pubkey: this.pubkey,
				channelId: channel.id,
				kind,
				createdAt: Math.floor(Date.now() / 1000),
				content,
				tags,
			},
			this.keypair.privateKey,
		);
	}

	/** Sign and post an event. Returns the assigned seq for a durable event. */
	async send(
		channel: ChannelRef,
		content: string,
		kind: EventKind = "message",
		tags: string[][] = [],
	): Promise<{ ephemeral: boolean; seq?: number }> {
		const event = await this.sign(channel, content, kind, tags);
		return this.req(`/api/channels/${channel.key}/events`, {
			method: "POST",
			body: JSON.stringify(event),
		});
	}

	/** Fetch events after `since` (a seq). Returns them oldest-first. */
	async fetchEvents(key: string, since?: number): Promise<SignedEvent[]> {
		const params = new URLSearchParams({ as: this.pubkey });
		if (since !== undefined) params.set("since", String(since));
		const result = await this.req<{ events: SignedEvent[] }>(
			`/api/channels/${key}/events?${params.toString()}`,
		);
		return result.events;
	}

	/**
	 * Poll a channel for new events, batching everything past the cursor into one
	 * callback — the agent-side of "one turn, all the new context".
	 * Returns a stop function. For a browser, prefer an EventSource on the stream
	 * endpoint; polling keeps the agent path dependency-free.
	 */
	poll(
		key: string,
		onBatch: (events: SignedEvent[]) => void | Promise<void>,
		intervalMs = 1500,
	): () => void {
		let cursor = 0;
		let stopped = false;
		const tick = async () => {
			if (stopped) return;
			try {
				const events = await this.fetchEvents(key, cursor);
				if (events.length > 0) {
					cursor = Math.max(cursor, ...events.map((e) => (e as unknown as { seq: number }).seq));
					await onBatch(events);
				}
			} catch {
				// A transient failure should not kill the loop; the next tick retries.
			}
			if (!stopped) timer = setTimeout(tick, intervalMs);
		};
		let timer = setTimeout(tick, 0);
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	}
}
