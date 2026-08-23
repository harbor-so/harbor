// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
import { setting } from "@core/kernel/config.js";
import type { GitOperation } from "../../../../git/credentials.js";
import { GIT_OPERATIONS, mintGitCredential } from "../../../../git/credentials.js";
import { assertNever } from "../../../../sandbox/decisions.js";
import { validateFence } from "../../../../sandbox/manager.js";
import {
	authenticateSandbox,
	describeFenceRefusal,
	fencingTokenFrom,
} from "../../../../lib/session-runner.js";

/**
 * The git credential broker. Called by the in-sandbox helper, per operation.
 *
 * **This endpoint is why credentials never appear in a session snapshot.** A
 * snapshot is sent on every connect and reconnect; it is logged, cached, replayed
 * in tests and pasted into bug reports, so anything inside it eventually ends up
 * somewhere it was not meant to be. The rule is therefore structural rather than
 * remembered: a snapshot carries state and never secrets, and a credential is
 * fetched from here — authenticated, fenced, scoped to one operation, never
 * persisted — or it is not obtained at all. A bug in the snapshot path leaks a
 * transcript; a bug that put a token in a snapshot would leak write access to a
 * customer's repository, and those are different severities.
 *
 * It is also why a long-running session does not die at the moment the agent is
 * finally ready to push. An embedded token — in the environment, or in a remote
 * URL — expires on a schedule uncorrelated with when the work finishes, and a
 * background agent's work finishes hours later by design. A brokered credential is
 * minted for the operation about to happen.
 *
 * Four properties, and the order of the checks below is the design:
 *
 *  1. **Only a sandbox can call this.** Authentication is the box's own
 *     session-scoped token, compared in constant time against a stored digest.
 *     There is deliberately no signed-in-viewer path: a credential a browser can
 *     obtain is a credential that leaks through an extension, an XSS or a
 *     screen-share.
 *  2. **The fence is checked.** Authentication cannot catch the case this exists
 *     for — a box whose lease lapsed still holds a genuine token. Handing that box
 *     a push credential is two agents pushing to one branch, which is case 4 of the
 *     four ambiguous failures documented on `SpawnIntent` in `src/contracts`.
 *  3. **State is re-read on every call**, never captured for the life of a
 *     connection. A box that has since been stopped, superseded or reaped must stop
 *     being able to push *now*, and a capability resolved once at connect time
 *     keeps working through exactly the window in which another agent has
 *     legitimately taken the work.
 *  4. **Least privilege per operation.** `mintGitCredential` gives a clone a
 *     read-only token and only a push a writable one, scoped to the single
 *     repository. Without the split, a credential leaked from a clone — the
 *     operation that runs unattended at boot, before any human is watching — can
 *     rewrite every repository the installation covers.
 *
 * POST is the canonical verb and GET is accepted for the same work. Neither
 * request carries a secret — a repository name and an operation are not sensitive
 * — but the *response* is one, and intermediaries treat a GET response as
 * cacheable by default in a way they do not treat a POST. `no-store` says so
 * explicitly on both; the verb is the belt behind that brace.
 */
export const dynamic = "force-dynamic";

/**
 * The ceiling on a credential request body.
 *
 * Reused from `maxEventPayloadChars` rather than invented here: this body is one
 * small JSON object naming a repository, so any existing ceiling that comfortably
 * contains it is a fair bound, and reusing one means an operator cannot discover a
 * second hidden limit halfway down a file they did not know existed. A dedicated
 * setting would be more honest still, but adding one is a change to
 * `src/config.ts`, which this file does not own.
 */
function bodyCeilingChars(): number {
	return setting("maxEventPayloadChars");
}

/**
 * Read the body, refusing rather than buffering past the ceiling.
 *
 * `request.text()` is one line and buffers whatever arrives, and a ceiling checked
 * after the read is not a ceiling: the memory has already been spent by the time it
 * fires. That matters more here than anywhere else in the product, because this
 * endpoint is reachable **before authentication** — the sandbox id in the URL and
 * the token in the header are only examined once the body is in hand — so anybody
 * who can reach the control plane can otherwise make it buffer a gigabyte per
 * request, with no credential at all, until the process dies. Cancelling rather
 * than draining is deliberate: reading the rest to be polite is reading the rest,
 * which is the thing being refused. Same discipline as the events ingest route.
 */
async function readBounded(request: Request, ceiling: number): Promise<string | "too_large"> {
	const declared = Number(request.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > ceiling) return "too_large";

	const body = request.body;
	if (!body) return "";

	const reader = body.getReader();
	const decoder = new TextDecoder();
	let total = 0;
	let text = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > ceiling) {
			await reader.cancel().catch(() => {});
			return "too_large";
		}
		text += decoder.decode(value, { stream: true });
	}
	text += decoder.decode();
	return text;
}

function operationFrom(raw: unknown): GitOperation | null {
	const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
	return (GIT_OPERATIONS as readonly string[]).includes(value) ? (value as GitOperation) : null;
}

interface CredentialRequest {
	owner: string | null;
	name: string | null;
	host: string | undefined;
	protocol: string | undefined;
	operation: GitOperation | null;
}

function fromQuery(request: Request): CredentialRequest {
	const query = new URL(request.url).searchParams;
	return {
		owner: query.get("owner")?.trim() || null,
		name: query.get("name")?.trim() || null,
		host: query.get("host")?.trim() || undefined,
		protocol: query.get("protocol")?.trim() || undefined,
		operation: operationFrom(query.get("operation")),
	};
}

function fromBody(raw: string): CredentialRequest | "malformed" {
	let parsed: unknown;
	try {
		parsed = raw.trim() === "" ? {} : JSON.parse(raw);
	} catch {
		return "malformed";
	}
	const body = parsed as {
		repo?: { owner?: unknown; name?: unknown; host?: unknown; protocol?: unknown };
		operation?: unknown;
	};
	const repo = body.repo ?? {};
	return {
		owner: typeof repo.owner === "string" ? repo.owner.trim() || null : null,
		name: typeof repo.name === "string" ? repo.name.trim() || null : null,
		host: typeof repo.host === "string" ? repo.host.trim() || undefined : undefined,
		protocol: typeof repo.protocol === "string" ? repo.protocol.trim() || undefined : undefined,
		operation: operationFrom(body.operation),
	};
}

async function broker(request: Request, id: string, wanted: CredentialRequest): Promise<Response> {
	const auth = await authenticateSandbox(id, request.headers);
	if (!auth.ok) {
		// The specific reason is logged and not returned. Telling an unauthenticated
		// caller whether a sandbox id exists — or whether it exists but is merely
		// stopped — is a distinction that helps nobody except somebody probing.
		console.error(`[credentials] refused sandbox ${id}: ${auth.reason}`);
		return Response.json({ error: "Not authorised." }, { status: 401 });
	}

	const header = fencingTokenFrom(request.headers);
	if (!header.ok) {
		return Response.json({ error: header.message, reason: header.reason }, { status: 409 });
	}
	const fence = await validateFence(auth.sandbox.id, header.token);
	if (!fence.valid) {
		// 409, not 403. The caller is authentic and is not forbidden in general — it
		// is out of date, and the difference is what tells a helper to stop rather
		// than to re-check its credentials and retry forever.
		return Response.json(
			{ error: describeFenceRefusal(fence), reason: fence.reason },
			{ status: 409, headers: { "cache-control": "no-store" } },
		);
	}

	if (!wanted.owner || !wanted.name) {
		return Response.json(
			{ error: "A repository owner and name are required.", reason: "repo_unspecified" },
			{ status: 400 },
		);
	}
	// The operation is required rather than defaulted, and the default deliberately
	// not offered is `push`. Least privilege only works if the caller has to say
	// what it is doing: a helper that omitted the parameter during a clone would
	// otherwise be handed write access at boot, before any human is watching.
	if (!wanted.operation) {
		return Response.json(
			{
				error: `\`operation\` must be one of ${GIT_OPERATIONS.join(", ")}.`,
				reason: "operation_unspecified",
			},
			{ status: 400 },
		);
	}

	const outcome = await mintGitCredential(auth.sandbox.id, {
		repo: {
			owner: wanted.owner,
			name: wanted.name,
			host: wanted.host,
			protocol: wanted.protocol,
		},
		operation: wanted.operation,
	});

	// Exhaustive, with no `default`: a new outcome kind is a compile error here
	// rather than a 200 carrying an undefined password.
	switch (outcome.kind) {
		case "minted":
			return Response.json(
				{
					username: outcome.username,
					password: outcome.password,
					expires_at: outcome.expires_at,
					host: outcome.host,
					repo: outcome.repo,
					operation: outcome.operation,
				},
				{
					headers: {
						// A live credential. An intermediary that cached this would serve one
						// sandbox's token to the next box that asked, and the failure would be
						// invisible from both ends.
						"cache-control": "no-store, no-cache, must-revalidate, private",
						pragma: "no-cache",
					},
				},
			);

		case "refused":
			// 403 and 502 are different on purpose. A refusal is a decision and the
			// helper must not retry it; a failure is upstream and the helper should.
			// One error code for both makes a misconfigured repository
			// indistinguishable from a GitHub outage, and the helper then either
			// retries forever or gives up on something transient.
			console.error(`[credentials] refused ${wanted.owner}/${wanted.name}: ${outcome.reason}`);
			return Response.json(
				{ error: outcome.message, reason: outcome.reason },
				{ status: 403, headers: { "cache-control": "no-store" } },
			);

		case "failed":
			console.error(`[credentials] failed ${wanted.owner}/${wanted.name}: ${outcome.message}`);
			return Response.json(
				{ error: outcome.message, error_type: outcome.error_type },
				{ status: 502, headers: { "cache-control": "no-store" } },
			);
	}
	return assertNever(outcome, "mintGitCredential outcome");
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return broker(request, id, fromQuery(request));
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;

	const raw = await readBounded(request, bodyCeilingChars());
	if (raw === "too_large") {
		return Response.json(
			{ error: "Payload too large.", reason: "body_too_large" },
			{ status: 413 },
		);
	}

	const wanted = fromBody(raw);
	if (wanted === "malformed") {
		return Response.json({ error: "Malformed body.", reason: "malformed_body" }, { status: 400 });
	}
	return broker(request, id, wanted);
}
