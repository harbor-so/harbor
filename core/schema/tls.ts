// SPDX-License-Identifier: Apache-2.0
/**
 * What `DATABASE_URL` actually asks for, and what that actually gets you.
 *
 * Two properties of hosted Postgres are non-obvious, both silent when wrong, and
 * one of them is a security hole that Harbor's own deployment guide recommended.
 *
 * ## 1. `sslmode=require` is encrypted but NOT authenticated
 *
 * postgres.js maps the DSN's `sslmode` straight onto its `ssl` option, and then:
 *
 *     if (ssl === 'require' || ssl === 'allow' || ssl === 'prefer')
 *       options.rejectUnauthorized = false
 *
 * So `?sslmode=require` — the string every hosted-Postgres quickstart prints, and
 * the one this repo's DEPLOY.md recommended until this file was written — gets a
 * TLS session with certificate verification switched OFF. Anyone who can answer
 * for that hostname can present a self-signed certificate and read and rewrite
 * every row in transit, including the ciphertext of every encrypted secret and
 * the plaintext of everything else. It is `sslmode=verify-full` that falls
 * through to Node's TLS defaults and actually verifies the chain and hostname.
 *
 * The name is the trap: `require` sounds stricter than it is. It requires
 * *encryption*, not *identity*, which is the half that stops an attacker.
 *
 * ## 2. A transaction pooler breaks Harbor specifically
 *
 * Harbor's realtime substrate is `LISTEN/NOTIFY` and its mutual exclusion is
 * `pg_try_advisory_lock`. Both are *session* state. Put a transaction pooler in
 * front — Supabase's port 6543, PgBouncer in its default mode, RDS Proxy — and
 * both stop working while every individual query keeps succeeding. The dashboard
 * loads, the API answers, and the live updates simply never arrive. Nothing logs
 * an error, because from Postgres's point of view nothing went wrong.
 *
 * ## Why this warns rather than fixes
 *
 * It would be easy to rewrite `require` to `verify-full` on the way past. That
 * would break the deployments that legitimately need `require`: RDS with the
 * regional CA bundle, and any self-hoster with a private CA, both of which verify
 * through `NODE_EXTRA_CA_CERTS` rather than Node's bundled roots. It would also
 * violate the invariant `src/db/index.ts` exists to keep — that `DATABASE_URL` is
 * the only thing that decides how Harbor connects. So this module is a pure
 * function that describes, and the caller decides what to say about it.
 */

export type DatabaseTlsMode =
	| "disabled"
	| "require"
	| "verify-ca"
	| "verify-full"
	| "prefer"
	| "allow"
	| "unknown";

export interface DatabaseTlsReport {
	/** The `sslmode` the DSN asked for; `disabled` when it named none. */
	mode: DatabaseTlsMode;
	/** Whether the connection will be TLS at all. */
	encrypted: boolean;
	/** Whether the server's certificate will actually be checked. */
	verified: boolean;
	/** True for localhost / 127.0.0.1 / a unix socket, where plaintext is fine. */
	loopback: boolean;
	/** Human-readable problems, most severe first. Empty when there is nothing to say. */
	warnings: string[];
}

/** postgres.js treats these three as "encrypt, do not verify". */
const UNVERIFIED_MODES = new Set(["require", "allow", "prefer"]);

function isLoopbackHost(host: string): boolean {
	const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
	return bare === "localhost" || bare === "127.0.0.1" || bare === "::1" || bare === "";
}

/**
 * Describe the TLS and pooling posture of a Postgres DSN.
 *
 * Pure: a string in, a struct out. No connection is opened, which is what lets
 * this run at startup on a deployment whose database is not up yet, and lets it
 * be tested exhaustively with no database at all.
 */
export function describeDatabaseTls(url: string): DatabaseTlsReport {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return {
			mode: "unknown",
			encrypted: false,
			verified: false,
			loopback: false,
			warnings: ["DATABASE_URL is not a parseable URL."],
		};
	}

	const params = parsed.searchParams;
	const raw = params.get("sslmode")?.trim().toLowerCase();
	// `sslrootcert=system` is postgres.js's alias for full verification against
	// Node's bundled CA store, and it wins over whatever `sslmode` said.
	const systemRoots = params.get("sslrootcert")?.trim().toLowerCase() === "system";

	const mode: DatabaseTlsMode = systemRoots
		? "verify-full"
		: raw === undefined
			? "disabled"
			: (["require", "verify-ca", "verify-full", "prefer", "allow", "disable"].includes(raw)
				? (raw === "disable" ? "disabled" : (raw as DatabaseTlsMode))
				: "unknown");

	const encrypted = mode !== "disabled" && mode !== "unknown";
	const verified = mode === "verify-full" || mode === "verify-ca";
	const loopback = isLoopbackHost(parsed.hostname);

	const warnings: string[] = [];

	if (!loopback && !encrypted) {
		warnings.push(
			`DATABASE_URL points at ${parsed.hostname} with no sslmode, so the connection is `
				+ "PLAINTEXT. Every row, including the ciphertext of your encrypted secrets, "
				+ "crosses the network unprotected. Add ?sslmode=verify-full.",
		);
	} else if (!loopback && encrypted && !verified) {
		warnings.push(
			`DATABASE_URL uses sslmode=${mode}, which encrypts the connection but does NOT `
				+ "verify the server's certificate — postgres.js sets rejectUnauthorized=false "
				+ "for that mode. Anyone able to answer for "
				+ `${parsed.hostname} can read and rewrite your traffic. Prefer `
				+ "?sslmode=verify-full, and set NODE_EXTRA_CA_CERTS if your provider uses a "
				+ "private CA (AWS RDS does).",
		);
	}

	if (isTransactionPooler(parsed)) {
		warnings.push(
			`DATABASE_URL looks like a TRANSACTION pooler (${parsed.hostname}:${parsed.port || "5432"}). `
				+ "Harbor needs session-scoped state — LISTEN/NOTIFY for live updates and "
				+ "pg_try_advisory_lock for the schedulers — and a transaction pooler breaks both "
				+ "SILENTLY: queries keep working, the dashboard just stops updating and sweeps "
				+ "stop running. Use the direct connection, or a session-pooled one.",
		);
	}

	return { mode, encrypted, verified, loopback, warnings };
}

/**
 * A hostname/port heuristic, which is normally a poor way to make a decision.
 *
 * Justified here only because the failure it catches is invisible. There is no
 * query that asks "am I behind a transaction pooler" — `LISTEN` succeeds, it just
 * never delivers — so the alternative to guessing from the DSN is finding out
 * from a user reporting that the dashboard has been frozen for a week.
 */
function isTransactionPooler(parsed: URL): boolean {
	if (parsed.port === "6543") return true;
	if (/\.pooler\.supabase\.com$/i.test(parsed.hostname)) return true;
	const pgbouncer = parsed.searchParams.get("pgbouncer")?.trim().toLowerCase();
	return pgbouncer === "true" || pgbouncer === "1";
}
