// SPDX-License-Identifier: Apache-2.0
/**
 * URL resolution — pure functions over `process.env`, no database, no network.
 *
 * The empty-string cases are the reason this file exists. `.env.example` ships
 * keys with blank values, and an operator templating their environment from a
 * secret store routinely produces `HARBOR_PUBLIC_URL=` — which `??` treats as
 * configured and `||` does not. Slack used `??` and posted `/s/<key>` as a link.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_MCP_PORT,
	agentMcpUrl,
	linkBaseUrl,
	mcpUrl,
	publicUrl,
	requirePublicUrl,
	warnAboutAddressing,
} from "./urls.js";

// `vi.stubEnv` rather than assignment: Next's global.d.ts types `NODE_ENV` as
// read-only, and it also restores cleanly whatever the test did.
const KEYS = ["HARBOR_PUBLIC_URL", "HARBOR_MCP_URL", "HARBOR_AGENT_MCP_URL", "HARBOR_URL"] as const;

beforeEach(() => {
	for (const key of KEYS) vi.stubEnv(key, undefined);
	vi.stubEnv("NODE_ENV", "test");
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("publicUrl", () => {
	it("returns null when unset", () => {
		expect(publicUrl()).toBeNull();
	});

	it("returns null when set but BLANK — the shape .env.example ships", () => {
		vi.stubEnv("HARBOR_PUBLIC_URL", "");
		expect(publicUrl()).toBeNull();
		vi.stubEnv("HARBOR_PUBLIC_URL", "   ");
		expect(publicUrl()).toBeNull();
	});

	it("strips trailing slashes so callers can concatenate a path", () => {
		vi.stubEnv("HARBOR_PUBLIC_URL", "https://harbor.example.com///");
		expect(publicUrl()).toBe("https://harbor.example.com");
	});
});

describe("requirePublicUrl — fatal, with the container trap named", () => {
	it("throws when unset, and the message explains host.docker.internal", () => {
		expect(() => requirePublicUrl()).toThrow(/reachable FROM INSIDE a sandbox/);
		expect(() => requirePublicUrl()).toThrow(/host\.docker\.internal/);
	});

	it("throws on blank rather than returning an empty string", () => {
		vi.stubEnv("HARBOR_PUBLIC_URL", "");
		expect(() => requirePublicUrl()).toThrow(/HARBOR_PUBLIC_URL is not set/);
	});
});

describe("linkBaseUrl — degrades rather than throwing", () => {
	it("falls back to localhost when unset", () => {
		expect(linkBaseUrl()).toBe("http://localhost:3000");
	});

	it("falls back on BLANK too — the bug that produced a bare /s/<key> in Slack", () => {
		vi.stubEnv("HARBOR_PUBLIC_URL", "");
		expect(`${linkBaseUrl()}/s/abc`).toBe("http://localhost:3000/s/abc");
	});
});

describe("mcpUrl / agentMcpUrl", () => {
	it("defaults the coordination URL to the documented port", () => {
		expect(mcpUrl()).toBe(`http://localhost:${DEFAULT_MCP_PORT}/mcp`);
	});

	it("returns null for the agent surface when unset — no tools beats a hanging URL", () => {
		expect(agentMcpUrl()).toBeNull();
	});
});

describe("warnAboutAddressing", () => {
	it("warns when HARBOR_PUBLIC_URL is missing", () => {
		expect(warnAboutAddressing().join(" ")).toMatch(/HARBOR_PUBLIC_URL is not set/);
	});

	it("warns about a loopback address in production, where it cannot possibly work", () => {
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("HARBOR_PUBLIC_URL", "http://localhost:3000");
		expect(warnAboutAddressing().join(" ")).toMatch(/loopback address/i);
	});

	it("stays quiet about localhost outside production, which is the normal laptop case", () => {
		vi.stubEnv("HARBOR_PUBLIC_URL", "http://localhost:3000");
		expect(warnAboutAddressing()).toEqual([]);
	});

	it("stays quiet about a real public URL in production", () => {
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("HARBOR_PUBLIC_URL", "https://harbor.example.com");
		expect(warnAboutAddressing()).toEqual([]);
	});
});
