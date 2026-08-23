// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The one place that talks to Devin's API, so token handling and the error shape
 * cannot diverge between the poller and the registration endpoint.
 *
 * Devin has no push channel — no hooks, no outbound webhooks — so everything
 * Harbor learns about a Devin session comes from GETting it here. That makes the
 * error shape load-bearing: a `DevinApiError` carries the HTTP status so the poll
 * loop can tell a transient failure (retry next tick) from a permanent one (404 a
 * deleted session, 401 a revoked token) that should drop the session out of the
 * poll set instead of being retried forever.
 */

/** Public base; override with DEVIN_API_BASE_URL for a proxy or a test double. */
const DEFAULT_BASE_URL = "https://api.devin.ai/v1";

function baseUrl(): string {
	return process.env.DEVIN_API_BASE_URL?.replace(/\/+$/, "") || DEFAULT_BASE_URL;
}

/** An error from Devin's API, tagged with the HTTP status the poller branches on. */
export class DevinApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "DevinApiError";
	}

	/** A permanent failure: the session or token is gone, not merely unavailable. */
	get isPermanent(): boolean {
		return this.status === 401 || this.status === 403 || this.status === 404;
	}
}

/** A Devin pull request, as much of it as Harbor records. */
export interface DevinPullRequest {
	url?: string;
	title?: string;
}

/** The Devin session fields the tracker reads. Loosely typed on purpose — Devin
 *  owns this shape and adds fields Harbor should ignore rather than reject. */
export interface DevinSession {
	session_id: string;
	status?: string;
	status_enum?: string;
	messages?: unknown[];
	pull_request?: DevinPullRequest | null;
	structured_output?: unknown;
	updated_at?: string;
	created_at?: string;
	[key: string]: unknown;
}

async function devinFetch(token: string, path: string, init?: RequestInit): Promise<unknown> {
	const response = await fetch(`${baseUrl()}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			...(init?.headers ?? {}),
		},
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		throw new DevinApiError(`Devin API ${path} failed with HTTP ${response.status}.`, response.status);
	}
	return response.json();
}

/** Fetch one session's current state. Throws `DevinApiError` on any non-2xx. */
export async function getDevinSession(token: string, sessionId: string): Promise<DevinSession> {
	const body = (await devinFetch(token, `/session/${encodeURIComponent(sessionId)}`)) as DevinSession;
	// Devin's payload always names the session, but a proxy or a stubbed response
	// might not; fall back to the id we asked for so downstream code always has one.
	return { ...body, session_id: body.session_id ?? sessionId };
}

/** Start a new Devin session from a prompt. Returns Devin's new session id. */
export async function createDevinSession(token: string, prompt: string): Promise<{ session_id: string }> {
	const body = (await devinFetch(token, "/sessions", {
		method: "POST",
		body: JSON.stringify({ prompt }),
	})) as { session_id?: string };
	if (!body.session_id) {
		throw new DevinApiError("Devin session creation returned no session_id.", 502);
	}
	return { session_id: body.session_id };
}
