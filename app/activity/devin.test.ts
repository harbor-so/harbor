// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Pure normalizer tests: a captured Devin session (or one message, one status
 * pair) in, canonical rows out, no database. The poll loop's stateful, DB-backed
 * behaviour is tested separately in src/devin/poll.test.ts.
 */

import { describe, expect, it } from "vitest";
import {
	devinNormalizer,
	devinStatusOf,
	mapDevinMessage,
	mapDevinStatusTransition,
} from "./devin.js";

describe("devin message mapping", () => {
	it("maps a user message to a prompt", () => {
		const row = mapDevinMessage({ type: "user_message", message: "fix the flaky test" }, "devin-1");
		expect(row).toMatchObject({ kind: "prompt", runtimeSessionId: "devin-1" });
		expect(row.payload).toEqual({ text: "fix the flaky test" });
		expect(row.tool).toBeUndefined();
	});

	it("maps a Devin message to a coarse devin tool_call", () => {
		const row = mapDevinMessage({ type: "devin_message", message: "Running the suite now." }, "devin-1");
		expect(row).toMatchObject({ kind: "tool_call", tool: "devin", phase: "post", runtimeSessionId: "devin-1" });
		expect(row.payload).toEqual({ output: "Running the suite now." });
	});

	it("reads content under whichever key the payload used", () => {
		const row = mapDevinMessage({ role: "assistant", content: "done" }, "devin-1");
		expect(row.payload).toEqual({ output: "done" });
	});

	it("clips an overlong message body", () => {
		const row = mapDevinMessage({ type: "devin_message", message: "x".repeat(5000) }, "devin-1");
		expect((row.payload?.output as string).length).toBeLessThan(5000);
		expect(row.payload?.output).toContain("chars");
	});

	it("tolerates a message with no recognizable body", () => {
		const row = mapDevinMessage({ type: "devin_message" }, "devin-1");
		expect(row).toMatchObject({ kind: "tool_call", tool: "devin" });
		expect(row.payload).toEqual({});
	});
});

describe("devin status transitions", () => {
	it("opens with a session_start on first observation", () => {
		const rows = mapDevinStatusTransition(undefined, "working", "devin-1");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ kind: "session_start", payload: { status_enum: "working" } });
	});

	it("emits nothing when the status is unchanged", () => {
		expect(mapDevinStatusTransition("working", "working", "devin-1")).toHaveLength(0);
	});

	it("emits a stop when Devin starts waiting", () => {
		const rows = mapDevinStatusTransition("working", "blocked", "devin-1");
		expect(rows).toEqual([
			{ kind: "stop", runtimeSessionId: "devin-1", payload: { status_enum: "blocked" } },
		]);
	});

	it("emits a session_end with structured output on finish", () => {
		const rows = mapDevinStatusTransition("working", "finished", "devin-1", { pr: 42 });
		expect(rows).toEqual([
			{ kind: "session_end", runtimeSessionId: "devin-1", payload: { status_enum: "finished", structured_output: { pr: 42 } } },
		]);
	});

	it("emits both start and end for a first observation that is already finished", () => {
		const rows = mapDevinStatusTransition(undefined, "finished", "devin-1");
		expect(rows.map((r) => r.kind)).toEqual(["session_start", "session_end"]);
	});

	it("is silent on a resume back to working", () => {
		expect(mapDevinStatusTransition("waiting_for_user", "working", "devin-1")).toHaveLength(0);
	});
});

describe("devin whole-session normalize", () => {
	it("orders start, messages, then end", () => {
		const rows = devinNormalizer.normalize({
			session_id: "devin-1",
			status_enum: "finished",
			structured_output: { ok: true },
			messages: [
				{ type: "user_message", message: "go" },
				{ type: "devin_message", message: "working on it" },
			],
		});
		expect(rows.map((r) => r.kind)).toEqual(["session_start", "prompt", "tool_call", "session_end"]);
		expect(rows.every((r) => r.runtimeSessionId === "devin-1")).toBe(true);
	});

	it("returns nothing without a session id", () => {
		expect(devinNormalizer.normalize({ status_enum: "working" })).toHaveLength(0);
		expect(devinNormalizer.normalize("not an object")).toHaveLength(0);
	});

	it("falls back from status_enum to status", () => {
		expect(devinStatusOf({ status: "running" })).toBe("running");
		expect(devinStatusOf({ status_enum: "working", status: "running" })).toBe("working");
		expect(devinStatusOf({})).toBeUndefined();
	});
});
