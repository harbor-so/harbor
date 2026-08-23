// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The credential broker's body bound, asserted where it has to hold: **before
 * authentication**.
 *
 * This endpoint examines the sandbox token only once it has the request body in
 * hand, so anything it does with that body it does for an anonymous caller. A
 * ceiling checked after `request.text()` is not a ceiling — the memory is already
 * spent by the time it fires — and the caller who cares about that is the one
 * sending a gigabyte with no credential at all. The two cases below are the only
 * two that matter: an oversized body is refused without being read, and an ordinary
 * one still reaches the auth check it is supposed to fail.
 *
 * No database rows are needed for either: both answers are produced above the first
 * query, which is itself part of the property being asserted.
 */

import { afterAll, describe, expect, it } from "vitest";
import { POST as postCredentials } from "./[id]/credentials/route.js";
import { setting } from "@core/kernel/config.js";
import { sql } from "@core/schema/index.js";

afterAll(async () => {
	await sql.end({ timeout: 5 });
});

const SANDBOX_ID = "3f7c1c0e-6a4e-4f2f-9a2a-9c1d5f0b7e21";

function credentialRequest(body: string): Request {
	return new Request(`http://harbor.test/api/sandbox/${SANDBOX_ID}/credentials`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body,
	});
}

describe("POST /api/sandbox/[id]/credentials — the body bound", () => {
	it("refuses an oversized body with 413, without a credential and without reading it", async () => {
		const ceiling = setting("maxEventPayloadChars");
		const body = JSON.stringify({
			repo: { owner: "acme", name: "x".repeat(ceiling + 1_000) },
			operation: "clone",
		});
		expect(body.length).toBeGreaterThan(ceiling);

		const response = await postCredentials(credentialRequest(body), {
			params: Promise.resolve({ id: SANDBOX_ID }),
		});

		expect(response.status).toBe(413);
		expect(((await response.json()) as { reason: string }).reason).toBe("body_too_large");
	});

	it("still lets an ordinary body through to the authentication it fails", async () => {
		// 401, not 413: the bound must not be so eager that it refuses the traffic the
		// endpoint exists for. A guard that also blocks the healthy case is an outage.
		const response = await postCredentials(
			credentialRequest(JSON.stringify({ repo: { owner: "acme", name: "web" }, operation: "clone" })),
			{ params: Promise.resolve({ id: SANDBOX_ID }) },
		);
		expect(response.status).toBe(401);
	});
});
