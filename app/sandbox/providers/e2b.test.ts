// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * E2B provider, verified with an injected `fetch`.
 *
 * The shared provider-contract suite runs this backend against real E2B when
 * `E2B_API_KEY` is set; these tests cover the account-free properties — that a
 * lost connection during reconciliation throws rather than returning `null`, that
 * a 404 is an answer and a 500 is not, that the attempt id round-trips through
 * sandbox metadata, and that HTTP statuses map to the circuit breaker's
 * vocabulary. TypeScript cannot check any of those.
 */

import { describe, expect, it } from "vitest";
import { SandboxProviderError } from "../provider.js";
import type { CreateSandboxConfig } from "../provider.js";
import { e2bProvider } from "./e2b.js";

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
	return { e2b: e2bProvider({ fetch: impl, apiKey: "e2b-key", ...extra }), calls };
}

const config = (over: Partial<CreateSandboxConfig> = {}): CreateSandboxConfig => ({
	sessionId: "sess-1",
	sandboxId: "sbx-1",
	attemptId: "att-1",
	image: "harbor-template",
	workspace: "/workspace",
	env: { HARBOR_CONTROL_URL: "https://cp.example" },
	timeoutMs: 60_000,
	features: {},
	...over,
});

describe("e2b.create", () => {
	it("creates a sandbox, stamps the attempt id as metadata, and returns its id", async () => {
		const { e2b, calls } = provider((_url, init) => {
			expect(init.method).toBe("POST");
			return { status: 201, body: { sandboxID: "sbx-abc", state: "running" } };
		});
		const created = await e2b.create(config());
		expect(created.externalId).toBe("sbx-abc");
		expect(created.provider).toBe("e2b");
		expect(created.state).toBe("running");

		const sent = calls[0]!;
		expect(sent.url).toContain("/sandboxes");
		const body = sent.body as { templateID: string; metadata: Record<string, string> };
		expect(body.templateID).toBe("harbor-template");
		expect(body.metadata.harbor_attempt).toBe("att-1");
	});

	it("maps an E2B error status to the circuit vocabulary", async () => {
		const bad = provider(() => ({ status: 400, body: { message: "bad template" } }));
		await expect(bad.e2b.create(config())).rejects.toMatchObject({
			name: "SandboxProviderError",
			errorType: "invalid_config",
		});
		const unauth = provider(() => ({ status: 401, body: { message: "nope" } }));
		await expect(unauth.e2b.create(config())).rejects.toMatchObject({ errorType: "unauthorized" });
	});

	it("refuses a create with no api key, as invalid_config", async () => {
		const noKey = e2bProvider({ fetch: fakeFetch(() => ({ status: 200, body: {} })).impl });
		await expect(noKey.create(config())).rejects.toMatchObject({ errorType: "invalid_config" });
	});
});

describe("e2b.inspect", () => {
	it("round-trips metadata and state", async () => {
		const { e2b } = provider(() => ({
			status: 200,
			body: {
				sandboxID: "s1",
				state: "running",
				metadata: { harbor_attempt: "att-1", harbor_session: "sess-1" },
			},
		}));
		const found = await e2b.inspect("s1");
		expect(found?.state).toBe("running");
		expect(found?.attemptId).toBe("att-1");
		expect(found?.sessionId).toBe("sess-1");
	});

	it("returns null on 404 (an answer) but throws on 500 (not an answer)", async () => {
		expect(await provider(() => ({ status: 404, body: {} })).e2b.inspect("gone")).toBeNull();
		await expect(provider(() => ({ status: 500, body: {} })).e2b.inspect("s1")).rejects.toMatchObject({
			errorType: "transient",
		});
	});
});

describe("e2b.findByAttemptId — fails closed", () => {
	it("returns the live sandbox when one matches", async () => {
		const { e2b } = provider(() => ({
			status: 200,
			body: [{ sandboxID: "s1", state: "running", metadata: { harbor_attempt: "att-1" } }],
		}));
		expect((await e2b.findByAttemptId("att-1"))?.externalId).toBe("s1");
	});

	it("returns null when E2B answers with no match", async () => {
		expect(await provider(() => ({ status: 200, body: [] })).e2b.findByAttemptId("att-x")).toBeNull();
	});

	it("THROWS rather than returning null when E2B is unreachable", async () => {
		const throwing = e2bProvider({
			apiKey: "k",
			fetch: (async () => {
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch,
		});
		await expect(throwing.findByAttemptId("att-1")).rejects.toMatchObject({ errorType: "transient" });
	});
});

describe("e2b.stop — idempotent", () => {
	it("reports stopped, absent and already_stopped without throwing", async () => {
		expect(await provider(() => ({ status: 204, body: undefined })).e2b.stop("s1")).toBe("stopped");
		expect(await provider(() => ({ status: 404, body: {} })).e2b.stop("gone")).toBe("absent");
		expect(
			await provider(() => ({ status: 409, body: { message: "sandbox already killed" } })).e2b.stop("s1"),
		).toBe("already_stopped");
	});
});

describe("e2b.listManaged — fails closed", () => {
	it("returns only live managed boxes and throws when unreachable", async () => {
		const { e2b } = provider(() => ({
			status: 200,
			body: { sandboxes: [{ sandboxID: "s1", state: "running", metadata: { harbor_managed: "true" } }] },
		}));
		const managed = await e2b.listManaged();
		expect(managed.map((i) => i.externalId)).toEqual(["s1"]);

		const throwing = e2bProvider({
			apiKey: "k",
			fetch: (async () => {
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch,
		});
		await expect(throwing.listManaged()).rejects.toMatchObject({ errorType: "transient" });
	});
});

/**
 * The reconciliation query must not narrow to running boxes.
 *
 * `findByAttemptId` used to ask E2B for `?state=running`, which meant a box still
 * booting — the single most likely state for a box whose create response we lost —
 * came back as "no such sandbox". The caller reads that as permission to spawn,
 * and the result is two agents on one branch: the exact duplicate the whole
 * spawn saga exists to prevent.
 *
 * These assert the *query string*, because the bug lived there and nothing else
 * in the suite looks at it.
 */
describe("e2b reconciliation does not narrow server-side", () => {
	/**
	 * A stand-in that APPLIES `?state=` the way E2B would, instead of ignoring it.
	 *
	 * A handler that returns a canned list regardless of the query passes whether
	 * or not the provider narrows, which is why the original bug survived a suite
	 * that already had `findByAttemptId` coverage. Honouring the filter is what
	 * makes the behavioural test below able to fail.
	 */
	function filteringProvider(boxes: Array<Record<string, unknown>>) {
		return provider((url) => {
			const query = new URLSearchParams(url.slice(url.indexOf("?") + 1));
			const wanted = query.get("state");
			return {
				status: 200,
				body: wanted ? boxes.filter((b) => b.state === wanted) : boxes,
			};
		});
	}

	it("finds a box that is still STARTING", async () => {
		const { e2b } = filteringProvider([
			{ sandboxID: "sbx-booting", state: "starting", metadata: { harbor_attempt: "att-1" } },
		]);
		const found = await e2b.findByAttemptId("att-1");
		expect(found?.externalId).toBe("sbx-booting");
		expect(found?.state).toBe("starting");
	});

	it("does not send state=running when reconciling", async () => {
		const { e2b, calls } = provider(() => ({ status: 200, body: [] }));
		await e2b.findByAttemptId("att-1");
		expect(calls[0]!.url).not.toContain("state=running");
		expect(calls[0]!.url).toContain("harbor_attempt");
	});

	it("does not send state=running when listing managed boxes", async () => {
		const { e2b, calls } = provider(() => ({ status: 200, body: [] }));
		await e2b.listManaged();
		expect(calls[0]!.url).not.toContain("state=running");
	});

	it("still reports a wedged STARTING box to the orphan sweep", async () => {
		const { e2b } = filteringProvider([
			{ sandboxID: "sbx-wedged", state: "starting", metadata: { harbor_managed: "true" } },
		]);
		expect((await e2b.listManaged()).map((i) => i.externalId)).toEqual(["sbx-wedged"]);
	});
});
