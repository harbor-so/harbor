// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Northflank provider, verified with an injected `fetch`.
 *
 * The shared provider-contract suite runs this backend against real Northflank
 * when `NORTHFLANK_API_TOKEN` and `NORTHFLANK_PROJECT_ID` are set; these tests
 * cover the account-free properties TypeScript cannot check — that the attempt id
 * is stamped into both the service name and the free-text `description` at create,
 * that a lost connection during reconciliation THROWS rather than returning
 * `null`/`[]`, that a 404 is an answer and a 500 is not, that the `{ data }` /
 * `{ error }` envelopes are read correctly, and that HTTP statuses map to the
 * circuit breaker's vocabulary.
 */

import { describe, expect, it } from "vitest";
import { SandboxProviderError } from "../provider.js";
import type { CreateSandboxConfig } from "../provider.js";
import { northflankProvider } from "./northflank.js";

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
		nf: northflankProvider({
			fetch: impl,
			token: "nf-token",
			projectId: "proj-1",
			...extra,
		}),
		calls,
	};
}

const config = (over: Partial<CreateSandboxConfig> = {}): CreateSandboxConfig => ({
	sessionId: "sess-1",
	sandboxId: "sbx-1",
	attemptId: "att-1",
	image: "docker.io/harbor/sandbox:latest",
	workspace: "/workspace",
	env: { HARBOR_CONTROL_URL: "https://cp.example" },
	timeoutMs: 60_000,
	features: {},
	...over,
});

/** A `{ data: { services: [...] }, pagination }` list envelope with no next page. */
const listBody = (services: unknown[]) => ({
	data: { services },
	pagination: { hasNextPage: false, cursor: "", count: services.length },
});

describe("northflank.create", () => {
	it("creates a service, stamps the attempt id in name + description, and returns the id", async () => {
		const { nf, calls } = provider((_url, init) => {
			expect(init.method).toBe("POST");
			return {
				status: 200,
				body: {
					data: {
						id: "harbor-att-1",
						name: "harbor-att-1",
						status: { deployment: { status: "COMPLETED", reason: "DEPLOYING" } },
					},
				},
			};
		});
		const created = await nf.create(config());
		expect(created.externalId).toBe("harbor-att-1");
		expect(created.provider).toBe("northflank");
		expect(created.state).toBe("running");

		const sent = calls[0]!;
		expect(sent.url).toContain("/v1/projects/proj-1/services/deployment");
		const body = sent.body as {
			name: string;
			description: string;
			deployment: { external: { imagePath: string } };
			runtimeEnvironment: Record<string, string>;
		};
		// Attempt id in the name (coarse marker)...
		expect(body.name).toBe("harbor-att-1");
		// ...and the FULL attempt id in the description (exact-match authority).
		expect(body.description.split("|")[0]).toBe("att-1");
		expect(body.deployment.external.imagePath).toBe("docker.io/harbor/sandbox:latest");
		expect(body.runtimeEnvironment.HARBOR_CONTROL_URL).toBe("https://cp.example");
	});

	it("sanitises and truncates a long / dirty attempt id into a legal service name", async () => {
		const { nf, calls } = provider(() => ({
			status: 200,
			body: { data: { id: "svc-x", name: "svc-x" } },
		}));
		await nf.create(config({ attemptId: "Attempt_ID/With.MESSY chars-" + "z".repeat(80) }));
		const body = calls[0]!.body as { name: string; description: string };
		expect(body.name.startsWith("harbor-")).toBe(true);
		expect(body.name.length).toBeLessThanOrEqual(54);
		// Northflank names must start with a letter and hold only [a-z0-9-].
		expect(body.name).toMatch(/^[a-z][a-z0-9-]*$/);
		expect(body.name.endsWith("-")).toBe(false);
		// The unmodified attempt id still survives in the description for matching.
		expect(body.description.startsWith("Attempt_ID/With.MESSY chars-")).toBe(true);
	});

	it("maps a Northflank error status to the circuit vocabulary", async () => {
		const bad = provider(() => ({
			status: 400,
			body: { error: { status: 400, message: "invalid image" } },
		}));
		await expect(bad.nf.create(config())).rejects.toMatchObject({
			name: "SandboxProviderError",
			errorType: "invalid_config",
		});
		const unauth = provider(() => ({ status: 401, body: { error: { message: "nope" } } }));
		await expect(unauth.nf.create(config())).rejects.toMatchObject({ errorType: "unauthorized" });
	});

	it("refuses a create with no api token, as invalid_config", async () => {
		const noToken = northflankProvider({
			projectId: "proj-1",
			fetch: fakeFetch(() => ({ status: 200, body: {} })).impl,
		});
		await expect(noToken.create(config())).rejects.toMatchObject({ errorType: "invalid_config" });
	});

	it("refuses a create with no project id, as invalid_config", async () => {
		const noProject = northflankProvider({
			token: "nf-token",
			fetch: fakeFetch(() => ({ status: 200, body: {} })).impl,
		});
		await expect(noProject.create(config())).rejects.toMatchObject({ errorType: "invalid_config" });
	});
});

describe("northflank.inspect", () => {
	it("round-trips the description metadata and deployment state", async () => {
		const { nf } = provider(() => ({
			status: 200,
			body: {
				data: {
					id: "harbor-att-1",
					name: "harbor-att-1",
					description: "att-1|sess-1|sbx-1",
					status: { deployment: { status: "COMPLETED" } },
				},
			},
		}));
		const found = await nf.inspect("harbor-att-1");
		expect(found?.state).toBe("running");
		expect(found?.attemptId).toBe("att-1");
		expect(found?.sessionId).toBe("sess-1");
		expect(found?.sandboxId).toBe("sbx-1");
	});

	it("returns null on 404 (an answer) but throws on 500 (not an answer)", async () => {
		expect(await provider(() => ({ status: 404, body: {} })).nf.inspect("gone")).toBeNull();
		await expect(
			provider(() => ({ status: 500, body: {} })).nf.inspect("s1"),
		).rejects.toMatchObject({ errorType: "transient" });
	});
});

describe("northflank.findByAttemptId — fails closed", () => {
	it("returns the live service whose description carries the attempt id", async () => {
		const { nf } = provider(() => ({
			status: 200,
			body: listBody([
				{
					id: "harbor-att-1",
					name: "harbor-att-1",
					description: "att-1|sess-1|sbx-1",
					status: { deployment: { status: "COMPLETED" } },
				},
			]),
		}));
		expect((await nf.findByAttemptId("att-1"))?.externalId).toBe("harbor-att-1");
	});

	it("returns null when Northflank answers with no match", async () => {
		const { nf } = provider(() => ({ status: 200, body: listBody([]) }));
		expect(await nf.findByAttemptId("att-x")).toBeNull();
	});

	it("ignores an unmanaged service that happens to mention the attempt id", async () => {
		const { nf } = provider(() => ({
			status: 200,
			body: listBody([
				// No harbor- name prefix → not ours, even with a matching description.
				{ id: "other", name: "some-app", description: "att-1|x|y", status: {} },
			]),
		}));
		expect(await nf.findByAttemptId("att-1")).toBeNull();
	});

	it("THROWS rather than returning null when Northflank is unreachable", async () => {
		const throwing = northflankProvider({
			token: "k",
			projectId: "p",
			fetch: (async () => {
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch,
		});
		await expect(throwing.findByAttemptId("att-1")).rejects.toMatchObject({
			errorType: "transient",
		});
	});

	it("THROWS on a 5xx list rather than returning null", async () => {
		const { nf } = provider(() => ({ status: 503, body: { error: { message: "down" } } }));
		await expect(nf.findByAttemptId("att-1")).rejects.toMatchObject({ errorType: "transient" });
	});
});

describe("northflank.stop — idempotent", () => {
	it("reports stopped, absent and already_stopped without throwing", async () => {
		expect(await provider(() => ({ status: 200, body: { data: {} } })).nf.stop("s1")).toBe(
			"stopped",
		);
		expect(await provider(() => ({ status: 404, body: {} })).nf.stop("gone")).toBe("absent");
		expect(
			await provider(() => ({
				status: 409,
				body: { error: { message: "service is already deleting" } },
			})).nf.stop("s1"),
		).toBe("already_stopped");
	});
});

describe("northflank.listManaged — fails closed", () => {
	it("returns only live managed services and throws when unreachable", async () => {
		const { nf } = provider(() => ({
			status: 200,
			body: listBody([
				{
					id: "harbor-att-1",
					name: "harbor-att-1",
					description: "att-1|sess-1|sbx-1",
					status: { deployment: { status: "COMPLETED" } },
				},
				// Not managed (no prefix) → excluded.
				{ id: "other", name: "billing-api", status: { deployment: { status: "COMPLETED" } } },
				// Managed but terminal → excluded (live only).
				{
					id: "harbor-dead",
					name: "harbor-dead",
					description: "att-2|s|b",
					status: { deployment: { status: "FAILURE" } },
				},
			]),
		}));
		const managed = await nf.listManaged();
		expect(managed.map((i) => i.externalId)).toEqual(["harbor-att-1"]);

		const throwing = northflankProvider({
			token: "k",
			projectId: "p",
			fetch: (async () => {
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch,
		});
		await expect(throwing.listManaged()).rejects.toMatchObject({ errorType: "transient" });
	});
});
