// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Crypto tests, aimed at the two properties the whole trust model rests on:
 * a signature that only vouches for the exact bytes signed, and an id that is
 * checked independently of that signature. No database — this is pure.
 */

import { describe, expect, it } from "vitest";
import {
	canonicalize,
	computeId,
	generateKeypair,
	signEvent,
	verifyEvent,
	type SignedEvent,
	type UnsignedEvent,
} from "./signing.js";

async function fixture(overrides: Partial<UnsignedEvent> = {}) {
	const author = await generateKeypair();
	const unsigned: UnsignedEvent = {
		pubkey: author.publicKeyHex,
		channelId: "chan-1",
		kind: "message",
		createdAt: 1_700_000_000,
		content: "hello room",
		tags: [],
		...overrides,
	};
	const signed = await signEvent(unsigned, author.privateKey);
	return { author, unsigned, signed };
}

describe("signed events", () => {
	it("verifies an untouched event", async () => {
		const { signed } = await fixture();
		expect(await verifyEvent(signed)).toEqual({ ok: true });
	});

	it("computes a stable, content-addressed id", async () => {
		const { unsigned, signed } = await fixture();
		expect(signed.id).toBe(await computeId(unsigned));
		expect(signed.id).toMatch(/^[0-9a-f]{64}$/);
	});

	it("canonical form is a fixed-order array, so encoding is deterministic", async () => {
		const { unsigned } = await fixture({ content: "x", tags: [["reply", "abc"]] });
		expect(canonicalize(unsigned)).toBe(
			JSON.stringify([0, unsigned.pubkey, "chan-1", "message", 1_700_000_000, [["reply", "abc"]], "x"]),
		);
	});

	it("rejects a body swapped after signing (id no longer matches)", async () => {
		const { signed } = await fixture();
		const tampered: SignedEvent = { ...signed, content: "transfer everything" };
		const result = await verifyEvent(tampered);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/id does not match/i);
	});

	it("rejects a body swap that also recomputes the id, because the sig is over the old id", async () => {
		// The stronger attack: fix up the id so the independent id check passes,
		// leaving only the signature to catch it.
		const { signed } = await fixture();
		const forgedBody = { ...signed, content: "transfer everything" };
		const forged: SignedEvent = { ...forgedBody, id: await computeId(forgedBody) };
		const result = await verifyEvent(forged);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/signature/i);
	});

	it("rejects an event signed by one key but claiming another's pubkey", async () => {
		const { signed } = await fixture();
		const impostor = await generateKeypair();
		const spoofed: SignedEvent = { ...signed, pubkey: impostor.publicKeyHex };
		// The pubkey is part of the canonical body, so changing it breaks the id
		// first — which is exactly the defense working.
		expect((await verifyEvent(spoofed)).ok).toBe(false);
	});

	it("rejects a garbage signature without throwing", async () => {
		const { signed } = await fixture();
		expect((await verifyEvent({ ...signed, sig: "zz" })).ok).toBe(false);
	});
});
