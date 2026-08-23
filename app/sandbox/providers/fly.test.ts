// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Fly provider, verified with an injected `fetch`.
 *
 * The shared provider-contract suite runs this backend against real Fly when
 * `FLY_API_TOKEN` is set; these tests cover the properties that do not need an
 * account and would be expensive to reproduce against one — that a lost
 * connection during reconciliation throws rather than returning `null`, that a
 * 404 is an answer and a 500 is not, that the attempt id round-trips through
 * Machine metadata, and that HTTP statuses map to the circuit breaker's
 * vocabulary. TypeScript cannot check any of those.
 */

import { describe, expect, it } from "vitest";
import { SandboxProviderError } from "../provider.js";
import type { CreateSandboxConfig } from "../provider.js";
import { flyProvider } from "./fly.js";

type Reply = { status: number; body: unknown };
type Handler = (url: string, init: { method?: string; body?: string }) => Reply;

/** A fake `fetch` that records calls and replies from a handler. */
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
		fly: flyProvider({ fetch: impl, token: "fly-token", appName: "harbor-app", ...extra }),
		calls,
	};
}

const config = (over: Partial<CreateSandboxConfig> = {}): CreateSandboxConfig => ({
	sessionId: "sess-1",
	sandboxId: "sbx-1",
	attemptId: "att-1",
	image: "registry.fly.io/harbor-sandbox:latest",
	workspace: "/workspace",
	env: { HARBOR_CONTROL_URL: "https://cp.example" },
	timeoutMs: 60_000,
	features: {},
	...over,
});

describe("fly.create", () => {
	it("creates a Machine, stamps the attempt id as metadata, and returns its id", async () => {
		const { fly, calls } = provider((_url, init) => {
			expect(init.method).toBe("POST");
			return { status: 200, body: { id: "machine-abc", state: "created" } };
		});
		const created = await fly.create(config());
		expect(created.externalId).toBe("machine-abc");
		expect(created.provider).toBe("fly");
		expect(created.state).toBe("starting"); // "created" → starting

		const sent = calls[0]!;
		expect(sent.url).toContain("/v1/apps/harbor-app/machines");
		const body = sent.body as { config: { metadata: Record<string, string>; restart: { policy: string } } };
		expect(body.config.metadata.harbor_attempt).toBe("att-1");
		expect(body.config.restart.policy).toBe("no");
	});

	it("maps a Fly error status to the circuit vocabulary", async () => {
		const { fly } = provider(() => ({ status: 422, body: { error: "bad image" } }));
		await expect(fly.create(config())).rejects.toMatchObject({
			name: "SandboxProviderError",
			errorType: "invalid_config",
		});
		const unauth = provider(() => ({ status: 401, body: { error: "nope" } }));
		await expect(unauth.fly.create(config())).rejects.toMatchObject({ errorType: "unauthorized" });
	});

	it("refuses a create with no token or no app, as invalid_config", async () => {
		const noToken = flyProvider({ fetch: fakeFetch(() => ({ status: 200, body: {} })).impl, appName: "a" });
		await expect(noToken.create(config())).rejects.toMatchObject({ errorType: "invalid_config" });
	});
});

describe("fly.inspect", () => {
	it("normalises `started` to running and round-trips metadata", async () => {
		const { fly } = provider(() => ({
			status: 200,
			body: {
				id: "m1",
				state: "started",
				config: { metadata: { harbor_attempt: "att-1", harbor_session: "sess-1" } },
			},
		}));
		const found = await fly.inspect("m1");
		expect(found?.state).toBe("running");
		expect(found?.rawState).toBe("started");
		expect(found?.attemptId).toBe("att-1");
		expect(found?.sessionId).toBe("sess-1");
	});

	it("returns null on 404 (an answer) but throws on 500 (not an answer)", async () => {
		expect(await provider(() => ({ status: 404, body: {} })).fly.inspect("gone")).toBeNull();
		await expect(provider(() => ({ status: 500, body: {} })).fly.inspect("m1")).rejects.toMatchObject({
			errorType: "transient",
		});
	});
});

describe("fly.findByAttemptId — fails closed", () => {
	it("returns the live Machine when one matches", async () => {
		const { fly } = provider(() => ({
			status: 200,
			body: [
				{ id: "m1", state: "started", config: { metadata: { harbor_attempt: "att-1" } } },
			],
		}));
		const found = await fly.findByAttemptId("att-1");
		expect(found?.externalId).toBe("m1");
	});

	it("returns null when Fly answers with no match", async () => {
		expect(await provider(() => ({ status: 200, body: [] })).fly.findByAttemptId("att-x")).toBeNull();
	});

	it("THROWS rather than returning null when Fly is unreachable", async () => {
		const throwing = flyProvider({
			token: "t",
			appName: "a",
			fetch: (async () => {
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch,
		});
		await expect(throwing.findByAttemptId("att-1")).rejects.toMatchObject({ errorType: "transient" });
	});
});

/**
 * A Fly stand-in that STORES what `create` sent and serves `listManaged` from it,
 * honouring the `?metadata.<key>=<value>` filter in the URL.
 *
 * This shape, rather than a canned list fixture, is the whole point. A canned
 * fixture is written by the same person reading the same file, so they hand-write
 * `harbor_managed: "true"` into the response and the test passes whatever the
 * provider's read side actually filters on. That is exactly how `listManaged`
 * shipped writing `"true"` and querying `"1"` — returning `[]` for every Machine
 * Harbor had ever created — with a green suite. A store that only echoes back what
 * it was given cannot be fooled that way: if the two sides disagree, nothing comes
 * back, which is the real bug rather than a restatement of it.
 */
function statefulFly() {
	const machines: Array<{ id: string; state: string; config: Record<string, unknown> }> = [];
	let next = 1;
	const handler: Handler = (url, init) => {
		if ((init.method ?? "GET") === "POST") {
			const body = JSON.parse(init.body ?? "{}") as { config: Record<string, unknown> };
			const machine = { id: `m-${next++}`, state: "started", config: body.config };
			machines.push(machine);
			return { status: 200, body: machine };
		}
		// `?metadata.<key>=<value>` — apply it exactly as Fly would, so a provider
		// whose server-side query disagrees with its write side gets nothing back.
		const query = url.includes("?") ? new URLSearchParams(url.slice(url.indexOf("?") + 1)) : null;
		let matching = machines;
		for (const [key, value] of query ?? []) {
			if (!key.startsWith("metadata.")) continue;
			const metaKey = key.slice("metadata.".length);
			matching = matching.filter(
				(m) => (m.config.metadata as Record<string, string> | undefined)?.[metaKey] === value,
			);
		}
		return { status: 200, body: matching };
	};
	return provider(handler);
}

describe("fly.listManaged", () => {
	it("finds a Machine it just created — the write and read sides must agree", async () => {
		const { fly } = statefulFly();
		const created = await fly.create(config());

		const managed = await fly.listManaged();
		expect(managed.map((m) => m.externalId)).toEqual([created.externalId]);
		expect(managed[0]?.attemptId).toBe("att-1");
	});

	it("does not report a Machine some other tool created in the same app", async () => {
		const { fly } = provider(() => ({
			status: 200,
			body: [{ id: "not-ours", state: "started", config: { metadata: {} } }],
		}));
		expect(await fly.listManaged()).toEqual([]);
	});

	it("THROWS rather than returning [] when Fly is unreachable", async () => {
		const throwing = flyProvider({
			token: "t",
			appName: "a",
			fetch: (async () => {
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch,
		});
		await expect(throwing.listManaged()).rejects.toMatchObject({ errorType: "transient" });
	});

	it("THROWS rather than returning [] on a 500", async () => {
		await expect(provider(() => ({ status: 500, body: {} })).fly.listManaged()).rejects.toMatchObject({
			errorType: "transient",
		});
	});
});

describe("fly.stop — idempotent", () => {
	it("reports stopped, absent and already_stopped without throwing", async () => {
		expect(await provider(() => ({ status: 200, body: {} })).fly.stop("m1")).toBe("stopped");
		expect(await provider(() => ({ status: 404, body: {} })).fly.stop("gone")).toBe("absent");
		expect(
			await provider(() => ({ status: 412, body: { error: "machine already destroyed" } })).fly.stop("m1"),
		).toBe("already_stopped");
	});
});
