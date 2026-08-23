// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * CodeSandbox provider, verified with an injected fake client.
 *
 * The shared provider-contract suite runs this backend against real CodeSandbox when
 * `CSB_API_KEY` is set; these tests cover the account-free properties TypeScript
 * cannot check — that the attempt id round-trips through the flat `tags` list, that a
 * lost connection during reconciliation throws rather than returning `null`, that a
 * "not found" is an answer and a "bad gateway" is not, and that the SDK's message-shaped
 * errors map to the circuit breaker's vocabulary (never defaulting a bad template to
 * transient).
 */

import { describe, expect, it } from "vitest";
import { SandboxProviderError } from "../provider.js";
import type { CreateSandboxConfig } from "../provider.js";
import { codesandboxProvider } from "./codesandbox.js";
import type { CodeSandboxClient } from "./codesandbox.js";

type Box = { id: string; tags: string[]; createdAt?: Date; bootupType?: string };

interface Overrides {
	create?: (opts: unknown) => Promise<Box>;
	shutdown?: (id: string) => Promise<void>;
	get?: (id: string) => Promise<Box>;
	list?: (opts: unknown) => Promise<{ sandboxes: Box[] }>;
	listRunning?: () => Promise<{ vms: Array<{ id?: string }> }>;
	/** Force the data-plane connect (env delivery) to fail. */
	connect?: () => Promise<never>;
}

function fakeClient(over: Overrides = {}) {
	const calls = {
		create: [] as unknown[],
		shutdown: [] as string[],
		get: [] as string[],
		list: [] as unknown[],
		// Records the session env and the launched boot command — the env-delivery path.
		boot: [] as Array<{ sessionEnv?: Record<string, string>; command: unknown; opts: unknown }>,
	};
	/** Decorate a fake box with the `connect` seam the provider uses to boot the agent. */
	const withConnect = (box: Box) => ({
		...box,
		connect: async (session?: { env?: Record<string, string> }) => {
			if (over.connect) await over.connect();
			return {
				commands: {
					runBackground: async (command: unknown, opts: unknown) => {
						calls.boot.push({ sessionEnv: session?.env, command, opts });
						return { status: "RUNNING" };
					},
				},
			};
		},
	});
	const client: CodeSandboxClient = {
		sandboxes: {
			create: async (opts) => {
				calls.create.push(opts);
				return withConnect(
					over.create ? await over.create(opts) : { id: "sbx-new", tags: [], bootupType: "FORK" },
				);
			},
			resume: async (id) => withConnect({ id, tags: [], bootupType: "RESUME" }),
			hibernate: async () => {},
			shutdown: async (id) => {
				calls.shutdown.push(id);
				if (over.shutdown) await over.shutdown(id);
			},
			get: async (id) => {
				calls.get.push(id);
				return over.get ? over.get(id) : { id, tags: [] };
			},
			list: async (opts) => {
				calls.list.push(opts);
				return over.list ? over.list(opts) : { sandboxes: [] };
			},
			listRunning: async () => (over.listRunning ? over.listRunning() : { vms: [] }),
		},
	};
	return { client, calls };
}

function provider(over: Overrides = {}) {
	const { client, calls } = fakeClient(over);
	return { csb: codesandboxProvider({ client, apiKey: "csb-key" }), calls };
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

describe("codesandbox.create", () => {
	it("creates a sandbox, stamps the attempt id as a tag, and returns its id", async () => {
		const { csb, calls } = provider();
		const created = await csb.create(config());

		expect(created.externalId).toBe("sbx-new");
		expect(created.provider).toBe("codesandbox");
		// FORK boot re-runs the sandbox setup → still coming up.
		expect(created.state).toBe("starting");

		const opts = calls.create[0] as { id: string; tags: string[] };
		expect(opts.id).toBe("harbor-template");
		expect(opts.tags).toContain("harbor_attempt:att-1");
		expect(opts.tags).toContain("harbor_managed:true");
		expect(opts.tags).toContain("harbor_session:sess-1");
	});

	it("delivers config.env by connecting a session and launching the boot command", async () => {
		const { csb, calls } = provider();
		await csb.create(config({ env: { HARBOR_CONTROL_URL: "https://cp.example", TOKEN: "t" } }));

		expect(calls.boot).toHaveLength(1);
		const boot = calls.boot[0]!;
		// The env reaches the VM through the session AND the launched command.
		expect(boot.sessionEnv).toMatchObject({ HARBOR_CONTROL_URL: "https://cp.example", TOKEN: "t" });
		expect(boot.opts).toMatchObject({
			env: { HARBOR_CONTROL_URL: "https://cp.example", TOKEN: "t" },
			asGlobalSession: true,
		});
		expect(boot.command).toBe("/harbor/boot");
	});

	it("uses config.command as the boot command when the caller supplies one", async () => {
		const { csb, calls } = provider();
		await csb.create(config({ command: ["/usr/bin/agent", "--serve"] }));
		expect(calls.boot[0]!.command).toEqual(["/usr/bin/agent", "--serve"]);
	});

	it("does not touch the data plane when there is no env and no command", async () => {
		const { csb, calls } = provider();
		await csb.create(config({ env: {} }));
		expect(calls.boot).toHaveLength(0);
	});

	it("fails the create when env delivery cannot connect", async () => {
		const broken = provider({
			connect: async () => {
				throw new Error("fetch failed");
			},
		});
		await expect(broken.csb.create(config())).rejects.toMatchObject({
			name: "SandboxProviderError",
			errorType: "transient",
		});
	});

	it("maps a bad template to invalid_config and an auth failure to unauthorized", async () => {
		const bad = provider({
			create: async () => {
				throw new Error("Failed to create sandbox: invalid template reference");
			},
		});
		await expect(bad.csb.create(config())).rejects.toMatchObject({
			name: "SandboxProviderError",
			errorType: "invalid_config",
		});

		const unauth = provider({
			create: async () => {
				throw new Error("Failed to create sandbox: Unauthorized");
			},
		});
		await expect(unauth.csb.create(config())).rejects.toMatchObject({ errorType: "unauthorized" });
	});

	it("refuses a create with no api key and no injected client, as invalid_config", async () => {
		const saved = process.env.CSB_API_KEY;
		delete process.env.CSB_API_KEY;
		try {
			const noKey = codesandboxProvider();
			await expect(noKey.create(config())).rejects.toMatchObject({ errorType: "invalid_config" });
		} finally {
			if (saved !== undefined) process.env.CSB_API_KEY = saved;
		}
	});
});

describe("codesandbox.inspect", () => {
	it("round-trips tags and marks a running box running", async () => {
		const { csb } = provider({
			get: async (id) => ({ id, tags: ["harbor_attempt:att-1", "harbor_session:sess-1"] }),
			listRunning: async () => ({ vms: [{ id: "s1" }] }),
		});
		const found = await csb.inspect("s1");
		expect(found?.state).toBe("running");
		expect(found?.attemptId).toBe("att-1");
		expect(found?.sessionId).toBe("sess-1");
	});

	it("returns null on not-found (an answer) but throws transient on a 5xx (not an answer)", async () => {
		const gone = provider({
			get: async () => {
				throw new Error("Failed to get sandbox gone: Sandbox not found");
			},
		});
		expect(await gone.csb.inspect("gone")).toBeNull();

		const down = provider({
			get: async () => {
				throw new Error("Failed to get sandbox s1: Bad gateway");
			},
		});
		await expect(down.csb.inspect("s1")).rejects.toMatchObject({ errorType: "transient" });
	});
});

describe("codesandbox.findByAttemptId — fails closed", () => {
	it("returns the live sandbox when one matches", async () => {
		const { csb } = provider({
			list: async () => ({
				sandboxes: [{ id: "s1", tags: ["harbor_attempt:att-1", "harbor_managed:true"] }],
			}),
		});
		expect((await csb.findByAttemptId("att-1"))?.externalId).toBe("s1");
	});

	it("returns null when CodeSandbox answers with no match", async () => {
		const { csb } = provider({ list: async () => ({ sandboxes: [] }) });
		expect(await csb.findByAttemptId("att-x")).toBeNull();
	});

	it("THROWS transient rather than returning null when CodeSandbox is unreachable", async () => {
		const { csb } = provider({
			list: async () => {
				throw new Error("fetch failed");
			},
		});
		await expect(csb.findByAttemptId("att-1")).rejects.toMatchObject({ errorType: "transient" });
	});
});

describe("codesandbox.stop — idempotent", () => {
	it("reports stopped, absent and already_stopped without throwing", async () => {
		expect(await provider().csb.stop("s1")).toBe("stopped");

		const absent = provider({
			shutdown: async () => {
				throw new Error("Failed to hibernate VM s1: Sandbox not found");
			},
		});
		expect(await absent.csb.stop("gone")).toBe("absent");

		const already = provider({
			shutdown: async () => {
				throw new Error("VM is already hibernated");
			},
		});
		expect(await already.csb.stop("s1")).toBe("already_stopped");
	});
});

describe("codesandbox.listManaged — fails closed", () => {
	it("returns only managed boxes and throws when unreachable", async () => {
		const { csb } = provider({
			list: async () => ({
				sandboxes: [
					{ id: "s1", tags: ["harbor_managed:true", "harbor_attempt:att-1"] },
					{ id: "s2", tags: ["sdk"] },
				],
			}),
		});
		const managed = await csb.listManaged();
		expect(managed.map((i) => i.externalId)).toEqual(["s1"]);

		const down = provider({
			list: async () => {
				throw new Error("ECONNREFUSED");
			},
		});
		await expect(down.csb.listManaged()).rejects.toMatchObject({ errorType: "transient" });
	});
});
