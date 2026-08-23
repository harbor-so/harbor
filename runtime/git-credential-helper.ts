// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * `git credential-harbor` — a short-lived credential, fetched per operation.
 *
 * Installed as `git config --global credential.helper harbor`, which makes git
 * exec `git-credential-harbor <operation>` with the request on stdin whenever it
 * needs to authenticate. Nothing else in the sandbox ever holds a token: no
 * `.git-credentials`, no `~/.netrc`, no `url.insteadOf` with a PAT embedded in it,
 * no `GITHUB_TOKEN` in the agent's environment.
 *
 * That last point is the reason this exists at all. A token in the environment is
 * a token in every `ps` line, every crash dump, every `env` an agent prints while
 * debugging, and every log the agent's own telemetry ships. A token in
 * `.git-credentials` is a token in the next filesystem snapshot, which outlives
 * the session by however long the snapshot retention is. A credential that is
 * fetched on demand, held for seconds and never written down is not present in any
 * of those places.
 *
 * ## The cache window, and the coupling it buys
 *
 * `setting("credentialCacheMs")` is deliberately **seconds, not minutes**, and the
 * trade is worth stating precisely because both directions have a real cost:
 *
 *  - **Too short** (zero): one `git push` makes several authenticated calls — a
 *    ref advertisement, the pack upload, sometimes a follow-up fetch — and each
 *    becomes a round trip to the control plane. A brief control-plane blip in the
 *    middle of a push then fails a push that was working, and the agent sees a
 *    git error it will try to "fix" in the repository.
 *  - **Too long** (minutes): revoking a GitHub App installation, removing a user,
 *    or pausing a session stops mattering for as long as the cache lasts. The
 *    security property people expect from a brokered credential is "revocation
 *    takes effect now", and a five-minute cache makes that false.
 *
 * A few seconds covers one composite git operation and no more. Revocation takes
 * effect within one cache window, which is the shortest interval that does not
 * make an ordinary push fragile.
 *
 * The cache is on **disk**, not in memory, and that is forced rather than chosen:
 * git spawns a fresh helper process per invocation, so an in-process cache would
 * be a cache with a lifetime of one call. It is written 0600 into the runtime
 * directory, never into `/workspace`, because `/workspace` is what the agent
 * reads, what gets committed by an over-eager `git add -A`, and what a snapshot
 * captures.
 */

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setting } from "../core/kernel/config.js";
import { correlationHeader } from "../app/contracts/index.js";

/** The operations git may ask a helper to perform. `store` is a deliberate no-op. */
export const CREDENTIAL_OPERATIONS = ["get", "store", "erase"] as const;
export type CredentialOperation = (typeof CREDENTIAL_OPERATIONS)[number];

export interface CredentialRequest {
	operation: string;
	protocol?: string;
	host?: string;
	path?: string;
	username?: string;
}

/**
 * Parse git's credential protocol: `key=value` lines, terminated by a blank line.
 *
 * Unknown keys are kept rather than rejected — git adds fields over time
 * (`wwwauth[]`, `capability[]`, `oauth_refresh_token`) and a helper that rejects a
 * request containing one it has not heard of breaks on a git upgrade, which is
 * the least debuggable moment for a credential helper to start failing.
 */
export function parseCredentialRequest(stdin: string, operation: string): CredentialRequest {
	const request: CredentialRequest = { operation };
	for (const line of stdin.split("\n")) {
		if (line === "") break;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq);
		const value = line.slice(eq + 1);
		if (key === "protocol" || key === "host" || key === "path" || key === "username") {
			request[key] = value;
		}
	}
	return request;
}

export type CredentialDecision =
	| { kind: "authorise"; host: string }
	| {
			kind: "decline";
			reason:
				| "not_a_get"
				| "scm_host_unconfigured"
				| "host_missing"
				| "host_not_authorised"
				| "insecure_protocol";
			message: string;
	  };

/**
 * Should this request get a credential? Fail **closed**, and note the asymmetry.
 *
 * This is an authority question — "may this caller act as the installation?" — so
 * every uncertainty resolves against the caller. A request with no host, an
 * unparseable one, or one for a host we cannot confirm is the configured SCM gets
 * nothing. The opposite convention governs liveness elsewhere in Harbor
 * (`DEAD_SANDBOX_STATUSES` is a deny-list, so an unknown sandbox status means
 * *alive*), because abandoning a working box is unrecoverable while refusing one
 * credential costs a clear error message. Handing a token to a host we could not
 * identify is not recoverable at all: it is exfiltration, performed by us, on
 * request.
 *
 * **HTTPS only.** `git://` and `http://` are refused because the credential would
 * cross the network in the clear, and an agent that was talked into rewriting a
 * remote to `http://` is precisely the attack this closes.
 *
 * **One host.** `setup.sh` cloning *other* private repositories the installation
 * can reach is a first-class use case — a shared component library, a private
 * package registry backed by a repo — and those all live on the same SCM host, so
 * a host allow-list of exactly one serves them while giving nothing to
 * `evil.example`.
 */
export function authoriseRequest(input: {
	request: CredentialRequest;
	scmHost: string | undefined;
}): CredentialDecision {
	if (input.request.operation !== "get") {
		return {
			kind: "decline",
			reason: "not_a_get",
			message: "Harbor's helper brokers credentials and does not store them; nothing to do.",
		};
	}
	const scmHost = (input.scmHost ?? "").trim().toLowerCase();
	if (scmHost === "") {
		return {
			kind: "decline",
			reason: "scm_host_unconfigured",
			message:
				"HARBOR_SCM_HOST is not set in this sandbox, so no host is authorised. Refusing "
				+ "rather than trusting whatever host git happens to be talking to.",
		};
	}
	const protocol = (input.request.protocol ?? "").toLowerCase();
	if (protocol !== "https") {
		return {
			kind: "decline",
			reason: "insecure_protocol",
			message:
				`Refusing to broker a credential over ${protocol === "" ? "an unspecified protocol" : protocol}. `
				+ "Only https is authorised; anything else puts the token on the wire in the clear.",
		};
	}
	const host = (input.request.host ?? "").trim().toLowerCase();
	if (host === "") {
		return { kind: "decline", reason: "host_missing", message: "The request named no host." };
	}
	// Exact match, and the port is part of it: `github.com` and `github.com:8443`
	// are different endpoints, and a prefix or suffix comparison here is how
	// `github.com.evil.example` gets a token.
	if (host !== scmHost) {
		return {
			kind: "decline",
			reason: "host_not_authorised",
			message:
				`${host} is not this sandbox's SCM host (${scmHost}), so no credential is issued. `
				+ "The installation's reach is limited to one host on purpose.",
		};
	}
	return { kind: "authorise", host };
}

/**
 * The repository a credential request is for, taken from git's `path` field.
 *
 * This is why the supervisor sets `credential.useHttpPath true`. Without it git
 * omits `path` entirely and the broker gets no repository to scope the token to,
 * which forces either a refusal or an installation-wide credential — and an
 * installation-wide credential handed to a clone at boot, before any human is
 * watching, can rewrite every repository the app covers.
 */
export function repoFromPath(path: string | undefined): { owner: string; name: string } | null {
	const segments = (path ?? "").replace(/^\/+/, "").split("/");
	const owner = segments[0];
	const name = segments[1]?.replace(/\.git$/, "");
	if (owner === undefined || owner === "" || name === undefined || name === "") return null;
	return { owner, name };
}

export const GIT_OPERATIONS = ["clone", "fetch", "push"] as const;
export type GitOperation = (typeof GIT_OPERATIONS)[number];

/**
 * Which operation to ask the broker to scope the token to.
 *
 * git's credential protocol carries **no** operation — the same helper invocation
 * serves a clone and a force-push — so this cannot be read off the request and
 * must not be inferred from one. The supervisor therefore states it in the
 * environment of the process it is about to start: `clone` for the boot clone,
 * `push` for an agent turn, which is the only one that legitimately writes.
 *
 * The default when nothing says is `fetch`, the **least privileged** of the three.
 * That is the fail-closed direction and it has a concrete consequence worth
 * accepting: a stray `git push` from a process the supervisor did not label gets a
 * read-only token and fails with a permissions error. That is a clear, one-line
 * fix. The other default — assuming `push` — hands write access to every
 * unattended operation in the box, which fails silently and only once, badly.
 */
export function operationFromEnvironment(value: string | undefined): GitOperation {
	const candidate = (value ?? "").trim().toLowerCase();
	return (GIT_OPERATIONS as readonly string[]).includes(candidate)
		? (candidate as GitOperation)
		: "fetch";
}

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------

export interface BrokeredCredential {
	username: string;
	password: string;
	/** Epoch millis. From the control plane when it says, from the cache window otherwise. */
	expiresAt: number;
}

/**
 * Where the cache lives. Not `/workspace`: that is what the agent reads, what an
 * over-eager `git add -A` commits, and what a filesystem snapshot captures and
 * keeps for the whole snapshot retention window.
 */
export function cachePath(sandboxId: string): string {
	return join(tmpdir(), `harbor-credential-${sandboxId.replace(/[^A-Za-z0-9_-]/g, "")}.json`);
}

/**
 * `key` is host + repository + operation, not just the host.
 *
 * Caching per host would let a read-only token minted for a boot clone be replayed
 * for a push — the cache would hand back the wrong-privilege credential and the
 * push would fail confusingly — and worse, would let a token scoped to one
 * repository be offered for another. The key is the scope.
 */
export function readCache(path: string, key: string, now: number): BrokeredCredential | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		if (parsed.key !== key) return null;
		const expiresAt = typeof parsed.expiresAt === "number" ? parsed.expiresAt : 0;
		if (expiresAt <= now) return null;
		if (typeof parsed.username !== "string" || typeof parsed.password !== "string") return null;
		return { username: parsed.username, password: parsed.password, expiresAt };
	} catch {
		// A missing, truncated or half-written cache is a cache miss. Throwing here
		// would fail a git operation over a file that exists only as an optimisation.
		return null;
	}
}

export function writeCache(path: string, key: string, credential: BrokeredCredential): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		// Written 0600 and then chmodded, because the umask in an image is whatever
		// the base image chose and a world-readable token file in /tmp is a token
		// every process in the box can read.
		writeFileSync(path, JSON.stringify({ key, ...credential }), { encoding: "utf8", mode: 0o600 });
		chmodSync(path, 0o600);
	} catch {
		// A cache we cannot write is slower, not broken.
	}
}

export function clearCache(path: string): void {
	try {
		rmSync(path, { force: true });
	} catch {
		/* nothing to do */
	}
}

// ---------------------------------------------------------------------------
// The broker call
// ---------------------------------------------------------------------------

export interface HelperEnvironment {
	controlUrl: string;
	sandboxId: string;
	sessionId: string;
	token: string;
	/**
	 * The fence, presented on every credential request.
	 *
	 * Authentication alone cannot catch the case fencing exists for: a sandbox whose
	 * lease lapsed still holds a genuine token, and handing that box a push
	 * credential is two agents pushing to one branch. The broker answers 409 for a
	 * stale fence, and this helper treats that as final — see `fetchCredential`.
	 */
	fencingToken: string;
	scmHost: string | undefined;
	traceId: string | undefined;
}

export function readHelperEnvironment(env: NodeJS.ProcessEnv): HelperEnvironment | null {
	const controlUrl = (env.HARBOR_CONTROL_URL ?? "").replace(/\/+$/, "");
	const sandboxId = env.HARBOR_SANDBOX_ID ?? "";
	const sessionId = env.HARBOR_SESSION_ID ?? "";
	const token = env.HARBOR_SANDBOX_TOKEN ?? "";
	const fencingToken = (env.HARBOR_FENCING_TOKEN ?? "").trim();
	// A helper with no fence is a helper every call from which will be refused with
	// a 409. Returning null here makes that one clear line on stderr at the first
	// clone instead of an unexplained authentication failure on every git operation
	// for the life of the box.
	if (controlUrl === "" || sandboxId === "" || token === "" || fencingToken === "") return null;
	return {
		controlUrl,
		sandboxId,
		sessionId,
		token,
		fencingToken,
		scmHost: env.HARBOR_SCM_HOST,
		traceId: env.HARBOR_TRACE_ID,
	};
}

/**
 * Ask the control plane for a credential for one host.
 *
 * The control plane mints it from the GitHub App installation (or equivalent) at
 * the moment of the request, so its own expiry is authoritative. When it does not
 * supply one, the credential is treated as valid for exactly one cache window —
 * never longer, and never "until we are told otherwise", because a helper that
 * assumes an unbounded lifetime for a token it cannot see the expiry of is a
 * helper that keeps using a revoked one.
 */
export async function fetchCredential(
	environment: HelperEnvironment,
	request: { host: string; repo: { owner: string; name: string }; operation: GitOperation },
	fetchImpl: typeof fetch = globalThis.fetch,
): Promise<BrokerResult> {
	const headers: Record<string, string> = {
		authorization: `Bearer ${environment.token}`,
		"content-type": "application/json",
		"x-harbor-fencing-token": environment.fencingToken,
		[correlationHeader("sandbox_id")]: environment.sandboxId,
	};
	if (environment.sessionId !== "") headers[correlationHeader("session_id")] = environment.sessionId;
	if (environment.traceId !== undefined) headers[correlationHeader("trace_id")] = environment.traceId;

	const response = await fetchImpl(
		`${environment.controlUrl}/api/sandbox/${environment.sandboxId}/credentials`,
		{
			method: "POST",
			headers,
			body: JSON.stringify({
				repo: { owner: request.repo.owner, name: request.repo.name, host: request.host, protocol: "https" },
				operation: request.operation,
			}),
		},
	);

	// 403 and 502 are kept apart all the way to the caller because they imply
	// opposite next moves. A refusal is a decision — this repository is not covered
	// by the installation — and retrying it a hundred times helps nobody. A failure
	// is upstream and transient, and giving up on it turns a thirty-second GitHub
	// blip into a session that cannot push. Collapsing them is how a helper ends up
	// either hammering a permanent 403 or abandoning a recoverable outage.
	// 403 is a policy decision about this repository; 409 is a verdict about this
	// box. Both are final and neither should be retried, but they are kept apart
	// because the operator's next move differs: widen the installation, versus
	// accept that this sandbox has been superseded and stop.
	if (response.status === 403) return { kind: "refused" };
	if (response.status === 409) return { kind: "superseded" };
	if (!response.ok) return { kind: "failed", status: response.status };

	const body = (await response.json()) as Record<string, unknown>;
	if (typeof body.username !== "string" || typeof body.password !== "string") {
		return { kind: "failed", status: response.status };
	}
	const expiresAt =
		typeof body.expires_at === "string" ? Date.parse(body.expires_at) : Number.NaN;
	return {
		kind: "minted",
		credential: {
			username: body.username,
			password: body.password,
			expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + setting("credentialCacheMs"),
		},
	};
}

export type BrokerResult =
	| { kind: "minted"; credential: BrokeredCredential }
	| { kind: "refused" }
	| { kind: "superseded" }
	| { kind: "failed"; status: number };

/**
 * Render git's expected reply. An empty string means "I have nothing".
 *
 * Declining is an **empty reply with exit code 0**, never a non-zero exit. That is
 * git's protocol for a helper with no answer: git then falls through to the next
 * helper, or prompts, or fails with its own message naming the host. Exiting
 * non-zero aborts the entire git operation with a message about the helper, which
 * hides the real problem — "this sandbox is not authorised for bitbucket.org" —
 * behind "credential helper failed", and sends whoever is debugging it in exactly
 * the wrong direction.
 */
export function formatCredentialReply(credential: BrokeredCredential | null): string {
	if (credential === null) return "";
	return `username=${credential.username}\npassword=${credential.password}\n\n`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runHelper(
	argv: string[],
	stdin: string,
	env: NodeJS.ProcessEnv,
	fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ stdout: string; note: string | null }> {
	const gitVerb = argv[0] ?? "";
	const request = parseCredentialRequest(stdin, gitVerb);
	const environment = readHelperEnvironment(env);

	if (environment === null) {
		return { stdout: "", note: "credential.sandbox_env_missing" };
	}
	if (gitVerb === "erase") {
		// git calls `erase` when the credential was rejected. Dropping the cache here
		// is what stops a token that was revoked mid-session from being replayed for
		// the rest of its cache window on every subsequent call.
		clearCache(cachePath(environment.sandboxId));
		return { stdout: "", note: "credential.cache_erased" };
	}

	const decision = authoriseRequest({ request, scmHost: environment.scmHost });
	if (decision.kind === "decline") {
		return { stdout: "", note: `credential.declined:${decision.reason} ${decision.message}` };
	}

	const repo = repoFromPath(request.path);
	if (repo === null) {
		return {
			stdout: "",
			note:
				"credential.no_repo_path git did not send a repository path, so the broker has "
				+ "nothing to scope a token to. Check that `credential.useHttpPath` is true.",
		};
	}
	const scope = operationFromEnvironment(env.HARBOR_GIT_OPERATION);

	const path = cachePath(environment.sandboxId);
	const key = `${decision.host}/${repo.owner}/${repo.name}#${scope}`;
	const cached = readCache(path, key, Date.now());
	if (cached !== null) return { stdout: formatCredentialReply(cached), note: "credential.cache_hit" };

	let result: BrokerResult;
	try {
		result = await fetchCredential(environment, { host: decision.host, repo, operation: scope }, fetchImpl);
	} catch {
		// A broker we cannot reach yields no credential and a clear git error, rather
		// than an exception that git reports as "credential helper crashed".
		return { stdout: "", note: "credential.broker_unreachable" };
	}
	if (result.kind === "refused") return { stdout: "", note: "credential.broker_refused" };
	if (result.kind === "superseded") {
		// The fence was rejected: this box's lease lapsed and another agent has
		// legitimately taken the work. Drop the cache so nothing already minted can be
		// replayed for the rest of its window.
		clearCache(path);
		return { stdout: "", note: "credential.fence_superseded" };
	}
	if (result.kind === "failed") {
		return { stdout: "", note: `credential.broker_failed status=${result.status}` };
	}

	// Never cache past the window, even when the control plane says the token lives
	// for an hour: the window is the revocation bound, and honouring a longer expiry
	// would silently widen it.
	const bounded: BrokeredCredential = {
		...result.credential,
		expiresAt: Math.min(result.credential.expiresAt, Date.now() + setting("credentialCacheMs")),
	};
	writeCache(path, key, bounded);
	return { stdout: formatCredentialReply(bounded), note: "credential.brokered" };
}

function readStdin(): string {
	try {
		return readFileSync(0, "utf8");
	} catch {
		return "";
	}
}

if (process.argv[1] !== undefined && process.argv[1].includes("git-credential-helper")) {
	void runHelper(process.argv.slice(2), readStdin(), process.env).then((result) => {
		if (result.note !== null) console.error(`[credential] ${result.note}`);
		process.stdout.write(result.stdout);
		// Always zero. See `formatCredentialReply` for why declining must not be an
		// error exit.
		process.exit(0);
	});
}
