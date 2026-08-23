// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The encryption envelope. AES-256-GCM, and nothing hand-rolled.
 *
 * Every secret Harbor stores — repository secrets injected into a sandbox, a
 * user's source-control token, connector OAuth credentials — goes through these
 * two functions and no others.
 *
 * ## The envelope format, and the field that is here before it is needed
 *
 *     v1.<key_id>.<base64url(iv ‖ ciphertext ‖ tag)>
 *
 * `key_id` is present from the first migration even though key rotation is not
 * implemented and is not on the roadmap. It costs one short string per row now.
 * Retrofitting it later costs a migration of every secret and token in the
 * system, and worse, that migration can only be performed by decrypting
 * everything with the key you are trying to retire — which is to say, at the
 * exact moment you most want to rotate (a suspected compromise), the format
 * forces you to load the suspect key into memory and touch every row with it.
 *
 * A ciphertext that cannot name its own key is a ciphertext that cannot be
 * rotated incrementally. The field is trivial now and impossible later, so it is
 * now.
 *
 * `v1` is the same argument applied to the algorithm.
 *
 * ## Choices
 *
 * A fresh random 96-bit IV per encryption, prepended. 96 bits is GCM's native
 * nonce size — anything else makes the implementation derive one, which is a
 * different code path with different properties. Random rather than a counter
 * because a counter needs durable state that survives a restart, and an IV reused
 * under one key in GCM does not degrade gracefully: it leaks the XOR of the two
 * plaintexts and, worse, allows forgery of the authentication tag.
 *
 * GCM rather than CBC because the tag means a corrupted or tampered ciphertext
 * fails loudly at decrypt. There is a test for exactly that, because "we use
 * AES" with an unauthenticated mode is how a ciphertext-manipulation bug hides.
 */

import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export class CryptoError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CryptoError";
	}
}

/**
 * The active key and its id.
 *
 * `HARBOR_ENCRYPTION_KEY` is 32 bytes, base64. There is deliberately no
 * development fallback and no generate-one-if-missing: a key that Harbor invented
 * on boot is a key that changes on the next boot, and every secret in the
 * database becomes permanently unreadable with no error until somebody tries to
 * start a session. Failing at startup with a command to run is the kinder
 * failure by a wide margin.
 *
 * The id is derived from the key rather than configured separately, so an
 * operator cannot label two different keys with the same id — which would defeat
 * the entire purpose of having the field.
 */
function activeKey(): { id: string; key: Buffer } {
	const raw = process.env.HARBOR_ENCRYPTION_KEY?.trim();
	if (!raw) {
		throw new CryptoError(
			"HARBOR_ENCRYPTION_KEY is not set. Generate one with:\n"
				+ "  openssl rand -base64 32\n"
				+ "Harbor will not invent a key: one generated at boot changes on the next boot, "
				+ "and every secret already stored becomes silently unreadable.",
		);
	}

	const key = Buffer.from(raw, "base64");
	if (key.length !== KEY_BYTES) {
		throw new CryptoError(
			`HARBOR_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}. `
				+ "Generate one with: openssl rand -base64 32",
		);
	}

	// A short, stable fingerprint. Not a secret — it identifies which key was
	// used, which is exactly what an attacker already learns from the envelope.
	const id = createHash("sha256").update(key).digest("hex").slice(0, 8);

	return { id, key };
}

/** True when a key is configured. Used to fail fast at startup rather than at use. */
export function encryptionConfigured(): boolean {
	try {
		activeKey();
		return true;
	} catch {
		return false;
	}
}

export function encrypt(plaintext: string): string {
	const { id, key } = activeKey();
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	return `${VERSION}.${id}.${Buffer.concat([iv, body, tag]).toString("base64url")}`;
}

export function decrypt(envelope: string): string {
	const parts = envelope.split(".");
	if (parts.length !== 3) {
		throw new CryptoError("Malformed envelope: expected `version.key_id.payload`.");
	}
	const [version, keyId, payload] = parts as [string, string, string];

	if (version !== VERSION) {
		throw new CryptoError(
			`Envelope version ${version} is not supported by this build (expected ${VERSION}).`,
		);
	}

	const { id, key } = activeKey();
	if (keyId !== id) {
		// Named explicitly rather than folded into a generic decryption failure.
		// "The tag did not verify" and "this was encrypted with a different key"
		// have completely different remedies, and an operator who has just rotated
		// a key needs to be told which one they are looking at.
		throw new CryptoError(
			`This value was encrypted with key ${keyId}, but HARBOR_ENCRYPTION_KEY is key ${id}. `
				+ "Restore the original key to read it. Harbor does not support decrypting with "
				+ "multiple keys yet, but the envelope records which key was used so that "
				+ "incremental rotation is possible without re-encrypting everything at once.",
		);
	}

	const buffer = Buffer.from(payload, "base64url");
	if (buffer.length < IV_BYTES + TAG_BYTES) {
		throw new CryptoError("Malformed envelope: payload is shorter than an IV plus a tag.");
	}

	const iv = buffer.subarray(0, IV_BYTES);
	const tag = buffer.subarray(buffer.length - TAG_BYTES);
	const body = buffer.subarray(IV_BYTES, buffer.length - TAG_BYTES);

	const decipher = createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAuthTag(tag);
	try {
		return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
	} catch {
		// `final()` throws when the tag does not verify. That is the authenticated
		// part of authenticated encryption doing its job, and the message says so
		// rather than reporting a generic failure that reads like a bug in Harbor.
		throw new CryptoError(
			"Authentication failed: this ciphertext was modified, truncated, or is not "
				+ "Harbor's. It has not been decrypted and no partial plaintext was returned.",
		);
	}
}

/**
 * Constant-time comparison for anything derived from a secret.
 *
 * Exported here rather than reimplemented at three call sites, because the
 * length check in front of `timingSafeEqual` is easy to forget and the function
 * throws on a length mismatch rather than returning false.
 */
export function secretEquals(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}
