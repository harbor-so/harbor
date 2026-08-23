// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Cloudflare provider, verified with an injected `fetch` against the shim's HTTP
 * contract.
 *
 * The Durable Object and Container behaviour lives in the Worker shim
 * (`integrations/cloudflare-sandbox-worker`) and is exercised there; this file
 * covers the Harbor-side client — that a lost connection during reconciliation
 * throws rather than returning `null`, that a 404 is an answer and a 500 is not,
 * that the attempt id round-trips, and that HTTP statuses map to the circuit
 * breaker's vocabulary.
 */

import { describe, expect, it } from "vitest";
import { SandboxProviderError } from "../provider.js";
import type { CreateSandboxConfig } from "../provider.js";
import { cloudflareProvider } from "./cloudflare.js";

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
	return {
		cf: cloudflareProvider({
			fetch: impl,
			workerUrl: "https://shim.workers.dev",
			workerToken: "shim-token",
			...extra,
		}),
		calls,
	};
}

const config = (over: Partial<CreateSandboxConfig> = {}): CreateSandboxConfig => ({
	sessionId: "sess-1",
	sandboxId: "sbx-1",
	attemptId: "att-1",
	image: "harbor-sandbox:latest",
	workspace: "/workspace",
	env: { HARBOR_CONTROL_URL: "https://cp.example" },
	timeoutMs: 60_000,
	features: {},
	...over,
});

describe("cloudflare.create", () => {
	it("posts to the shim, sends the attempt id, and returns the external id", async () => {
		const { cf, calls } = provider((_url, init) => {
			expect(init.method).toBe("POST");
			return { status: 201, body: { externalId: "harbor-sbx-1", state: "starting" } };
		});
		const created = await cf.create(config());
		expect(created.externalId).toBe("harbor-sbx-1");
		expect(created.provider).toBe("cloudflare");
		expect(created.state).toBe("starting");

		const sent = calls[0]!;
		expect(sent.url).toContain("/sandboxes");
		const body = sent.body as { attemptId: string; sandboxId: string };
		expect(body.attemptId).toBe("att-1");
		expect(body.sandboxId).toBe("sbx-1");
	});

	it("maps a shim error status to the circuit vocabulary", async () => {
		const bad = provider(() => ({ status: 422, body: { error: "bad" } }));
		await expect(bad.cf.create(config())).rejects.toMatchObject({
			name: "SandboxProviderError",
			errorType: "invalid_config",
		});
		const unauth = provider(() => ({ status: 401, body: { error: "nope" } }));
		await expect(unauth.cf.create(config())).rejects.toMatchObject({ errorType: "unauthorized" });
	});

	it("refuses a create with no worker url or token, as invalid_config", async () => {
		const noUrl = cloudflareProvider({
			fetch: fakeFetch(() => ({ status: 200, body: {} })).impl,
			workerToken: "t",
		});
		await expect(noUrl.create(config())).rejects.toMatchObject({ errorType: "invalid_config" });
		const noToken = cloudflareProvider({
			fetch: fakeFetch(() => ({ status: 200, body: {} })).impl,
			workerUrl: "https://shim.workers.dev",
		});
		await expect(noToken.create(config())).rejects.toMatchObject({ errorType: "invalid_config" });
	});
});

describe("cloudflare.inspect", () => {
	it("round-trips metadata and state", async () => {
		const { cf } = provider(() => ({
			status: 200,
			body: {
				externalId: "harbor-sbx-1",
				state: "running",
				attemptId: "att-1",
				sessionId: "sess-1",
				sandboxId: "sbx-1",
			},
		}));
		const found = await cf.inspect("harbor-sbx-1");
		expect(found?.state).toBe("running");
		expect(found?.attemptId).toBe("att-1");
		expect(found?.sessionId).toBe("sess-1");
	});

	it("returns null on 404 (an answer) but throws on 500 (not an answer)", async () => {
		expect(await provider(() => ({ status: 404, body: {} })).cf.inspect("gone")).toBeNull();
		await expect(
			provider(() => ({ status: 500, body: {} })).cf.inspect("x"),
		).rejects.toMatchObject({ errorType: "transient" });
	});
});

describe("cloudflare.findByAttemptId — fails closed", () => {
	it("returns the sandbox when one matches", async () => {
		const { cf } = provider(() => ({
			status: 200,
			body: { sandbox: { externalId: "harbor-sbx-1", state: "running", attemptId: "att-1" } },
		}));
		expect((await cf.findByAttemptId("att-1"))?.externalId).toBe("harbor-sbx-1");
	});

	it("returns null when the shim answers with no match", async () => {
		expect(
			await provider(() => ({ status: 200, body: { sandbox: null } })).cf.findByAttemptId("att-x"),
		).toBeNull();
	});

	it("THROWS rather than returning null when the shim is unreachable", async () => {
		const throwing = cloudflareProvider({
			workerUrl: "https://shim.workers.dev",
			workerToken: "t",
			fetch: (async () => {
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch,
		});
		await expect(throwing.findByAttemptId("att-1")).rejects.toMatchObject({ errorType: "transient" });
	});

	it("THROWS on a 500 from the shim, never an empty answer", async () => {
		await expect(
			provider(() => ({ status: 500, body: { error: "kv down" } })).cf.findByAttemptId("att-1"),
		).rejects.toMatchObject({ errorType: "transient" });
	});
});

describe("cloudflare.stop — idempotent", () => {
	it("reports stopped, absent and already_stopped without throwing", async () => {
		expect(
			await provider(() => ({ status: 200, body: { outcome: "stopped" } })).cf.stop("harbor-sbx-1"),
		).toBe("stopped");
		expect(await provider(() => ({ status: 404, body: {} })).cf.stop("gone")).toBe("absent");
		expect(
			await provider(() => ({ status: 200, body: { outcome: "already_stopped" } })).cf.stop("x"),
		).toBe("already_stopped");
	});
});

describe("cloudflare.listManaged — fails closed", () => {
	it("returns only live managed boxes and throws when unreachable", async () => {
		const { cf } = provider(() => ({
			status: 200,
			body: {
				sandboxes: [
					{ externalId: "harbor-a", state: "running", attemptId: "att-a" },
					{ externalId: "harbor-b", state: "exited", attemptId: "att-b" },
				],
			},
		}));
		const managed = await cf.listManaged();
		expect(managed.map((i) => i.externalId)).toEqual(["harbor-a"]);

		const throwing = cloudflareProvider({
			workerUrl: "https://shim.workers.dev",
			workerToken: "t",
			fetch: (async () => {
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch,
		});
		await expect(throwing.listManaged()).rejects.toMatchObject({ errorType: "transient" });
	});
});
