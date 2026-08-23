// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Modal provider, verified with an injected fake `ModalClient`.
 *
 * The shared provider-contract suite runs this backend against real Modal when
 * `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` are set; these tests cover the
 * account-free properties TypeScript cannot check — that the attempt id is
 * stamped as tags at create, that a missing token pair is `invalid_config` and
 * not `transient`, that reconciliation FAILS CLOSED (a connection error during a
 * list throws rather than returning `null`), and that `stop` is idempotent across
 * Modal's typed errors.
 *
 * Modal's SDK is gRPC, not REST, so the injected transport is a fake object
 * shaped like `ModalClient` (only the methods the provider calls) rather than a
 * fake `fetch`, and error cases use Modal's real exported error classes so the
 * provider's `instanceof` ladder is exercised for real.
 */

import { NotFoundError } from "modal";
import type { ModalClient } from "modal";
import { describe, expect, it } from "vitest";
import type { CreateSandboxConfig } from "../provider.js";
import { modalProvider } from "./modal.js";

/** A fake Sandbox: only the members the provider touches. */
interface FakeSandbox {
	sandboxId: string;
	setTags: (tags: Record<string, string>) => Promise<void>;
	getTags: () => Promise<Record<string, string>>;
	poll: () => Promise<number | null>;
	terminate: () => Promise<void>;
}

function fakeSandbox(over: Partial<FakeSandbox> & { sandboxId: string }): FakeSandbox {
	return {
		setTags: async () => {},
		getTags: async () => ({}),
		poll: async () => null,
		terminate: async () => {},
		...over,
	};
}

/**
 * A fake `ModalClient`. Each service method is overridable per test; the defaults
 * are the happy path. Records the create call so a test can assert on the tags.
 */
function fakeClient(over: {
	create?: (params: { tags?: Record<string, string>; command?: string[]; env?: Record<string, string> }) => Promise<FakeSandbox>;
	fromId?: (id: string) => Promise<FakeSandbox>;
	list?: (params: { tags?: Record<string, string> }) => AsyncGenerator<FakeSandbox, void, unknown>;
} = {}) {
	const createCalls: { params: { tags?: Record<string, string>; command?: string[]; env?: Record<string, string> } }[] = [];
	const client = {
		apps: {
			fromName: async () => ({ appId: "ap-1", name: "harbor" }),
		},
		images: {
			fromRegistry: () => ({ imageId: "im-1" }),
		},
		sandboxes: {
			create: async (
				_app: unknown,
				_image: unknown,
				params: { tags?: Record<string, string>; command?: string[]; env?: Record<string, string> },
			) => {
				createCalls.push({ params });
				return over.create
					? await over.create(params)
					: fakeSandbox({ sandboxId: "sb-new" });
			},
			fromId: over.fromId ?? (async (id: string) => fakeSandbox({ sandboxId: id })),
			list:
				over.list ??
				(async function* () {
					/* empty by default */
				}),
		},
	};
	return { client: client as unknown as ModalClient, createCalls };
}

async function* generate(...boxes: FakeSandbox[]): AsyncGenerator<FakeSandbox, void, unknown> {
	for (const box of boxes) yield box;
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

describe("modal.create", () => {
	it("creates a sandbox, stamps the attempt id as tags, and returns its id", async () => {
		let stamped: Record<string, string> | undefined;
		const { client, createCalls } = fakeClient({
			create: async (params) => {
				stamped = params.tags;
				return fakeSandbox({
					sandboxId: "sb-abc",
					// Also assert the belt-and-suspenders setTags fires with the attempt id.
					setTags: async (tags) => {
						expect(tags.harbor_attempt).toBe("att-1");
					},
				});
			},
		});
		const modal = modalProvider({ client });

		const created = await modal.create(config());
		expect(created.externalId).toBe("sb-abc");
		expect(created.provider).toBe("modal");
		expect(created.state).toBe("running");

		// Tags carried on the create call itself — the reconciliation contract.
		expect(stamped?.harbor_attempt).toBe("att-1");
		expect(stamped?.harbor_managed).toBe("true");
		expect(stamped?.harbor_session).toBe("sess-1");
		expect(createCalls[0]?.params.env?.HARBOR_CONTROL_URL).toBe("https://cp.example");
	});

	it("classifies an invalid image reference as invalid_config, not transient", async () => {
		const { client } = fakeClient({
			create: async () => {
				const { InvalidError } = await import("modal");
				throw new InvalidError("bad registry tag");
			},
		});
		await expect(modalProvider({ client }).create(config())).rejects.toMatchObject({
			name: "SandboxProviderError",
			errorType: "invalid_config",
		});
	});

	it("classifies an auth failure as unauthorized", async () => {
		const { client } = fakeClient({
			create: async () => {
				throw new Error("UNAUTHENTICATED: invalid token id");
			},
		});
		await expect(modalProvider({ client }).create(config())).rejects.toMatchObject({
			errorType: "unauthorized",
		});
	});

	it("refuses a create with no token pair, as invalid_config", async () => {
		// No injected client and no env: the credential resolver must throw.
		const prevId = process.env.MODAL_TOKEN_ID;
		const prevSecret = process.env.MODAL_TOKEN_SECRET;
		delete process.env.MODAL_TOKEN_ID;
		delete process.env.MODAL_TOKEN_SECRET;
		try {
			await expect(modalProvider().create(config())).rejects.toMatchObject({
				errorType: "invalid_config",
			});
		} finally {
			if (prevId !== undefined) process.env.MODAL_TOKEN_ID = prevId;
			if (prevSecret !== undefined) process.env.MODAL_TOKEN_SECRET = prevSecret;
		}
	});
});

describe("modal.inspect", () => {
	it("round-trips tags and reports running while poll() is null", async () => {
		const { client } = fakeClient({
			fromId: async (id) =>
				fakeSandbox({
					sandboxId: id,
					poll: async () => null,
					getTags: async () => ({ harbor_attempt: "att-1", harbor_session: "sess-1" }),
				}),
		});
		const found = await modalProvider({ client }).inspect("sb-1");
		expect(found?.state).toBe("running");
		expect(found?.attemptId).toBe("att-1");
		expect(found?.sessionId).toBe("sess-1");
		expect(found?.exitCode).toBeNull();
	});

	it("reports exited with the poll() exit code", async () => {
		const { client } = fakeClient({
			fromId: async (id) => fakeSandbox({ sandboxId: id, poll: async () => 137 }),
		});
		const found = await modalProvider({ client }).inspect("sb-1");
		expect(found?.state).toBe("exited");
		expect(found?.exitCode).toBe(137);
	});

	it("returns null when Modal has no such sandbox (NotFoundError) but throws otherwise", async () => {
		const missing = fakeClient({
			fromId: async () => {
				throw new NotFoundError("no such sandbox");
			},
		});
		expect(await modalProvider({ client: missing.client }).inspect("gone")).toBeNull();

		const broken = fakeClient({
			fromId: async () => {
				throw new Error("UNAVAILABLE: control plane down");
			},
		});
		await expect(modalProvider({ client: broken.client }).inspect("sb-1")).rejects.toMatchObject({
			errorType: "transient",
		});
	});
});

describe("modal.findByAttemptId — fails closed", () => {
	it("returns the live sandbox when one matches", async () => {
		const { client } = fakeClient({
			list: () =>
				generate(
					fakeSandbox({
						sandboxId: "sb-1",
						poll: async () => null,
						getTags: async () => ({ harbor_attempt: "att-1" }),
					}),
				),
		});
		const found = await modalProvider({ client }).findByAttemptId("att-1");
		expect(found?.externalId).toBe("sb-1");
		expect(found?.attemptId).toBe("att-1");
	});

	it("returns null when Modal answers with an empty iteration", async () => {
		const { client } = fakeClient({ list: () => generate() });
		expect(await modalProvider({ client }).findByAttemptId("att-x")).toBeNull();
	});

	it("THROWS transient rather than returning null when Modal is unreachable", async () => {
		const { client } = fakeClient({
			list: () =>
				(async function* (): AsyncGenerator<FakeSandbox, void, unknown> {
					throw new Error("UNAVAILABLE: name resolution failed");
					// eslint-disable-next-line no-unreachable
					yield fakeSandbox({ sandboxId: "never" });
				})(),
		});
		await expect(modalProvider({ client }).findByAttemptId("att-1")).rejects.toMatchObject({
			errorType: "transient",
		});
	});
});

describe("modal.listManaged — fails closed", () => {
	it("returns only live managed boxes and throws when unreachable", async () => {
		const { client } = fakeClient({
			list: () =>
				generate(
					fakeSandbox({ sandboxId: "sb-live", poll: async () => null, getTags: async () => ({ harbor_managed: "true" }) }),
					fakeSandbox({ sandboxId: "sb-dead", poll: async () => 0, getTags: async () => ({ harbor_managed: "true" }) }),
				),
		});
		const managed = await modalProvider({ client }).listManaged();
		expect(managed.map((i) => i.externalId)).toEqual(["sb-live"]);

		const broken = fakeClient({
			list: () =>
				(async function* (): AsyncGenerator<FakeSandbox, void, unknown> {
					throw new Error("ECONNREFUSED");
					// eslint-disable-next-line no-unreachable
					yield fakeSandbox({ sandboxId: "never" });
				})(),
		});
		await expect(modalProvider({ client: broken.client }).listManaged()).rejects.toMatchObject({
			errorType: "transient",
		});
	});
});

describe("modal.stop — idempotent", () => {
	it("reports stopped, absent and already_stopped without throwing", async () => {
		const ok = fakeClient({ fromId: async (id) => fakeSandbox({ sandboxId: id }) });
		expect(await modalProvider({ client: ok.client }).stop("sb-1")).toBe("stopped");

		const gone = fakeClient({
			fromId: async () => {
				throw new NotFoundError("no such sandbox");
			},
		});
		expect(await modalProvider({ client: gone.client }).stop("gone")).toBe("absent");

		const already = fakeClient({
			fromId: async (id) =>
				fakeSandbox({
					sandboxId: id,
					terminate: async () => {
						throw new Error("sandbox already terminated");
					},
				}),
		});
		expect(await modalProvider({ client: already.client }).stop("sb-1")).toBe("already_stopped");
	});
});
