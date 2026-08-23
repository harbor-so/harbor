// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The connector boundary.
 *
 * A connector is one file. That is the whole design goal. The alternative shape —
 * one deployable service per integration — makes "we also use Jira" a decision
 * about infrastructure: a service to write, provision, deploy and monitor. Almost
 * nobody pays that for the fourth integration, so the connector list stops
 * growing at whatever shipped. Here it means implementing this interface and
 * adding one line to `registry.ts`, and the thing you wrote runs inside the app
 * the operator is already running.
 *
 * The interface grew from four members to seven when Harbor stopped being
 * inbound-only. Each addition has a reason:
 *
 *  - `resolveAccount` exists to fix a real, documented bug. Webhook ingest used to
 *    select the connector row by `type` alone, so the first active row won and two
 *    organisations sharing a connector type delivered each other's issues. The
 *    account id must come from the *verified* payload, never from a header or a
 *    query parameter, because the entire point is that the sender cannot assert
 *    which tenant it belongs to.
 *
 *  - `route` exists because an inbound message has to become work in a specific
 *    repository, and "which one" is a genuinely hard question that most of the
 *    time has an easy answer. See `routing.ts`.
 *
 *  - `postActivity` and `linkArtifact` are what make a connector bidirectional.
 *    A background agent that does its work in a place nobody is looking is a
 *    background agent nobody uses; the progress has to come back to the thread the
 *    person was already in.
 *
 *  - `outboundWrites` is a declaration, not documentation. Every external write a
 *    connector is capable of making is listed here, the `/connectors` page renders
 *    it, and `CONNECTORS.md` is generated from it. A security reviewer asking "what
 *    can this thing write into our Slack" gets an answer from the code rather than
 *    from a paragraph somebody remembered to update.
 */

import type { RouteTarget } from "../contracts/index.js";

/**
 * Everything a handler needs, resolved before it is called.
 *
 * Passing a context object rather than a bare `orgId` is what stopped the
 * previous signature from growing a fourth positional parameter every time a
 * connector needed one more fact. `traceId` in particular has to reach the
 * handler so that one Slack message and the pull request it eventually produces
 * share a single greppable token across three processes.
 */
export interface ConnectorContext {
	orgId: string;
	connectorId: string;
	/** The verified external account: a Slack team id, a GitHub installation id. */
	externalAccountId: string;
	/** Connector configuration — tokens, mappings, secrets. Never sent to a client. */
	config: Record<string, unknown>;
	traceId: string;
}

/**
 * What a connector may write to the outside world.
 *
 * `scope` names the credential it needs, `description` is written for a security
 * reviewer rather than a user, and `triggeredBy` says what causes it — because
 * "can post messages" and "posts one message when a session finishes" are very
 * different risk statements and only the second is useful.
 */
export interface OutboundWrite {
	action: string;
	scope: string;
	description: string;
	triggeredBy: string;
}

export interface Connector {
	type: string;

	/**
	 * Verify the signature against the RAW BYTES, before anything parses them.
	 *
	 * Verifying a re-serialised object is the classic way to make signature
	 * checking useless: `JSON.parse` followed by `JSON.stringify` does not
	 * reproduce the sender's whitespace or key order, so either the check fails
	 * for valid payloads or somebody "fixes" it by trusting the parse.
	 */
	verifyWebhook(
		rawBody: string,
		headers: Record<string, string | undefined>,
		secret: string,
	): boolean;

	/**
	 * Which external account sent this, read out of the verified payload.
	 *
	 * Returning null means the payload does not name an account Harbor can trust.
	 * Ingest then REFUSES rather than guessing — a webhook whose tenant cannot be
	 * established is a webhook that must not be processed, because every wrong
	 * guess writes one organisation's data into another's.
	 */
	resolveAccount(payload: unknown): string | null;

	handleWebhook(payload: unknown, ctx: ConnectorContext): Promise<WebhookResult>;

	/** Where should the work this payload describes actually run? */
	route?(payload: unknown, ctx: ConnectorContext): Promise<RouteTarget>;

	/** Post progress back to the thread the request came from. */
	postActivity?(ctx: ConnectorContext, activity: ConnectorActivity): Promise<void>;

	/** Link a produced artifact — usually a pull request — back to the source. */
	linkArtifact?(ctx: ConnectorContext, artifact: ConnectorArtifact): Promise<void>;

	/** Legacy single-purpose outbound path. Superseded by `postActivity`. */
	syncOutbound?(taskId: string, orgId: string, summary: string): Promise<void>;

	/** Every external write this connector can make. Rendered by /connectors. */
	outboundWrites: readonly OutboundWrite[];
}

export type WebhookResult = {
	action: "created" | "updated" | "ignored" | "session_started" | "clarification_requested";
	taskId?: string;
	sessionId?: string;
	reason?: string;
};

/**
 * A progress update travelling outward.
 *
 * Deliberately coarse. A connector that posts every token produces a Slack thread
 * nobody can read and a rate limit nobody expected; these five moments are the
 * ones a person waiting on the work actually wants.
 */
export interface ConnectorActivity {
	sessionId: string;
	sessionKey: string;
	/** Where to reply: a Slack thread ts, a Linear issue id, a GitHub PR number. */
	threadRef: string;
	kind: "started" | "progress" | "needs_input" | "finished" | "failed";
	text: string;
}

export interface ConnectorArtifact {
	sessionId: string;
	threadRef: string;
	kind: "branch" | "pull_request" | "screenshot" | "file" | "log";
	title: string;
	url: string | null;
}
