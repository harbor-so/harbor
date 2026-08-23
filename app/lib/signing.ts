// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Signed events: the one primitive the whole chat model is built on.
 *
 * The bet: every message is a cryptographically signed event, and identity IS a
 * public key. One primitive then gives attribution, integrity, an audit trail,
 * and a single identity model for humans and agents — because a human and an
 * agent are both just a keypair, and the room never has to tell them apart.
 *
 * Two choices inside that bet are worth stating, because the conventional
 * alternatives are both defensible:
 *
 *   1. Ed25519, not secp256k1 Schnorr. Ed25519 is in WebCrypto natively, so the
 *      exact same module signs in a browser tab and verifies on the server with
 *      no dependency and no second implementation to drift. A curve that is not
 *      in WebCrypto forces a library into both halves.
 *
 *   2. The `kind` is a closed TypeScript union, not a magic integer. Kind
 *      integers are a global namespace with no compile-time coupling to
 *      behaviour: nothing catches two features claiming the same number, and
 *      nothing tells you which handler runs. A string union an exhaustive switch
 *      can check gives up federation Harbor does not want, and buys back a
 *      compiler error.
 *
 * The event id is a hash of the canonical serialization and is verified
 * INDEPENDENTLY of the signature (see `verifyEvent`). The signature proves the
 * author signed *some* payload; the id check proves it is *this* payload. Skipping
 * the second step is the subtle bug that lets a signed event be replayed with its
 * body swapped — and it is subtle because every signature check still passes.
 *
 * This module has no Node imports and touches only `globalThis.crypto.subtle`, so
 * it is safe to import from a React client component and from server code alike.
 */

/**
 * The closed set of event kinds.
 *
 * Durable kinds are appended to the channel's ordered log; ephemeral kinds fan
 * out to live listeners and are never stored (see `isEphemeral`). Adding a
 * capability is adding a member here and a branch that handles it — the compiler
 * then finds every place that must learn about it.
 */
export const EVENT_KINDS = [
	"message",
	"reaction",
	"join",
	"leave",
	"system",
	"channel_create",
	"typing",
	"presence",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** Kinds that fan out to live listeners but are never persisted. */
const EPHEMERAL_KINDS = new Set<EventKind>(["typing", "presence"]);

export function isEphemeral(kind: EventKind): boolean {
	return EPHEMERAL_KINDS.has(kind);
}

/**
 * The signable half of an event: everything the author commits to.
 *
 * `pubkey` is the author's identity. `createdAt` is unix seconds and is the
 * author's own clock — the server records its own receive time separately, and
 * never trusts this one for ordering (that is what per-channel `seq` is for).
 */
export interface UnsignedEvent {
	pubkey: string;
	channelId: string;
	kind: EventKind;
	createdAt: number;
	content: string;
	/** Free-form references: `["reply", <eventId>]`, `["mention", <pubkey>]`, … */
	tags: string[][];
}

export interface SignedEvent extends UnsignedEvent {
	/** SHA-256 hex of the canonical serialization. The event's name. */
	id: string;
	/** Ed25519 signature over the 32 id bytes, hex. */
	sig: string;
}

/**
 * Canonical serialization as a positional array, never an object.
 *
 * An array sidesteps the problem that otherwise needs an ordered-map type to
 * solve: object key ordering is not guaranteed by JSON and two encoders can
 * disagree, which would make the same event hash differently on two clients. A
 * fixed-order array has one encoding by construction, so the id is reproducible
 * anywhere, including in a browser tab that never saw the server's code.
 */
export function canonicalize(event: UnsignedEvent): string {
	return JSON.stringify([
		0,
		event.pubkey,
		event.channelId,
		event.kind,
		event.createdAt,
		event.tags,
		event.content,
	]);
}

const encoder = new TextEncoder();

/**
 * Copy bytes into a fresh `ArrayBuffer` for a WebCrypto call.
 *
 * TypeScript's DOM lib types `BufferSource` as backed by `ArrayBuffer`
 * specifically, while `TextEncoder.encode` and friends now return
 * `Uint8Array<ArrayBufferLike>` (which could in principle be a `SharedArrayBuffer`).
 * A one-time copy makes the type exact and the intent obvious, at a cost that does
 * not matter for 32–64 byte payloads.
 */
function toBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(copy).set(bytes);
	return copy;
}

function bytesToHex(bytes: Uint8Array): string {
	let hex = "";
	for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
	return hex;
}

function hexToBytes(hex: string): Uint8Array {
	if (hex.length % 2 !== 0) throw new Error("Odd-length hex string.");
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
		if (Number.isNaN(byte)) throw new Error("Invalid hex string.");
		bytes[i] = byte;
	}
	return bytes;
}

/** The 32 id bytes: SHA-256 of the canonical serialization. */
async function idBytes(event: UnsignedEvent): Promise<Uint8Array> {
	const digest = await crypto.subtle.digest("SHA-256", toBuffer(encoder.encode(canonicalize(event))));
	return new Uint8Array(digest);
}

/** The event id an author and a verifier must independently agree on. */
export async function computeId(event: UnsignedEvent): Promise<string> {
	return bytesToHex(await idBytes(event));
}

/**
 * A keypair, with the public half already reduced to the hex string used as an
 * identity everywhere else. The private key stays a `CryptoKey` so a browser can
 * hold a non-extractable one it can sign with but never read out.
 */
export interface Keypair {
	publicKeyHex: string;
	publicKey: CryptoKey;
	privateKey: CryptoKey;
}

export async function generateKeypair(extractable = false): Promise<Keypair> {
	const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, extractable, [
		"sign",
		"verify",
	])) as CryptoKeyPair;
	const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
	return { publicKeyHex: bytesToHex(raw), publicKey: pair.publicKey, privateKey: pair.privateKey };
}

/** Import a public key from the hex identity for verification. */
export async function importPublicKey(publicKeyHex: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", toBuffer(hexToBytes(publicKeyHex)), { name: "Ed25519" }, true, [
		"verify",
	]);
}

/**
 * JWK is the one private-key form WebCrypto will export for Ed25519 (`raw` is
 * refused), so it is how a non-browser holder — a script, an agent runtime —
 * persists a key between runs. A browser should prefer storing the non-extractable
 * `CryptoKey` itself in IndexedDB and never call this.
 */
export async function exportPrivateKeyJwk(privateKey: CryptoKey): Promise<JsonWebKey> {
	return crypto.subtle.exportKey("jwk", privateKey);
}

export async function importPrivateKeyJwk(jwk: JsonWebKey): Promise<CryptoKey> {
	return crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, true, ["sign"]);
}

/** Compute the id, then sign it. The returned event is ready to send. */
export async function signEvent(
	event: UnsignedEvent,
	privateKey: CryptoKey,
): Promise<SignedEvent> {
	const id = await idBytes(event);
	const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, toBuffer(id)));
	return { ...event, id: bytesToHex(id), sig: bytesToHex(sig) };
}

/**
 * Verify an event end to end, and say why it failed.
 *
 * The order matters and is the whole point: recompute the id from the body FIRST
 * and reject a mismatch, THEN check the signature against that id. A verifier that
 * only checks the signature over the *claimed* id accepts an event whose body was
 * swapped after signing — the signature still covers the old id, and nothing
 * notices the content no longer hashes to it.
 */
export async function verifyEvent(event: SignedEvent): Promise<{ ok: true } | { ok: false; reason: string }> {
	let recomputed: Uint8Array;
	try {
		recomputed = await idBytes(event);
	} catch {
		return { ok: false, reason: "Event is not serializable." };
	}
	if (bytesToHex(recomputed) !== event.id) {
		return { ok: false, reason: "Event id does not match its contents." };
	}
	let publicKey: CryptoKey;
	let sig: Uint8Array;
	try {
		publicKey = await importPublicKey(event.pubkey);
		sig = hexToBytes(event.sig);
	} catch {
		return { ok: false, reason: "Malformed public key or signature." };
	}
	const valid = await crypto.subtle.verify(
		{ name: "Ed25519" },
		publicKey,
		toBuffer(sig),
		toBuffer(recomputed),
	);
	return valid ? { ok: true } : { ok: false, reason: "Signature does not verify." };
}
