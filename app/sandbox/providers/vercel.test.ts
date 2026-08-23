// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Vercel provider, verified with an injected `sandboxApi` seam (no network, no
 * real `@vercel/sandbox`).
 *
 * The shared provider-contract suite runs this backend against real Vercel when
 * the `VERCEL_*` credentials are set; these tests cover the account-free
 * properties TypeScript cannot check — that the attempt id round-trips through a
 * tag (and the box name), that a lost connection during reconciliation THROWS
 * rather than returning `null`, that a 404 is an answer and a 500 is not, that
 * stop is idempotent, and that SDK error statuses map to the circuit breaker's
 * vocabulary.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxProviderError } from "../provider.js";
import type { CreateSandboxConfig } from "../provider.js";
import {
	type VercelProviderOptions,
	type VercelSandboxApi,
	type VercelSandboxHandle,
	vercelProvider,
} from "./vercel.js";

/** An error shaped like the SDK's `APIError`: it carries `.response.status`. */
function apiError(status: number, message = "vercel says no"): Error {
	const err = new Error(message) as Error & { response: { status: number } };
	err.response = { status };
	return err;
}

/** A listed sandbox as `Sandbox.list` returns it — no `stop`, `createdAt` a number. */
type ListItem = {
	name: string;
	status: string;
	tags?: Record<string, string>;
	createdAt?: Date | number;
};

type ApiOverrides = {
	create?: (params: Record<string, unknown>) => Promise<VercelSandboxHandle>;
	get?: (params: Record<string, unknown>) => Promise<VercelSandboxHandle>;
	list?: (params: Record<string, unknown>) => Promise<ListItem[]>;
};

function fakeApi(overrides: ApiOverrides) {
	const calls = {
		create: [] as Record<string, unknown>[],
		get: [] as Record<string, unknown>[],
		list: [] as Record<string, unknown>[],
	};
	const api: VercelSandboxApi = {
		async create(params) {
			calls.create.push(params);
			if (!overrides.create) throw new Error("unexpected create");
			return overrides.create(params);
		},
		async get(params) {
			calls.get.push(params);
			if (!overrides.get) throw new Error("unexpected get");
			return overrides.get(params);
		},
		async list(params) {
			calls.list.push(params);
			const items = overrides.list ? await overrides.list(params) : [];
			return { toArray: async () => items };
		},
	};
	return { api, calls };
}

function provider(overrides: ApiOverrides, extra: Partial<VercelProviderOptions> = {}) {
	const { api, calls } = fakeApi(overrides);
	const vercel = vercelProvider({
		sandboxApi: api,
		token: "vt",
		teamId: "team_1",
		projectId: "prj_1",
		...extra,
	});
	return { vercel, calls };
}

const config = (over: Partial<CreateSandboxConfig> = {}): CreateSandboxConfig => ({
	sessionId: "sess-1",
	sandboxId: "sbx-1",
	attemptId: "att-1",
	image: "harbor-image",
	workspace: "/workspace",
	env: { HARBOR_CONTROL_URL: "https://cp.example" },
	timeoutMs: 60_000,
	features: {},
	...over,
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("vercel.create", () => {
	it("creates a sandbox, stamps the attempt id as a tag + name, and returns its external id", async () => {
		const { vercel, calls } = provider({
			create: async () => ({
				name: "harbor-att-1",
				status: "running",
				tags: { harbor_attempt: "att-1" },
				stop: async () => undefined,
			}),
		});
		const created = await vercel.create(config());
		expect(created.externalId).toBe("harbor-att-1");
		expect(created.provider).toBe("vercel");
		expect(created.state).toBe("running");
		expect(created.attemptId).toBe("att-1");

		const params = calls.create[0]!;
		expect(params.name).toBe("harbor-att-1");
		const tags = params.tags as Record<string, string>;
		expect(tags.harbor_attempt).toBe("att-1");
		expect(tags.harbor_managed).toBe("true");
		expect(tags.harbor_session).toBe("sess-1");
		// Credentials travel in every call's params object.
		expect(params.token).toBe("vt");
		expect(params.teamId).toBe("team_1");
		expect(params.projectId).toBe("prj_1");
		expect(params.image).toBe("harbor-image");
	});

	it("maps an SDK error status to the circuit vocabulary", async () => {
		const bad = provider({
			create: async () => {
				throw apiError(400, "bad image");
			},
		});
		await expect(bad.vercel.create(config())).rejects.toMatchObject({
			name: "SandboxProviderError",
			errorType: "invalid_config",
		});

		const unauth = provider({
			create: async () => {
				throw apiError(401);
			},
		});
		await expect(unauth.vercel.create(config())).rejects.toMatchObject({
			errorType: "unauthorized",
		});
	});

	it("refuses a create with a missing credential, as invalid_config", async () => {
		vi.stubEnv("VERCEL_TOKEN", "");
		vi.stubEnv("VERCEL_TEAM_ID", "");
		vi.stubEnv("VERCEL_PROJECT_ID", "");
		const { api } = fakeApi({ create: async () => ({ name: "x", status: "running", stop: async () => undefined }) });
		const noCreds = vercelProvider({ sandboxApi: api });
		await expect(noCreds.create(config())).rejects.toMatchObject({ errorType: "invalid_config" });
	});
});

describe("vercel.inspect", () => {
	it("round-trips tags and state", async () => {
		const { vercel } = provider({
			get: async () => ({
				name: "harbor-att-1",
				status: "running",
				tags: { harbor_attempt: "att-1", harbor_session: "sess-1" },
				createdAt: new Date("2026-08-13T00:00:00.000Z"),
				stop: async () => undefined,
			}),
		});
		const found = await vercel.inspect("harbor-att-1");
		expect(found?.state).toBe("running");
		expect(found?.attemptId).toBe("att-1");
		expect(found?.sessionId).toBe("sess-1");
		expect(found?.startedAt).toBe("2026-08-13T00:00:00.000Z");
	});

	it("returns null on 404 (an answer) but throws transient on 500 (not an answer)", async () => {
		const gone = provider({
			get: async () => {
				throw apiError(404);
			},
		});
		expect(await gone.vercel.inspect("harbor-gone")).toBeNull();

		const boom = provider({
			get: async () => {
				throw apiError(500);
			},
		});
		await expect(boom.vercel.inspect("harbor-att-1")).rejects.toMatchObject({
			errorType: "transient",
		});
	});
});

describe("vercel.findByAttemptId — fails closed", () => {
	it("returns the live sandbox when one matches", async () => {
		const { vercel } = provider({
			list: async () => [{ name: "harbor-att-1", status: "running", tags: { harbor_attempt: "att-1" } }],
		});
		const found = await vercel.findByAttemptId("att-1");
		expect(found?.externalId).toBe("harbor-att-1");
		expect(found?.state).toBe("running");
	});

	it("returns null when Vercel answers with no match", async () => {
		const { vercel } = provider({ list: async () => [] });
		expect(await vercel.findByAttemptId("att-x")).toBeNull();
	});

	it("THROWS transient rather than returning null when Vercel is unreachable", async () => {
		const { vercel } = provider({
			list: async () => {
				throw new Error("ECONNREFUSED");
			},
		});
		await expect(vercel.findByAttemptId("att-1")).rejects.toMatchObject({ errorType: "transient" });
	});

	it("THROWS transient on a 503 from the list call", async () => {
		const { vercel } = provider({
			list: async () => {
				throw apiError(503);
			},
		});
		await expect(vercel.findByAttemptId("att-1")).rejects.toMatchObject({ errorType: "transient" });
	});
});

describe("vercel.stop — idempotent", () => {
	it("reports stopped, absent and already_stopped without throwing", async () => {
		let stopped = false;
		const running = provider({
			get: async () => ({
				name: "harbor-att-1",
				status: "running",
				stop: async () => {
					stopped = true;
				},
			}),
		});
		expect(await running.vercel.stop("harbor-att-1")).toBe("stopped");
		expect(stopped).toBe(true);

		const gone = provider({
			get: async () => {
				throw apiError(404);
			},
		});
		expect(await gone.vercel.stop("harbor-gone")).toBe("absent");

		// Already terminal: short-circuit without calling stop().
		const terminal = provider({
			get: async () => ({
				name: "harbor-att-1",
				status: "stopped",
				stop: async () => {
					throw new Error("should not be called");
				},
			}),
		});
		expect(await terminal.vercel.stop("harbor-att-1")).toBe("already_stopped");

		// Raced to terminal between get and stop: stop() rejects with "already".
		const raced = provider({
			get: async () => ({
				name: "harbor-att-1",
				status: "running",
				stop: async () => {
					throw new Error("sandbox already stopped");
				},
			}),
		});
		expect(await raced.vercel.stop("harbor-att-1")).toBe("already_stopped");
	});
});

describe("vercel.listManaged — fails closed", () => {
	it("returns only live managed boxes and throws when unreachable", async () => {
		const { vercel } = provider({
			list: async () => [
				{ name: "harbor-a", status: "running", tags: { harbor_managed: "true" } },
				{ name: "harbor-b", status: "stopped", tags: { harbor_managed: "true" } },
			],
		});
		const managed = await vercel.listManaged();
		expect(managed.map((i) => i.externalId)).toEqual(["harbor-a"]);

		const throwing = provider({
			list: async () => {
				throw new Error("ECONNREFUSED");
			},
		});
		await expect(throwing.vercel.listManaged()).rejects.toMatchObject({ errorType: "transient" });
	});
});
