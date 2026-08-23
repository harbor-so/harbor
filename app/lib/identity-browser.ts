"use client";
// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0

/**
 * A human's key lives in their browser, never on the server.
 *
 * This is the client counterpart to the trust model in `chat.ts`: the server only
 * ever learns a public key, so a person's identity is a keypair they hold. The
 * private key is generated non-extractable and stored as a `CryptoKey` in
 * IndexedDB — structured clone keeps it usable across reloads while JavaScript can
 * never read the raw bytes out, so an XSS bug can abuse the key in place but
 * cannot exfiltrate it.
 *
 * The obvious shortcut — a server-held key per user — is what this refuses. It
 * would make every "signed" event forgeable by the server, which is the one
 * property the signature exists to remove.
 *
 * Known limitation, stated plainly: the key is per-device and has no recovery. A
 * new browser is a new identity until key portability is built. That is a real
 * gap, not a hidden one (see CHAT.md).
 */

import { generateKeypair, type Keypair } from "./signing.js";

const DB_NAME = "harbor-chat";
const STORE = "identity";
const RECORD = "self";

interface StoredIdentity {
	pubkey: string;
	publicKey: CryptoKey;
	privateKey: CryptoKey;
}

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 1);
		request.onupgradeneeded = () => request.result.createObjectStore(STORE);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function idbGet(db: IDBDatabase, key: string): Promise<StoredIdentity | undefined> {
	return new Promise((resolve, reject) => {
		const request = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
		request.onsuccess = () => resolve(request.result as StoredIdentity | undefined);
		request.onerror = () => reject(request.error);
	});
}

function idbPut(db: IDBDatabase, key: string, value: StoredIdentity): Promise<void> {
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, "readwrite");
		tx.objectStore(STORE).put(value, key);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

/** Load this device's keypair, generating and persisting one on first use. */
export async function loadKeypair(): Promise<Keypair> {
	const db = await openDb();
	const existing = await idbGet(db, RECORD);
	if (existing) {
		return {
			publicKeyHex: existing.pubkey,
			publicKey: existing.publicKey,
			privateKey: existing.privateKey,
		};
	}
	const keypair = await generateKeypair(false);
	await idbPut(db, RECORD, {
		pubkey: keypair.publicKeyHex,
		publicKey: keypair.publicKey,
		privateKey: keypair.privateKey,
	});
	return keypair;
}

/**
 * Load the keypair and make sure the org knows its public half.
 *
 * `register` is idempotent server-side, so calling this on every mount is cheap
 * and keeps the display name current.
 */
export async function ensureIdentity(displayName: string): Promise<Keypair> {
	const keypair = await loadKeypair();
	await fetch("/api/principals", {
		method: "POST",
		headers: { "content-type": "application/json" },
		credentials: "include",
		body: JSON.stringify({ pubkey: keypair.publicKeyHex, displayName }),
	});
	return keypair;
}
