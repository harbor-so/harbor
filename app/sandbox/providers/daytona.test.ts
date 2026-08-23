// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Daytona provider, verified with an injected `fetch`.
 *
 * The shared provider-contract suite runs this backend against real Daytona when
 * `DAYTONA_API_KEY` is set; these tests cover the account-free properties — that a
 * lost connection during reconciliation throws rather than returning `null`, that
 * a 404 is an answer and a 500 is not, that the attempt id round-trips through
 * sandbox labels, and that HTTP statuses map to the circuit breaker's vocabulary.
 * TypeScript cannot check any of those.
 */

import { describe, expect, it } from "vitest";
import type { CreateSandboxConfig } from "../provider.js";
import { daytonaProvider } from "./daytona.js";

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
		daytona: daytonaProvider({ fetch: impl, apiKey: "daytona-key", ...extra }),
		calls,
	};
}

const config = (over: Partial<CreateSandboxConfig> = {}): CreateSandboxConfig => ({
	sessionId: "sess-1",
	sandboxId: "sbx-1",
	attemptId: "att-1",
	image: "harbor-snapshot",
	workspace: "/workspace",
	env: { HARBOR_CONTROL_URL: "https://cp.example" },
	timeoutMs: 60_000,
	features: {},
	...over,
});

describe("daytona.create", () => {
	it("creates a sandbox, stamps the attempt id as a label, and returns its id", async () => {
		const { daytona, calls } = provider((_url, init) => {
			expect(init.method).toBe("POST");
			return { status: 201, body: { id: "sbx-abc", state: "started" } };
		});
		const created = await daytona.create(config());
		expect(created.externalId).toBe("sbx-abc");
		expect(created.provider).toBe("daytona");
		expect(created.state).toBe("running");

		const sent = calls[0]!;
		expect(sent.url).toContain("/sandbox");
		const body = sent.body as { snapshot: string; labels: Record<string, string> };
		expect(body.snapshot).toBe("harbor-snapshot");
		expect(body.labels.harbor_attempt).toBe("att-1");
		expect(body.labels.harbor_managed).toBe("true");
	});

	it("maps a Daytona error status to the circuit vocabulary", async () => {
		const bad = provider(() => ({ status: 400, body: { message: "bad snapshot" } }));
		await expect(bad.daytona.create(config())).rejects.toMatchObject({
			name: "SandboxProviderError",
			errorType: "invalid_config",
		});
		const unauth = provider(() => ({ status: 401, body: { message: "nope" } }));
		await expect(unauth.daytona.create(config())).rejects.toMatchObject({
			errorType: "unauthorized",
		});
	});

	it("refuses a create with no api key, as invalid_config", async () => {
		const noKey = daytonaProvider({ fetch: fakeFetch(() => ({ status: 200, body: {} })).impl });
		await expect(noKey.create(config())).rejects.toMatchObject({ errorType: "invalid_config" });
	});
});

describe("daytona.inspect", () => {
	it("round-trips labels and state", async () => {
		const { daytona } = provider(() => ({
			status: 200,
			body: {
				id: "s1",
				state: "started",
				labels: { harbor_attempt: "att-1", harbor_session: "sess-1" },
			},
		}));
		const found = await daytona.inspect("s1");
		expect(found?.state).toBe("running");
		expect(found?.attemptId).toBe("att-1");
		expect(found?.sessionId).toBe("sess-1");
	});

	it("returns null on 404 (an answer) but throws transient on 500 (not an answer)", async () => {
		expect(await provider(() => ({ status: 404, body: {} })).daytona.inspect("gone")).toBeNull();
		await expect(
			provider(() => ({ status: 500, body: {} })).daytona.inspect("s1"),
		).rejects.toMatchObject({ errorType: "transient" });
	});
});

describe("daytona.findByAttemptId — fails closed", () => {
	it("returns the live sandbox when one matches, filtering by the label query", async () => {
		const { daytona, calls } = provider(() => ({
			status: 200,
			body: [{ id: "s1", state: "started", labels: { harbor_attempt: "att-1" } }],
		}));
		expect((await daytona.findByAttemptId("att-1"))?.externalId).toBe("s1");
		expect(calls[0]!.url).toContain("labels=");
		expect(decodeURIComponent(calls[0]!.url)).toContain("harbor_attempt");
	});

	it("returns null when Daytona answers with no match", async () => {
		expect(
			await provider(() => ({ status: 200, body: [] })).daytona.findByAttemptId("att-x"),
		).toBeNull();
	});

	it("THROWS transient rather than returning null when Daytona is unreachable", async () => {
		const throwing = daytonaProvider({
			apiKey: "k",
			fetch: (async () => {
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch,
		});
		await expect(throwing.findByAttemptId("att-1")).rejects.toMatchObject({
			errorType: "transient",
		});
	});

	it("THROWS transient rather than returning null on a 5xx from the list call", async () => {
		await expect(
			provider(() => ({ status: 503, body: {} })).daytona.findByAttemptId("att-1"),
		).rejects.toMatchObject({ errorType: "transient" });
	});
});

describe("daytona.stop — idempotent", () => {
	it("reports stopped, absent and already_stopped without throwing", async () => {
		expect(await provider(() => ({ status: 204, body: undefined })).daytona.stop("s1")).toBe(
			"stopped",
		);
		expect(await provider(() => ({ status: 404, body: {} })).daytona.stop("gone")).toBe("absent");
		expect(
			await provider(() => ({ status: 409, body: { message: "sandbox already destroyed" } })).daytona.stop(
				"s1",
			),
		).toBe("already_stopped");
	});
});

describe("daytona.listManaged — fails closed", () => {
	it("returns only live managed boxes and throws transient when unreachable", async () => {
		const { daytona } = provider(() => ({
			status: 200,
			body: {
				sandboxes: [
					{ id: "s1", state: "started", labels: { harbor_managed: "true" } },
					{ id: "s2", state: "stopped", labels: { harbor_managed: "true" } },
				],
			},
		}));
		const managed = await daytona.listManaged();
		expect(managed.map((i) => i.externalId)).toEqual(["s1"]);

		const throwing = daytonaProvider({
			apiKey: "k",
			fetch: (async () => {
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch,
		});
		await expect(throwing.listManaged()).rejects.toMatchObject({ errorType: "transient" });
	});
});
