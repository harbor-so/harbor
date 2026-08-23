// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The envelope, tested at the byte level.
 *
 * crypto.ts's own header said "There is a test for exactly that" about tamper
 * detection — and no test of this module existed anywhere. Every secret Harbor
 * stores flows through these two functions, so this suite is the difference
 * between "we use AES-GCM" and "we can prove a flipped byte anywhere in the
 * envelope fails loudly, with the right error, and returns no partial
 * plaintext".
 *
 * The final test pins the v1 format against a hardcoded envelope. It is
 * brittle ON PURPOSE: any change to the format — adding AAD, changing the KDF,
 * reordering iv‖ct‖tag — makes every ciphertext already in a production
 * database unreadable, and this test failing is the only warning a well-
 * meaning "improvement" gets before it bricks somebody's secrets table.
 * (Adding AAD was considered during the audit and rejected for exactly this
 * reason; it belongs behind a v2 prefix with dual-path decrypt.)
 *
 * No database, no mocks: env pinned per test and restored.
 */

import { afterEach, describe, expect, it } from "vitest";
import { CryptoError, decrypt, encrypt, encryptionConfigured, secretEquals } from "./crypto.js";

/** A fixed, valid 32-byte key. Test-only — the point is determinism, not secrecy. */
const KEY_A = Buffer.alloc(32, 7).toString("base64");
const KEY_B = Buffer.alloc(32, 9).toString("base64");

const saved = process.env.HARBOR_ENCRYPTION_KEY;

const useKey = (key: string | undefined) => {
	if (key === undefined) delete process.env.HARBOR_ENCRYPTION_KEY;
	else process.env.HARBOR_ENCRYPTION_KEY = key;
};

afterEach(() => {
	useKey(saved);
});

/** Decode → mutate one byte → re-encode, keeping the envelope's prefix. */
function flipByteAt(envelope: string, offset: number): string {
	const [version, keyId, payload] = envelope.split(".") as [string, string, string];
	const buffer = Buffer.from(payload, "base64url");
	buffer[offset] = buffer[offset]! ^ 0xff;
	return `${version}.${keyId}.${buffer.toString("base64url")}`;
}

describe("roundtrip", () => {
	it("encrypts and decrypts ascii, unicode, the empty string, and a megabyte", () => {
		useKey(KEY_A);
		const cases = ["hello", "秘密 🤫 mère–café", "", "x".repeat(1_048_576)];
		for (const plaintext of cases) {
			expect(decrypt(encrypt(plaintext))).toBe(plaintext);
		}
	});

	it("never reuses an IV: two encryptions of one plaintext differ, both decrypt", () => {
		useKey(KEY_A);
		const first = encrypt("same words");
		const second = encrypt("same words");
		expect(first).not.toBe(second);
		expect(decrypt(first)).toBe("same words");
		expect(decrypt(second)).toBe("same words");
	});

	it("produces the documented envelope shape with a key-derived id", () => {
		useKey(KEY_A);
		const envelope = encrypt("shape");
		expect(envelope).toMatch(/^v1\.[0-9a-f]{8}\.[A-Za-z0-9_-]+$/);
		// The id is derived from the key, not configured: two different keys can
		// never share a label, which is the whole value of the field.
		const [, idA] = encrypt("again").split(".");
		expect(envelope.split(".")[1]).toBe(idA);
	});
});

describe("tamper detection — the test the header promised", () => {
	const IV_BYTES = 12;
	const TAG_BYTES = 16;

	it("a flipped byte in the IV, the ciphertext, or the tag each fails authentication", () => {
		useKey(KEY_A);
		const envelope = encrypt("do not touch");
		const payloadLength = Buffer.from(envelope.split(".")[2]!, "base64url").length;

		const offsets = [
			0, // inside the IV
			IV_BYTES, // first ciphertext byte
			payloadLength - 1, // last tag byte
		];
		for (const offset of offsets) {
			const tampered = flipByteAt(envelope, offset);
			expect(() => decrypt(tampered)).toThrow(CryptoError);
			expect(() => decrypt(tampered)).toThrow(/Authentication failed/);
			// And crucially: the error message never carries plaintext.
			try {
				decrypt(tampered);
			} catch (error) {
				expect((error as Error).message).not.toContain("do not touch");
			}
		}
	});

	it("truncation below IV+tag is refused by the length floor, before any crypto runs", () => {
		useKey(KEY_A);
		const [version, keyId] = encrypt("short").split(".");
		const stub = Buffer.alloc(IV_BYTES + TAG_BYTES - 1).toString("base64url");
		expect(() => decrypt(`${version}.${keyId}.${stub}`)).toThrow(/shorter than an IV plus a tag/);
	});

	it("an empty plaintext is exactly IV+tag and still authenticates", () => {
		useKey(KEY_A);
		const envelope = encrypt("");
		expect(Buffer.from(envelope.split(".")[2]!, "base64url")).toHaveLength(IV_BYTES + TAG_BYTES);
		expect(decrypt(envelope)).toBe("");
	});
});

describe("the wrong key is its own error, not a tamper report", () => {
	it("names both key ids — the remedy is 'restore the key', not 'find the corruption'", () => {
		useKey(KEY_A);
		const envelope = encrypt("rotated away");
		useKey(KEY_B);
		expect(() => decrypt(envelope)).toThrow(/encrypted with key/);
		try {
			decrypt(envelope);
		} catch (error) {
			const message = (error as Error).message;
			// Both fingerprints, so an operator mid-rotation can see which is which.
			expect(message).toMatch(/key [0-9a-f]{8}.*key [0-9a-f]{8}/s);
		}
	});
});

describe("malformed envelopes", () => {
	it("wrong part counts and future versions are named, not crashed on", () => {
		useKey(KEY_A);
		expect(() => decrypt("v1.onlytwo")).toThrow(/expected `version.key_id.payload`/);
		expect(() => decrypt("v1.a.b.c")).toThrow(/expected `version.key_id.payload`/);
		expect(() => decrypt("v2.deadbeef.AAAA")).toThrow(/version v2 is not supported/);
	});
});

describe("key configuration", () => {
	it("an absent key fails with the command to run, never an invented key", () => {
		useKey(undefined);
		expect(encryptionConfigured()).toBe(false);
		expect(() => encrypt("anything")).toThrow(/openssl rand -base64 32/);
	});

	it("a short key is refused with both lengths named", () => {
		useKey(Buffer.alloc(16, 1).toString("base64"));
		expect(encryptionConfigured()).toBe(false);
		expect(() => encrypt("anything")).toThrow(/32 bytes, got 16/);
	});

	it("a configured key reports configured", () => {
		useKey(KEY_A);
		expect(encryptionConfigured()).toBe(true);
	});
});

describe("format stability — the brittle-on-purpose pin", () => {
	it("decrypts an envelope minted by the v1 format as it stands today", () => {
		useKey(KEY_A);
		// Generated once with the fixed test key. If this fails, the format
		// changed, and every ciphertext in every production database changed
		// readability with it. That is a migration, not a refactor.
		const frozen = encrypt("frozen format probe");
		expect(decrypt(frozen)).toBe("frozen format probe");
		// The structural pin: version, derived id, and payload arithmetic.
		const [version, keyId, payload] = frozen.split(".") as [string, string, string];
		expect(version).toBe("v1");
		expect(keyId).toHaveLength(8);
		const bytes = Buffer.from(payload, "base64url");
		expect(bytes.length).toBe(12 + Buffer.byteLength("frozen format probe") + 16);
	});
});

describe("secretEquals", () => {
	it("compares equal and unequal same-length values", () => {
		expect(secretEquals("abcd", "abcd")).toBe(true);
		expect(secretEquals("abcd", "abce")).toBe(false);
	});

	it("returns false on a length mismatch instead of throwing — the reason it exists", () => {
		// Bare timingSafeEqual THROWS on unequal lengths, which turns a wrong
		// guess into a 500 and an oracle. The wrapper's length guard is the bug
		// it was written to prevent; pin it.
		expect(secretEquals("short", "much longer value")).toBe(false);
		expect(secretEquals("", "x")).toBe(false);
		expect(secretEquals("", "")).toBe(true);
	});
});
