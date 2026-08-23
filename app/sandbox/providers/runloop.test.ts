// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Runloop provider, verified with an injected `fetch`.
 *
 * The shared provider-contract suite runs this backend against real Runloop when
 * `RUNLOOP_API_KEY` is set; these tests cover the account-free properties — that a
 * lost connection during reconciliation throws rather than returning `null`, that
 * a 404 is an answer and a 500 is not, that the attempt id round-trips through
 * Devbox metadata, and that HTTP statuses map to the circuit breaker's vocabulary.
 * TypeScript cannot check any of those.
 */

import { describe, expect, it } from "vitest";
import type { CreateSandboxConfig } from "../provider.js";
import { runloopProvider } from "./runloop.js";

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
	return { runloop: runloopProvider({ fetch: impl, apiKey: "rl-key", ...extra }), calls };
}

const config = (over: Partial<CreateSandboxConfig> = {}): CreateSandboxConfig => ({
	sessionId: "sess-1",
	sandboxId: "sbx-1",
	attemptId: "att-1",
	image: "harbor-blueprint",
	workspace: "/workspace",
	env: { HARBOR_CONTROL_URL: "https://cp.example" },
	timeoutMs: 60_000,
	features: {},
	...over,
});

describe("runloop.create", () => {
	it("creates a Devbox, stamps the attempt id as metadata, and returns its id", async () => {
		const { runloop, calls } = provider((_url, init) => {
			expect(init.method).toBe("POST");
			return { status: 201, body: { id: "dbx-abc", status: "running" } };
		});
		const created = await runloop.create(config());
		expect(created.externalId).toBe("dbx-abc");
		expect(created.provider).toBe("runloop");
		expect(created.state).toBe("running");

		const sent = calls[0]!;
		expect(sent.url).toContain("/v1/devboxes");
		const body = sent.body as {
			blueprint_id: string;
			environment_variables: Record<string, string>;
			metadata: Record<string, string>;
		};
		expect(body.blueprint_id).toBe("harbor-blueprint");
		expect(body.environment_variables.HARBOR_CONTROL_URL).toBe("https://cp.example");
		expect(body.metadata.harbor_attempt).toBe("att-1");
		expect(body.metadata.harbor_managed).toBe("true");
	});

	it("maps a provisioning status onto starting", async () => {
		const { runloop } = provider(() => ({ status: 200, body: { id: "d1", status: "provisioning" } }));
		expect((await runloop.create(config())).state).toBe("starting");
	});

	it("maps a Runloop error status to the circuit vocabulary", async () => {
		const bad = provider(() => ({ status: 400, body: { message: "bad blueprint" } }));
		await expect(bad.runloop.create(config())).rejects.toMatchObject({
			name: "SandboxProviderError",
			errorType: "invalid_config",
		});
		const unauth = provider(() => ({ status: 401, body: { message: "nope" } }));
		await expect(unauth.runloop.create(config())).rejects.toMatchObject({
			errorType: "unauthorized",
		});
	});

	it("refuses a create with no api key, as invalid_config", async () => {
		const noKey = runloopProvider({ fetch: fakeFetch(() => ({ status: 200, body: {} })).impl });
		await expect(noKey.create(config())).rejects.toMatchObject({ errorType: "invalid_config" });
	});
});

describe("runloop.inspect", () => {
	it("round-trips metadata and state", async () => {
		const { runloop } = provider(() => ({
			status: 200,
			body: {
				id: "d1",
				status: "running",
				create_time_ms: 1_700_000_000_000,
				metadata: { harbor_attempt: "att-1", harbor_session: "sess-1" },
			},
		}));
		const found = await runloop.inspect("d1");
		expect(found?.state).toBe("running");
		expect(found?.attemptId).toBe("att-1");
		expect(found?.sessionId).toBe("sess-1");
		expect(found?.startedAt).toBe(new Date(1_700_000_000_000).toISOString());
	});

	it("maps the terminal shutdown status onto exited", async () => {
		const { runloop } = provider(() => ({ status: 200, body: { id: "d1", status: "shutdown" } }));
		expect((await runloop.inspect("d1"))?.state).toBe("exited");
	});

	it("returns null on 404 (an answer) but throws on 500 (not an answer)", async () => {
		expect(await provider(() => ({ status: 404, body: {} })).runloop.inspect("gone")).toBeNull();
		await expect(
			provider(() => ({ status: 500, body: {} })).runloop.inspect("d1"),
		).rejects.toMatchObject({ errorType: "transient" });
	});
});

describe("runloop.findByAttemptId — fails closed", () => {
	it("returns the live Devbox when one matches (client-side metadata filter)", async () => {
		const { runloop } = provider(() => ({
			status: 200,
			body: {
				devboxes: [
					{ id: "other", status: "running", metadata: { harbor_attempt: "att-2" } },
					{ id: "d1", status: "running", metadata: { harbor_attempt: "att-1" } },
				],
			},
		}));
		expect((await runloop.findByAttemptId("att-1"))?.externalId).toBe("d1");
	});

	it("returns null when Runloop answers with no match", async () => {
		expect(
			await provider(() => ({ status: 200, body: { devboxes: [] } })).runloop.findByAttemptId(
				"att-x",
			),
		).toBeNull();
	});

	it("THROWS rather than returning null when Runloop is unreachable", async () => {
		const throwing = runloopProvider({
			apiKey: "k",
			fetch: (async () => {
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch,
		});
		await expect(throwing.findByAttemptId("att-1")).rejects.toMatchObject({
			errorType: "transient",
		});
	});

	it("THROWS transient on a 5xx list rather than returning null", async () => {
		await expect(
			provider(() => ({ status: 503, body: {} })).runloop.findByAttemptId("att-1"),
		).rejects.toMatchObject({ errorType: "transient" });
	});
});

describe("runloop.stop — idempotent", () => {
	it("reports stopped, absent and already_stopped without throwing", async () => {
		expect(
			await provider(() => ({ status: 200, body: { id: "d1", status: "shutdown" } })).runloop.stop(
				"d1",
			),
		).toBe("stopped");
		expect(await provider(() => ({ status: 404, body: {} })).runloop.stop("gone")).toBe("absent");
		expect(
			await provider(() => ({ status: 400, body: { message: "devbox already shutdown" } })).runloop.stop(
				"d1",
			),
		).toBe("already_stopped");
	});

	it("shuts down via the /shutdown path", async () => {
		const { runloop, calls } = provider(() => ({ status: 200, body: { id: "d1" } }));
		await runloop.stop("d1");
		expect(calls[0]!.method).toBe("POST");
		expect(calls[0]!.url).toContain("/v1/devboxes/d1/shutdown");
	});
});

describe("runloop.listManaged — fails closed", () => {
	it("returns only live managed boxes and throws when unreachable", async () => {
		const { runloop } = provider(() => ({
			status: 200,
			body: {
				devboxes: [
					{ id: "d1", status: "running", metadata: { harbor_managed: "true" } },
					{ id: "d2", status: "shutdown", metadata: { harbor_managed: "true" } },
					{ id: "d3", status: "running", metadata: {} },
				],
			},
		}));
		const managed = await runloop.listManaged();
		expect(managed.map((i) => i.externalId)).toEqual(["d1"]);

		const throwing = runloopProvider({
			apiKey: "k",
			fetch: (async () => {
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch,
		});
		await expect(throwing.listManaged()).rejects.toMatchObject({ errorType: "transient" });
	});
});

/**
 * A page that does not contain the whole fleet must not be reported as one.
 *
 * `has_more` was on the response type from the start and read nowhere, so both
 * reconciliation reads treated page one as the complete answer. That is authority
 * failing OPEN wearing a disguise: `findByAttemptId` returning `null` because the
 * box was on page two starts a second agent on the same branch, and `listManaged`
 * missing it leaves a Devbox running until somebody reads the invoice.
 */
describe("runloop pagination — a truncated list is not an answer", () => {
	const truncated = () => ({
		status: 200,
		body: { devboxes: [{ id: "dbx-1", status: "running", metadata: {} }], has_more: true },
	});

	it("THROWS rather than reporting absent when the page is truncated", async () => {
		await expect(provider(truncated).runloop.findByAttemptId("att-1")).rejects.toMatchObject({
			errorType: "transient",
		});
	});

	it("THROWS rather than reporting no orphans when the page is truncated", async () => {
		await expect(provider(truncated).runloop.listManaged()).rejects.toMatchObject({
			errorType: "transient",
		});
	});

	it("names the variable that fixes it", async () => {
		await expect(provider(truncated).runloop.listManaged()).rejects.toThrow(
			/RUNLOOP_LIST_LIMIT/,
		);
	});

	it("treats has_more:false as a complete answer", async () => {
		const { runloop } = provider(() => ({
			status: 200,
			body: { devboxes: [], has_more: false },
		}));
		expect(await runloop.findByAttemptId("att-1")).toBeNull();
	});

	it("treats a bare array as complete — no envelope means no pagination", async () => {
		const { runloop } = provider(() => ({ status: 200, body: [] }));
		expect(await runloop.listManaged()).toEqual([]);
	});
});
