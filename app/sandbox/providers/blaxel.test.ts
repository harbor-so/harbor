// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Blaxel provider, verified with an injected `fetch`.
 *
 * The shared provider-contract suite runs this backend against real Blaxel when
 * `BL_API_KEY` is set; these tests cover the account-free properties — that a lost
 * connection during reconciliation throws rather than returning `null`, that a 404
 * is an answer and a 500 is not, that the attempt id round-trips through
 * `metadata.labels`, that the image is placed at `spec.runtime.image`, and that
 * HTTP statuses map to the circuit breaker's vocabulary. TypeScript cannot check
 * any of those.
 */

import { describe, expect, it } from "vitest";
import { SandboxProviderError } from "../provider.js";
import type { CreateSandboxConfig } from "../provider.js";
import { blaxelProvider } from "./blaxel.js";

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
		blaxel: blaxelProvider({ fetch: impl, apiKey: "bl-key", workspace: "ws-1", ...extra }),
		calls,
	};
}

const config = (over: Partial<CreateSandboxConfig> = {}): CreateSandboxConfig => ({
	sessionId: "sess-1",
	sandboxId: "sbx-1",
	attemptId: "att-1",
	image: "blaxel/harbor-image:latest",
	workspace: "/workspace",
	env: { HARBOR_CONTROL_URL: "https://cp.example" },
	timeoutMs: 60_000,
	features: {},
	...over,
});

describe("blaxel.create", () => {
	it("creates a sandbox, stamps the attempt id as a label, images under spec.runtime, and returns its name", async () => {
		const { blaxel, calls } = provider((_url, init) => {
			expect(init.method).toBe("POST");
			return {
				status: 200,
				body: { metadata: { name: "harbor-att-1" }, status: "DEPLOYED" },
			};
		});
		const created = await blaxel.create(config());
		expect(created.externalId).toBe("harbor-att-1");
		expect(created.provider).toBe("blaxel");
		expect(created.state).toBe("running");

		const sent = calls[0]!;
		expect(sent.url).toContain("/sandboxes");
		const body = sent.body as {
			metadata: { name: string; labels: Record<string, string> };
			spec: { runtime: { image: string; envs: { name: string; value: string }[] } };
		};
		expect(body.metadata.labels.harbor_attempt).toBe("att-1");
		expect(body.metadata.labels.harbor_managed).toBe("true");
		expect(body.metadata.name).toBe("harbor-att-1");
		// The image belongs at spec.runtime.image, not spec.image.
		expect(body.spec.runtime.image).toBe("blaxel/harbor-image:latest");
		expect(body.spec.runtime.envs).toContainEqual({
			name: "HARBOR_CONTROL_URL",
			value: "https://cp.example",
		});
	});

	it("maps DEPLOYING to starting", async () => {
		const { blaxel } = provider(() => ({
			status: 201,
			body: { metadata: { name: "harbor-att-1" }, status: "DEPLOYING" },
		}));
		expect((await blaxel.create(config())).state).toBe("starting");
	});

	it("maps a Blaxel error status to the circuit vocabulary", async () => {
		const bad = provider(() => ({ status: 400, body: { message: "bad image" } }));
		await expect(bad.blaxel.create(config())).rejects.toMatchObject({
			name: "SandboxProviderError",
			errorType: "invalid_config",
		});
		const unauth = provider(() => ({ status: 401, body: { message: "nope" } }));
		await expect(unauth.blaxel.create(config())).rejects.toMatchObject({
			errorType: "unauthorized",
		});
	});

	it("refuses a create with no api key, as invalid_config", async () => {
		const noKey = blaxelProvider({
			workspace: "ws-1",
			fetch: fakeFetch(() => ({ status: 200, body: {} })).impl,
		});
		await expect(noKey.create(config())).rejects.toMatchObject({ errorType: "invalid_config" });
	});

	it("refuses a create with no workspace, as invalid_config", async () => {
		const noWs = blaxelProvider({
			apiKey: "bl-key",
			fetch: fakeFetch(() => ({ status: 200, body: {} })).impl,
		});
		await expect(noWs.create(config())).rejects.toMatchObject({ errorType: "invalid_config" });
	});
});

describe("blaxel.inspect", () => {
	it("round-trips labels and state", async () => {
		const { blaxel } = provider(() => ({
			status: 200,
			body: {
				metadata: {
					name: "s1",
					labels: { harbor_attempt: "att-1", harbor_session: "sess-1" },
				},
				status: "DEPLOYED",
			},
		}));
		const found = await blaxel.inspect("s1");
		expect(found?.state).toBe("running");
		expect(found?.rawState).toBe("DEPLOYED");
		expect(found?.attemptId).toBe("att-1");
		expect(found?.sessionId).toBe("sess-1");
	});

	it("returns null on 404 (an answer) but throws on 500 (not an answer)", async () => {
		expect(await provider(() => ({ status: 404, body: {} })).blaxel.inspect("gone")).toBeNull();
		await expect(
			provider(() => ({ status: 500, body: {} })).blaxel.inspect("s1"),
		).rejects.toMatchObject({ errorType: "transient" });
	});
});

describe("blaxel.findByAttemptId — fails closed", () => {
	it("returns the live sandbox when one matches the label", async () => {
		const { blaxel } = provider(() => ({
			status: 200,
			body: [{ metadata: { name: "s1", labels: { harbor_attempt: "att-1" } }, status: "DEPLOYED" }],
		}));
		expect((await blaxel.findByAttemptId("att-1"))?.externalId).toBe("s1");
	});

	it("returns null when Blaxel answers with no match", async () => {
		expect(
			await provider(() => ({ status: 200, body: { sandboxes: [] } })).blaxel.findByAttemptId(
				"att-x",
			),
		).toBeNull();
	});

	it("THROWS rather than returning null when Blaxel is unreachable", async () => {
		const throwing = blaxelProvider({
			apiKey: "k",
			workspace: "ws-1",
			fetch: (async () => {
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch,
		});
		await expect(throwing.findByAttemptId("att-1")).rejects.toMatchObject({
			errorType: "transient",
		});
	});
});

describe("blaxel.stop — idempotent", () => {
	it("reports stopped, absent and already_stopped without throwing", async () => {
		expect(await provider(() => ({ status: 202, body: undefined })).blaxel.stop("s1")).toBe(
			"stopped",
		);
		expect(await provider(() => ({ status: 404, body: {} })).blaxel.stop("gone")).toBe("absent");
		expect(
			await provider(() => ({ status: 409, body: { message: "sandbox already deleting" } })).blaxel.stop(
				"s1",
			),
		).toBe("already_stopped");
	});
});

describe("blaxel.listManaged — fails closed", () => {
	it("returns only live managed boxes and throws when unreachable", async () => {
		const { blaxel } = provider(() => ({
			status: 200,
			body: {
				sandboxes: [
					{ metadata: { name: "s1", labels: { harbor_managed: "true" } }, status: "DEPLOYED" },
					{ metadata: { name: "s2", labels: { harbor_managed: "true" } }, status: "TERMINATED" },
					{ metadata: { name: "s3", labels: {} }, status: "DEPLOYED" },
				],
			},
		}));
		const managed = await blaxel.listManaged();
		expect(managed.map((i) => i.externalId)).toEqual(["s1"]);

		const throwing = blaxelProvider({
			apiKey: "k",
			workspace: "ws-1",
			fetch: (async () => {
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch,
		});
		await expect(throwing.listManaged()).rejects.toMatchObject({ errorType: "transient" });
	});
});
