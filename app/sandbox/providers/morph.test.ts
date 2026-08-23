// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Morph provider, verified with an injected `fetch`.
 *
 * The shared provider-contract suite runs this backend against real Morph when
 * `MORPH_API_KEY` is set; these tests cover the account-free properties — that a
 * lost connection during reconciliation throws rather than returning `null`, that
 * a 404 is an answer and a 500 is not, that the attempt id round-trips through
 * instance metadata, and that HTTP statuses map to the circuit breaker's
 * vocabulary. TypeScript cannot check any of those.
 */

import { describe, expect, it } from "vitest";
import { SandboxProviderError } from "../provider.js";
import type { CreateSandboxConfig } from "../provider.js";
import { morphProvider } from "./morph.js";

type Reply = { status: number; body: unknown };
type Handler = (url: string, init: { method?: string; body?: string }) => Reply;

function fakeFetch(handler: Handler) {
	const calls: { url: string; method: string; body: unknown }[] = [];
	const impl = (async (url: string, init: { method?: string; body?: string } = {}) => {
		calls.push({
			url,
			method: init.method ?? "GET",
			body: init.body ? JSON.parse(init.body) : undefined,
		});
		const reply = handler(url, init);
		return {
			status: reply.status,
			text: async () => (reply.body === undefined ? "" : JSON.stringify(reply.body)),
		} as Response;
	}) as unknown as typeof fetch;
	return { impl, calls };
}

function provider(handler: Handler, extra: Record<string, unknown> = {}) {
	const { impl, calls } = fakeFetch(handler);
	return { morph: morphProvider({ fetch: impl, apiKey: "morph-key", ...extra }), calls };
}

const config = (over: Partial<CreateSandboxConfig> = {}): CreateSandboxConfig => ({
	sessionId: "sess-1",
	sandboxId: "sbx-1",
	attemptId: "att-1",
	image: "snapshot_abc",
	workspace: "/workspace",
	env: { HARBOR_CONTROL_URL: "https://cp.example" },
	timeoutMs: 60_000,
	features: {},
	...over,
});

describe("morph.create", () => {
	it("starts an instance from the snapshot, stamps the attempt id, returns its id", async () => {
		const { morph, calls } = provider((_url, init) => {
			expect(init.method).toBe("POST");
			return { status: 200, body: { id: "inst-abc", status: "ready" } };
		});
		const created = await morph.create(config());
		expect(created.externalId).toBe("inst-abc");
		expect(created.provider).toBe("morph");
		expect(created.state).toBe("running");

		const sent = calls[0]!;
		// Snapshot id rides on the query string; metadata rides in the body.
		expect(sent.url).toContain("/instance");
		expect(sent.url).toContain("snapshot_id=snapshot_abc");
		const body = sent.body as { metadata: Record<string, string> };
		expect(body.metadata.harbor_attempt).toBe("att-1");
		expect(body.metadata.harbor_managed).toBe("true");
	});

	it("maps a pending instance to starting", async () => {
		const { morph } = provider(() => ({ status: 201, body: { id: "inst-1", status: "pending" } }));
		expect((await morph.create(config())).state).toBe("starting");
	});

	it("sends a TTL backstop only when configured", async () => {
		const withTtl = provider(() => ({ status: 200, body: { id: "i", status: "ready" } }), {
			ttlSec: 900,
		});
		await withTtl.morph.create(config());
		const body = withTtl.calls[0]!.body as { ttl_seconds?: number; ttl_action?: string };
		expect(body.ttl_seconds).toBe(900);
		expect(body.ttl_action).toBe("stop");

		const noTtl = provider(() => ({ status: 200, body: { id: "i", status: "ready" } }));
		await noTtl.morph.create(config());
		expect((noTtl.calls[0]!.body as { ttl_seconds?: number }).ttl_seconds).toBeUndefined();
	});

	it("maps a Morph error status to the circuit vocabulary", async () => {
		const bad = provider(() => ({ status: 400, body: { message: "no such snapshot" } }));
		await expect(bad.morph.create(config())).rejects.toMatchObject({
			name: "SandboxProviderError",
			errorType: "invalid_config",
		});
		const unauth = provider(() => ({ status: 401, body: { message: "nope" } }));
		await expect(unauth.morph.create(config())).rejects.toMatchObject({
			errorType: "unauthorized",
		});
	});

	it("refuses a create with no api key, as invalid_config", async () => {
		const noKey = morphProvider({ fetch: fakeFetch(() => ({ status: 200, body: {} })).impl });
		await expect(noKey.create(config())).rejects.toMatchObject({ errorType: "invalid_config" });
	});
});

describe("morph.inspect", () => {
	it("round-trips metadata and state", async () => {
		const { morph } = provider(() => ({
			status: 200,
			body: {
				id: "i1",
				status: "ready",
				metadata: { harbor_attempt: "att-1", harbor_session: "sess-1" },
			},
		}));
		const found = await morph.inspect("i1");
		expect(found?.state).toBe("running");
		expect(found?.rawState).toBe("ready");
		expect(found?.attemptId).toBe("att-1");
		expect(found?.sessionId).toBe("sess-1");
	});

	it("returns null on 404 (an answer) but throws on 500 (not an answer)", async () => {
		expect(await provider(() => ({ status: 404, body: {} })).morph.inspect("gone")).toBeNull();
		await expect(
			provider(() => ({ status: 500, body: {} })).morph.inspect("i1"),
		).rejects.toMatchObject({ errorType: "transient" });
	});
});

describe("morph.findByAttemptId — fails closed", () => {
	it("returns the live instance when one matches", async () => {
		const { morph, calls } = provider(() => ({
			status: 200,
			body: [{ id: "i1", status: "ready", metadata: { harbor_attempt: "att-1" } }],
		}));
		expect((await morph.findByAttemptId("att-1"))?.externalId).toBe("i1");
		expect(calls[0]!.url).toContain(`metadata%5Bharbor_attempt%5D=att-1`);
	});

	it("prefers a live instance over an inactive one sharing the attempt", async () => {
		const { morph } = provider(() => ({
			status: 200,
			body: {
				data: [
					{ id: "dead", status: "error", metadata: { harbor_attempt: "att-1" } },
					{ id: "live", status: "ready", metadata: { harbor_attempt: "att-1" } },
				],
			},
		}));
		expect((await morph.findByAttemptId("att-1"))?.externalId).toBe("live");
	});

	it("returns null when Morph answers with no match", async () => {
		expect(
			await provider(() => ({ status: 200, body: [] })).morph.findByAttemptId("att-x"),
		).toBeNull();
	});

	it("THROWS rather than returning null when Morph is unreachable", async () => {
		const throwing = morphProvider({
			apiKey: "k",
			fetch: (async () => {
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch,
		});
		await expect(throwing.findByAttemptId("att-1")).rejects.toMatchObject({
			errorType: "transient",
		});
	});

	it("THROWS rather than returning null when Morph 5xxs", async () => {
		await expect(
			provider(() => ({ status: 503, body: {} })).morph.findByAttemptId("att-1"),
		).rejects.toMatchObject({ errorType: "transient" });
	});
});

describe("morph.stop — idempotent", () => {
	it("reports stopped, absent and already_stopped without throwing", async () => {
		expect(await provider(() => ({ status: 204, body: undefined })).morph.stop("i1")).toBe(
			"stopped",
		);
		expect(await provider(() => ({ status: 404, body: {} })).morph.stop("gone")).toBe("absent");
		expect(
			await provider(() => ({ status: 409, body: { message: "instance already stopped" } })).morph.stop(
				"i1",
			),
		).toBe("already_stopped");
	});
});

describe("morph.listManaged — fails closed", () => {
	it("returns only live managed boxes and throws when unreachable", async () => {
		const { morph } = provider(() => ({
			status: 200,
			body: {
				instances: [
					{ id: "i1", status: "ready", metadata: { harbor_managed: "true" } },
					{ id: "i2", status: "paused", metadata: { harbor_managed: "true" } },
				],
			},
		}));
		const managed = await morph.listManaged();
		// Only the live one; a paused instance is not a running box.
		expect(managed.map((i) => i.externalId)).toEqual(["i1"]);

		const throwing = morphProvider({
			apiKey: "k",
			fetch: (async () => {
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch,
		});
		await expect(throwing.listManaged()).rejects.toMatchObject({ errorType: "transient" });
	});
});
