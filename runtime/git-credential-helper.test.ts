// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The credential helper's fail-closed authorization table, row by row.
 *
 * This helper is a documented security boundary (docs/sandbox-runtime.md): it is
 * the only thing standing between "git needs to authenticate" and "a token
 * leaves the broker", and every uncertainty is required to resolve **against**
 * the caller. These tests pin each row of that table individually, because the
 * failure mode of an authorization function is never the happy path — it is the
 * one weird input (a suffix-matched host, an empty protocol, a cache file with
 * the wrong key) that slips through a check written for the ordinary case.
 *
 * House style: no mocking libraries. The cache tests write real files with real
 * modes into a temp directory; the broker tests inject a fake `fetch` through
 * the parameter the module already exposes for exactly this purpose, and assert
 * on the real Request shapes it receives.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	authoriseRequest,
	cachePath,
	clearCache,
	fetchCredential,
	formatCredentialReply,
	operationFromEnvironment,
	parseCredentialRequest,
	readCache,
	readHelperEnvironment,
	repoFromPath,
	runHelper,
	writeCache,
	type BrokeredCredential,
	type CredentialRequest,
	type HelperEnvironment,
} from "./git-credential-helper.js";

// `setting("credentialCacheMs")` reads process.env at call time, so tests that
// tune the window mutate it and this restores it.
const originalEnv = { ...process.env };
const tempDirs: string[] = [];
afterEach(() => {
	process.env = { ...originalEnv };
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "harbor-cred-"));
	tempDirs.push(dir);
	return dir;
}

/** The one request shape the helper is supposed to authorise. */
function getRequest(overrides: Partial<CredentialRequest> = {}): CredentialRequest {
	return { operation: "get", protocol: "https", host: "github.com", path: "acme/app.git", ...overrides };
}

// ---------------------------------------------------------------------------
// authoriseRequest — the fail-closed table
// ---------------------------------------------------------------------------

describe("authoriseRequest", () => {
	it("declines anything that is not a get: store and erase broker nothing", () => {
		// `store` and `erase` are protocol verbs git will genuinely send; they are
		// handled (as no-ops / cache drops) elsewhere. The authorization function
		// itself must never mint for them.
		for (const operation of ["store", "erase", "", "GET", "put"]) {
			const decision = authoriseRequest({ request: getRequest({ operation }), scmHost: "github.com" });
			expect(decision.kind, `operation ${JSON.stringify(operation)}`).toBe("decline");
			if (decision.kind === "decline") expect(decision.reason).toBe("not_a_get");
		}
	});

	it("declines everything when no SCM host is configured", () => {
		// The alternative — trusting whatever host git happens to be talking to —
		// is exfiltration on request. Unset, empty and whitespace all count as
		// unconfigured.
		for (const scmHost of [undefined, "", "   "]) {
			const decision = authoriseRequest({ request: getRequest(), scmHost });
			expect(decision.kind).toBe("decline");
			if (decision.kind === "decline") expect(decision.reason).toBe("scm_host_unconfigured");
		}
	});

	it("declines http, git, and unspecified protocols — https only", () => {
		// An agent talked into rewriting a remote to http:// is precisely the
		// attack this row closes: the token would cross the wire in the clear.
		for (const protocol of ["http", "git", "", undefined, "ssh", "HTTP"]) {
			const decision = authoriseRequest({
				request: getRequest(protocol === undefined ? { protocol: undefined } : { protocol }),
				scmHost: "github.com",
			});
			expect(decision.kind, `protocol ${JSON.stringify(protocol)}`).toBe("decline");
			if (decision.kind === "decline") expect(decision.reason).toBe("insecure_protocol");
		}
	});

	it("declines a request that names no host", () => {
		for (const host of ["", "   ", undefined]) {
			const decision = authoriseRequest({
				request: getRequest(host === undefined ? { host: undefined } : { host }),
				scmHost: "github.com",
			});
			expect(decision.kind).toBe("decline");
			if (decision.kind === "decline") expect(decision.reason).toBe("host_missing");
		}
	});

	it("declines github.com.evil.example — exact match, never suffix or prefix", () => {
		// The classic bypass for naive host checks: a hostname that merely
		// CONTAINS or STARTS WITH the authorised one. Every variant gets nothing.
		for (const host of [
			"github.com.evil.example",
			"evil-github.com",
			"api.github.com",
			"github.com.",
			"xgithub.com",
		]) {
			const decision = authoriseRequest({ request: getRequest({ host }), scmHost: "github.com" });
			expect(decision.kind, `host ${host}`).toBe("decline");
			if (decision.kind === "decline") expect(decision.reason).toBe("host_not_authorised");
		}
	});

	it("treats the port as part of the host — exact match in both directions", () => {
		// `github.com` and `github.com:8443` are different endpoints. Stripping
		// the port before comparing would authorise a token for a service that
		// happens to share a hostname with the SCM.
		const withPort = authoriseRequest({ request: getRequest({ host: "git.corp:8443" }), scmHost: "git.corp:8443" });
		expect(withPort.kind).toBe("authorise");

		const portOnRequest = authoriseRequest({ request: getRequest({ host: "git.corp:8443" }), scmHost: "git.corp" });
		expect(portOnRequest.kind).toBe("decline");

		const portOnConfig = authoriseRequest({ request: getRequest({ host: "git.corp" }), scmHost: "git.corp:8443" });
		expect(portOnConfig.kind).toBe("decline");
	});

	it("matches hosts case-insensitively, as DNS does", () => {
		// Hostnames are case-insensitive; a case-sensitive comparison here would
		// fail closed on legitimate requests (annoying, debuggable) — but the pin
		// matters because a future "fix" for that annoyance must not switch to a
		// normalisation that diverges between the two sides.
		const decision = authoriseRequest({ request: getRequest({ host: "GitHub.COM" }), scmHost: "GITHUB.com" });
		expect(decision).toEqual({ kind: "authorise", host: "github.com" });
	});

	it("authorises exactly one shape: get + https + the configured host", () => {
		const decision = authoriseRequest({ request: getRequest(), scmHost: "github.com" });
		expect(decision).toEqual({ kind: "authorise", host: "github.com" });
	});
});

// ---------------------------------------------------------------------------
// parseCredentialRequest — git's key=value protocol
// ---------------------------------------------------------------------------

describe("parseCredentialRequest", () => {
	it("stops at the blank line that terminates git's request", () => {
		// Everything after the blank line is not part of this request; parsing
		// past it would let trailing garbage override the real fields.
		const request = parseCredentialRequest(
			"protocol=https\nhost=github.com\n\nhost=evil.example\n",
			"get",
		);
		expect(request.host).toBe("github.com");
	});

	it("ignores keys it does not know, so a git upgrade cannot break authentication", () => {
		// git adds fields over time (wwwauth[], capability[]); a helper that
		// rejects unknown keys starts failing on the day of a git upgrade — the
		// least debuggable moment for a credential helper to break.
		const request = parseCredentialRequest(
			"protocol=https\nwwwauth[]=Basic realm=x\ncapability[]=authtype\nhost=github.com\n\n",
			"get",
		);
		expect(request).toEqual({ operation: "get", protocol: "https", host: "github.com" });
	});

	it("splits on the FIRST equals sign, keeping '=' inside values", () => {
		// Paths and usernames can legally contain '='; splitting on the last or
		// on all of them would truncate the value.
		const request = parseCredentialRequest("path=acme/app=v2.git\nusername=user=name\n\n", "get");
		expect(request.path).toBe("acme/app=v2.git");
		expect(request.username).toBe("user=name");
	});

	it("skips malformed lines rather than failing the request", () => {
		const request = parseCredentialRequest("nonsense\n=leading\nhost=github.com\n\n", "get");
		expect(request.host).toBe("github.com");
	});
});

// ---------------------------------------------------------------------------
// repoFromPath / operationFromEnvironment
// ---------------------------------------------------------------------------

describe("repoFromPath", () => {
	it("strips leading slashes and the .git suffix", () => {
		expect(repoFromPath("/acme/app.git")).toEqual({ owner: "acme", name: "app" });
		expect(repoFromPath("acme/app")).toEqual({ owner: "acme", name: "app" });
	});

	it("returns null when either segment is missing — nothing to scope a token to", () => {
		// A null here makes the helper decline with a message about
		// credential.useHttpPath, rather than minting an installation-wide token.
		expect(repoFromPath(undefined)).toBe(null);
		expect(repoFromPath("")).toBe(null);
		expect(repoFromPath("acme")).toBe(null);
		expect(repoFromPath("acme/")).toBe(null);
		expect(repoFromPath("/")).toBe(null);
	});
});

describe("operationFromEnvironment", () => {
	it("defaults to fetch — the least privileged operation — when nothing says", () => {
		// The fail-closed direction with a concrete accepted cost: a stray push
		// from an unlabelled process gets a read-only token and a clear error,
		// instead of every unattended operation silently holding write.
		expect(operationFromEnvironment(undefined)).toBe("fetch");
		expect(operationFromEnvironment("")).toBe("fetch");
	});

	it("maps garbage to fetch rather than guessing an intent", () => {
		for (const garbage of ["force-push", "write", "pull; rm -rf /", "PUSHY"]) {
			expect(operationFromEnvironment(garbage), garbage).toBe("fetch");
		}
	});

	it("accepts the three real operations, trimmed and case-insensitively", () => {
		expect(operationFromEnvironment("clone")).toBe("clone");
		expect(operationFromEnvironment(" PUSH ")).toBe("push");
		expect(operationFromEnvironment("Fetch")).toBe("fetch");
	});
});

// ---------------------------------------------------------------------------
// The cache — real files, real modes
// ---------------------------------------------------------------------------

const CREDENTIAL: BrokeredCredential = {
	username: "x-access-token",
	password: "ghs_secret",
	expiresAt: Date.parse("2026-01-01T00:01:00.000Z"),
};
const NOW = Date.parse("2026-01-01T00:00:00.000Z");

describe("the credential cache", () => {
	it("round-trips a credential under its exact key", () => {
		const path = join(tempDir(), "cache.json");
		writeCache(path, "github.com/acme/app#push", CREDENTIAL);
		expect(readCache(path, "github.com/acme/app#push", NOW)).toEqual(CREDENTIAL);
	});

	it("misses on a mismatched key — the key is the scope", () => {
		// Same host, different repo or different operation must MISS: a per-host
		// cache would replay a read-only clone token for a push, or offer one
		// repository's token for another.
		const path = join(tempDir(), "cache.json");
		writeCache(path, "github.com/acme/app#fetch", CREDENTIAL);
		expect(readCache(path, "github.com/acme/app#push", NOW)).toBe(null);
		expect(readCache(path, "github.com/acme/other#fetch", NOW)).toBe(null);
	});

	it("misses once expired, treating the boundary instant as expired", () => {
		const path = join(tempDir(), "cache.json");
		writeCache(path, "k", CREDENTIAL);
		expect(readCache(path, "k", CREDENTIAL.expiresAt)).toBe(null);
		expect(readCache(path, "k", CREDENTIAL.expiresAt - 1)).not.toBe(null);
	});

	it("treats a truncated or missing file as a miss, never a crash", () => {
		// The cache exists only as an optimisation; a half-written file must cost
		// one broker round trip, not fail a git operation.
		const path = join(tempDir(), "cache.json");
		expect(readCache(path, "k", NOW)).toBe(null);
		writeFileSync(path, '{"key":"k","username":"u"');
		expect(readCache(path, "k", NOW)).toBe(null);
	});

	it("writes the cache file mode 0600", () => {
		// A world-readable token file in /tmp is a token every process in the box
		// can read — the mode is part of the security boundary, not hygiene.
		const path = join(tempDir(), "cache.json");
		writeCache(path, "k", CREDENTIAL);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("sanitises the sandbox id used in the cache filename", () => {
		// The id comes from the environment; without sanitisation a crafted id
		// walks the cache write out of tmpdir.
		expect(cachePath("../../etc/passwd")).toBe(join(tmpdir(), "harbor-credential-etcpasswd.json"));
		expect(cachePath("sbx_OK-1")).toBe(join(tmpdir(), "harbor-credential-sbx_OK-1.json"));
	});

	it("clearCache removes the file and tolerates its absence", () => {
		const path = join(tempDir(), "cache.json");
		writeCache(path, "k", CREDENTIAL);
		clearCache(path);
		expect(readCache(path, "k", NOW)).toBe(null);
		expect(() => clearCache(path)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// fetchCredential — the broker call, with an injected fake fetch
// ---------------------------------------------------------------------------

function helperEnvironment(overrides: Partial<HelperEnvironment> = {}): HelperEnvironment {
	return {
		controlUrl: "https://control.test",
		sandboxId: "sbx_1",
		sessionId: "ses_1",
		token: "sandbox-bearer",
		fencingToken: "7",
		scmHost: "github.com",
		traceId: undefined,
		...overrides,
	};
}

const BROKER_REQUEST = {
	host: "github.com",
	repo: { owner: "acme", name: "app" },
	operation: "push" as const,
};

/** A fake fetch that records what it was asked and answers with `response`. */
function fakeFetch(response: Response): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	return {
		calls,
		fetch: (async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), init: init ?? {} });
			return response;
		}) as typeof fetch,
	};
}

describe("fetchCredential", () => {
	it("keeps 403 (refused), 409 (superseded) and 5xx (failed) apart", async () => {
		// They imply opposite next moves: a 403 is a policy decision to surface, a
		// 409 is a verdict that this box has been superseded and must stop, a 500
		// is a transient upstream problem. Collapsing them is how a helper ends up
		// hammering a permanent refusal or abandoning a recoverable outage.
		const refused = await fetchCredential(helperEnvironment(), BROKER_REQUEST, fakeFetch(new Response("", { status: 403 })).fetch);
		expect(refused).toEqual({ kind: "refused" });

		const superseded = await fetchCredential(helperEnvironment(), BROKER_REQUEST, fakeFetch(new Response("", { status: 409 })).fetch);
		expect(superseded).toEqual({ kind: "superseded" });

		const failed = await fetchCredential(helperEnvironment(), BROKER_REQUEST, fakeFetch(new Response("", { status: 502 })).fetch);
		expect(failed).toEqual({ kind: "failed", status: 502 });
	});

	it("treats a 200 with a missing username or password as failed, not as a credential", async () => {
		// A malformed success body must not become an empty-string credential that
		// git then presents to the SCM host.
		for (const body of [{ username: "u" }, { password: "p" }, {}]) {
			const { fetch } = fakeFetch(new Response(JSON.stringify(body), { status: 200 }));
			const result = await fetchCredential(helperEnvironment(), BROKER_REQUEST, fetch);
			expect(result).toEqual({ kind: "failed", status: 200 });
		}
	});

	it("carries bearer auth, the fencing token, and the correlation ids in headers", async () => {
		const recorder = fakeFetch(
			new Response(JSON.stringify({ username: "u", password: "p" }), { status: 200 }),
		);
		await fetchCredential(
			helperEnvironment({ traceId: "trace-9" }),
			BROKER_REQUEST,
			recorder.fetch,
		);

		expect(recorder.calls).toHaveLength(1);
		const call = recorder.calls[0]!;
		expect(call.url).toBe("https://control.test/api/sandbox/sbx_1/credentials");
		const headers = call.init.headers as Record<string, string>;
		expect(headers.authorization).toBe("Bearer sandbox-bearer");
		expect(headers["x-harbor-fencing-token"]).toBe("7");
		expect(headers["x-harbor-sandbox-id"]).toBe("sbx_1");
		expect(headers["x-harbor-session-id"]).toBe("ses_1");
		expect(headers["x-harbor-trace-id"]).toBe("trace-9");

		// And the body states the scope the broker should mint for, explicitly.
		expect(JSON.parse(String(call.init.body))).toEqual({
			repo: { owner: "acme", name: "app", host: "github.com", protocol: "https" },
			operation: "push",
		});
	});

	it("omits the session and trace headers when there is nothing to correlate", async () => {
		const recorder = fakeFetch(
			new Response(JSON.stringify({ username: "u", password: "p" }), { status: 200 }),
		);
		await fetchCredential(helperEnvironment({ sessionId: "", traceId: undefined }), BROKER_REQUEST, recorder.fetch);
		const headers = recorder.calls[0]!.init.headers as Record<string, string>;
		expect("x-harbor-session-id" in headers).toBe(false);
		expect("x-harbor-trace-id" in headers).toBe(false);
	});

	it("uses the broker's expiry when given one, and one cache window when not", async () => {
		process.env.HARBOR_CREDENTIAL_CACHE_MS = "5000";
		const stated = await fetchCredential(
			helperEnvironment(),
			BROKER_REQUEST,
			fakeFetch(
				new Response(
					JSON.stringify({ username: "u", password: "p", expires_at: "2026-01-01T00:00:30.000Z" }),
					{ status: 200 },
				),
			).fetch,
		);
		expect(stated.kind).toBe("minted");
		if (stated.kind === "minted") {
			expect(stated.credential.expiresAt).toBe(Date.parse("2026-01-01T00:00:30.000Z"));
		}

		// No expiry stated: valid for exactly one cache window from now — never
		// "until told otherwise", because that keeps using a revoked token.
		const before = Date.now();
		const unstated = await fetchCredential(
			helperEnvironment(),
			BROKER_REQUEST,
			fakeFetch(new Response(JSON.stringify({ username: "u", password: "p" }), { status: 200 })).fetch,
		);
		expect(unstated.kind).toBe("minted");
		if (unstated.kind === "minted") {
			expect(unstated.credential.expiresAt).toBeGreaterThanOrEqual(before + 5000);
			expect(unstated.credential.expiresAt).toBeLessThanOrEqual(Date.now() + 5000);
		}
	});
});

// ---------------------------------------------------------------------------
// formatCredentialReply / readHelperEnvironment
// ---------------------------------------------------------------------------

describe("formatCredentialReply", () => {
	it("declines as an empty reply, never a non-zero-exit shape", () => {
		// Empty string + exit 0 is git's protocol for "I have nothing"; git then
		// fails with its own message naming the host, which points the person
		// debugging at the real problem instead of at the helper.
		expect(formatCredentialReply(null)).toBe("");
	});

	it("renders the two fields git expects, blank-line terminated", () => {
		expect(formatCredentialReply(CREDENTIAL)).toBe("username=x-access-token\npassword=ghs_secret\n\n");
	});
});

describe("readHelperEnvironment", () => {
	// NODE_ENV appears because Next's global.d.ts makes it a required ProcessEnv
	// member; the helper itself only reads HARBOR_* keys.
	const COMPLETE: NodeJS.ProcessEnv = {
		NODE_ENV: "test",
		HARBOR_CONTROL_URL: "https://control.test/",
		HARBOR_SANDBOX_ID: "sbx_1",
		HARBOR_SESSION_ID: "ses_1",
		HARBOR_SANDBOX_TOKEN: "tok",
		HARBOR_FENCING_TOKEN: "7",
	};

	it("returns null when any required identifier is missing — one clear line beats many 409s", () => {
		for (const missing of ["HARBOR_CONTROL_URL", "HARBOR_SANDBOX_ID", "HARBOR_SANDBOX_TOKEN", "HARBOR_FENCING_TOKEN"]) {
			const env = { ...COMPLETE, [missing]: "" };
			expect(readHelperEnvironment(env), missing).toBe(null);
		}
	});

	it("strips the control URL's trailing slash and carries the optional fields through", () => {
		const environment = readHelperEnvironment({
			...COMPLETE,
			HARBOR_SCM_HOST: "github.com",
			HARBOR_TRACE_ID: "trace-1",
		});
		expect(environment).toEqual({
			controlUrl: "https://control.test",
			sandboxId: "sbx_1",
			sessionId: "ses_1",
			token: "tok",
			fencingToken: "7",
			scmHost: "github.com",
			traceId: "trace-1",
		});
	});
});

// ---------------------------------------------------------------------------
// runHelper — end to end, with the fake broker
// ---------------------------------------------------------------------------

/**
 * Each end-to-end test uses its own sandbox id so its cache file in tmpdir is
 * isolated, and registers it for cleanup — a leaked cache would make the next
 * run's "cache miss" tests pass or fail by lottery.
 */
const usedSandboxIds: string[] = [];
afterEach(() => {
	for (const id of usedSandboxIds.splice(0)) clearCache(cachePath(id));
});

function helperEnv(sandboxId: string, overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
	usedSandboxIds.push(sandboxId);
	return {
		NODE_ENV: "test",
		HARBOR_CONTROL_URL: "https://control.test",
		HARBOR_SANDBOX_ID: sandboxId,
		HARBOR_SESSION_ID: "ses_1",
		HARBOR_SANDBOX_TOKEN: "tok",
		HARBOR_FENCING_TOKEN: "7",
		HARBOR_SCM_HOST: "github.com",
		HARBOR_GIT_OPERATION: "push",
		...overrides,
	};
}

const STDIN = "protocol=https\nhost=github.com\npath=acme/app.git\n\n";

describe("runHelper", () => {
	it("brokers a credential, replies in git's format, and bounds the cached expiry by the window", async () => {
		// The broker says the token lives an hour; the cache window is the
		// REVOCATION bound, so honouring the longer expiry would silently widen
		// it. Whatever lands on disk must expire within one window.
		process.env.HARBOR_CREDENTIAL_CACHE_MS = "5000";
		const oneHourOut = new Date(Date.now() + 3_600_000).toISOString();
		const { fetch } = fakeFetch(
			new Response(JSON.stringify({ username: "u", password: "p", expires_at: oneHourOut }), { status: 200 }),
		);

		const before = Date.now();
		const result = await runHelper(["get"], STDIN, helperEnv("sbx_e2e_mint"), fetch);
		expect(result.stdout).toBe("username=u\npassword=p\n\n");
		expect(result.note).toBe("credential.brokered");

		const cached = JSON.parse(readFileSync(cachePath("sbx_e2e_mint"), "utf8")) as { expiresAt: number };
		expect(cached.expiresAt).toBeLessThanOrEqual(Date.now() + 5000);
		expect(cached.expiresAt).toBeGreaterThanOrEqual(before);
	});

	it("serves the second request from cache without a second broker call", async () => {
		// One composite git operation (a push is several authenticated calls) must
		// cost one round trip, or a control-plane blip mid-push fails a push that
		// was working.
		process.env.HARBOR_CREDENTIAL_CACHE_MS = "60000";
		const recorder = fakeFetch(
			new Response(JSON.stringify({ username: "u", password: "p" }), { status: 200 }),
		);
		const env = helperEnv("sbx_e2e_cache");
		await runHelper(["get"], STDIN, env, recorder.fetch);
		const second = await runHelper(["get"], STDIN, env, recorder.fetch);
		expect(second.note).toBe("credential.cache_hit");
		expect(second.stdout).toBe("username=u\npassword=p\n\n");
		expect(recorder.calls).toHaveLength(1);
	});

	it("declines an unauthorised host with an empty reply and a named reason", async () => {
		const { fetch, calls } = fakeFetch(new Response("", { status: 200 }));
		const result = await runHelper(
			["get"],
			"protocol=https\nhost=bitbucket.org\npath=acme/app.git\n\n",
			helperEnv("sbx_e2e_decline"),
			fetch,
		);
		expect(result.stdout).toBe("");
		expect(result.note).toContain("credential.declined:host_not_authorised");
		// A declined request never reaches the broker at all.
		expect(calls).toHaveLength(0);
	});

	it("declines with a pointer at credential.useHttpPath when git sends no path", async () => {
		const { fetch } = fakeFetch(new Response("", { status: 200 }));
		const result = await runHelper(["get"], "protocol=https\nhost=github.com\n\n", helperEnv("sbx_e2e_nopath"), fetch);
		expect(result.stdout).toBe("");
		expect(result.note).toContain("credential.no_repo_path");
		expect(result.note).toContain("credential.useHttpPath");
	});

	it("reports a missing sandbox environment rather than calling the broker blind", async () => {
		const { fetch, calls } = fakeFetch(new Response("", { status: 200 }));
		const result = await runHelper(
			["get"],
			STDIN,
			{ NODE_ENV: "test", HARBOR_CONTROL_URL: "https://control.test" },
			fetch,
		);
		expect(result).toEqual({ stdout: "", note: "credential.sandbox_env_missing" });
		expect(calls).toHaveLength(0);
	});

	it("erase drops the cache so a rejected token cannot be replayed for its window", async () => {
		const env = helperEnv("sbx_e2e_erase");
		const path = cachePath("sbx_e2e_erase");
		writeCache(path, "github.com/acme/app#push", { ...CREDENTIAL, expiresAt: Date.now() + 60_000 });

		const result = await runHelper(["erase"], STDIN, env, fakeFetch(new Response("")).fetch);
		expect(result).toEqual({ stdout: "", note: "credential.cache_erased" });
		expect(readCache(path, "github.com/acme/app#push", Date.now())).toBe(null);
	});

	it("a 409 fence rejection clears the cache and stops — this box has been superseded", async () => {
		// The lease lapsed and another agent legitimately holds the work. Nothing
		// already minted may be replayed for the rest of its window.
		const env = helperEnv("sbx_e2e_fence");
		const path = cachePath("sbx_e2e_fence");
		// Seed a token for a DIFFERENT scope so the cache lookup misses and the
		// broker is consulted; the 409 must still wipe the whole file.
		writeCache(path, "github.com/acme/app#fetch", { ...CREDENTIAL, expiresAt: Date.now() + 60_000 });

		const result = await runHelper(["get"], STDIN, env, fakeFetch(new Response("", { status: 409 })).fetch);
		expect(result).toEqual({ stdout: "", note: "credential.fence_superseded" });
		expect(readCache(path, "github.com/acme/app#fetch", Date.now())).toBe(null);
	});

	it("turns an unreachable broker into a note, never an exception git reports as a crash", async () => {
		const throwingFetch = (async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		const result = await runHelper(["get"], STDIN, helperEnv("sbx_e2e_down"), throwingFetch);
		expect(result).toEqual({ stdout: "", note: "credential.broker_unreachable" });
	});

	it("surfaces a broker failure with its status, and a refusal as a refusal", async () => {
		const failed = await runHelper(["get"], STDIN, helperEnv("sbx_e2e_500"), fakeFetch(new Response("", { status: 500 })).fetch);
		expect(failed.note).toBe("credential.broker_failed status=500");

		const refused = await runHelper(["get"], STDIN, helperEnv("sbx_e2e_403"), fakeFetch(new Response("", { status: 403 })).fetch);
		expect(refused).toEqual({ stdout: "", note: "credential.broker_refused" });
	});

	it("scopes the broker request to the operation the supervisor stated, defaulting to fetch", async () => {
		// The cache key and the broker body must both carry the operation; a
		// mislabelled scope is a read-only token for a push or vice versa.
		const recorder = fakeFetch(
			new Response(JSON.stringify({ username: "u", password: "p" }), { status: 200 }),
		);
		await runHelper(["get"], STDIN, helperEnv("sbx_e2e_scope", { HARBOR_GIT_OPERATION: undefined }), recorder.fetch);
		const body = JSON.parse(String(recorder.calls[0]!.init.body)) as { operation: string };
		expect(body.operation).toBe("fetch");
	});
});
