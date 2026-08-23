// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Trigger-source verification and normalization. Pure functions, so zero mocks
 * and exact boundaries — the same discipline as the cron and condition suites,
 * and for the same reason: these decide whether an unauthenticated caller can
 * start a session, so an off-by-one in the signature check is a spawn primitive.
 */

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { webhookSource } from "./webhook.js";
import { sentrySource } from "./sentry.js";

const secret = "a-signing-secret-at-least-16-chars";

function sign(body: string, key = secret): string {
	return createHmac("sha256", key).update(body).digest("hex");
}

describe("webhook source: verify", () => {
	const body = JSON.stringify({ branch: "main", title: "Nightly" });

	it("accepts a correct sha256 signature over the raw body", () => {
		const headers = { "x-harbor-signature": `sha256=${sign(body)}` };
		expect(webhookSource.verify(body, headers, secret)).toBe(true);
	});

	it("rejects a signature computed over different bytes", () => {
		const headers = { "x-harbor-signature": `sha256=${sign(body)}` };
		// One trailing space: the classic re-serialisation gap. Must fail.
		expect(webhookSource.verify(`${body} `, headers, secret)).toBe(false);
	});

	it("rejects the wrong secret, a missing header and a non-hex signature", () => {
		const headers = { "x-harbor-signature": `sha256=${sign(body)}` };
		expect(webhookSource.verify(body, headers, "wrong-secret-value")).toBe(false);
		expect(webhookSource.verify(body, {}, secret)).toBe(false);
		expect(webhookSource.verify(body, { "x-harbor-signature": "sha256=nope" }, secret)).toBe(false);
		expect(webhookSource.verify(body, { "x-harbor-signature": sign(body) }, secret)).toBe(false);
	});
});

describe("webhook source: normalize", () => {
	it("extracts the documented convention fields", () => {
		const subject = webhookSource.normalize({
			ref: "refs/heads/release",
			target_branch: "main",
			labels: ["urgent", "backend"],
			files: ["src/api/a.ts", "src/api/b.ts"],
			author: "rin",
			title: "Fix the retry storm",
		});
		expect(subject).toEqual({
			branch: "release",
			targetBranch: "main",
			labels: ["urgent", "backend"],
			paths: ["src/api/a.ts", "src/api/b.ts"],
			author: "rin",
			title: "Fix the retry storm",
		});
	});

	it("trusts a pre-normalized `subject` escape hatch and ignores stray keys", () => {
		const subject = webhookSource.normalize({
			subject: { branch: "feature", labels: ["x"] },
			author: "ignored-because-subject-present",
		});
		expect(subject.branch).toBe("feature");
		expect(subject.labels).toEqual(["x"]);
		expect(subject.author).toBeNull();
	});

	it("returns an empty subject for a non-object payload", () => {
		expect(webhookSource.normalize("not-an-object")).toEqual({});
	});
});

describe("sentry source: verify", () => {
	const body = JSON.stringify({ action: "created", data: { issue: { id: "1", title: "x" } } });

	it("accepts a correct signature and rejects the wrong secret", () => {
		const headers = { "sentry-hook-signature": sign(body) };
		expect(sentrySource.verify(body, headers, secret)).toBe(true);
		expect(sentrySource.verify(body, headers, "wrong-secret-value")).toBe(false);
		expect(sentrySource.verify(body, {}, secret)).toBe(false);
	});

	it("rejects a signed timestamp outside the replay window, in either direction", () => {
		const ts = 1_000_000; // seconds
		const headers = { "sentry-hook-signature": sign(body), "sentry-hook-timestamp": String(ts) };
		// Default window is 300s. A `now` far in the future of the stamp is stale…
		const late = new Date((ts + 10_000) * 1000);
		expect(sentrySource.verify(body, headers, secret, late)).toBe(false);
		// …and a stamp far in the future of `now` is rejected too (Math.abs).
		const early = new Date((ts - 10_000) * 1000);
		expect(sentrySource.verify(body, headers, secret, early)).toBe(false);
		// Inside the window with a valid signature verifies.
		const inWindow = new Date((ts + 10) * 1000);
		expect(sentrySource.verify(body, headers, secret, inWindow)).toBe(true);
	});
});

describe("sentry source: normalize", () => {
	it("folds the event type, level, project and resource into labels", () => {
		const subject = sentrySource.normalize({
			action: "created",
			data: {
				issue: {
					id: "42",
					title: "TypeError: undefined is not a function",
					level: "error",
					culprit: "app/handler.ts in handle",
					project: { slug: "web" },
				},
			},
		});
		expect(subject.title).toBe("TypeError: undefined is not a function");
		expect(subject.author).toBe("app/handler.ts in handle");
		expect(subject.labels).toEqual(
			expect.arrayContaining(["action:created", "resource:issue", "level:error", "project:web"]),
		);
	});

	it("labels a metric alert distinctly", () => {
		const subject = sentrySource.normalize({
			action: "critical",
			data: { metric_alert: { title: "Error rate high" } },
		});
		expect(subject.title).toBe("Error rate high");
		expect(subject.labels).toEqual(
			expect.arrayContaining(["action:critical", "resource:metric_alert"]),
		);
	});
});

describe("sentry source: deliveryId", () => {
	it("prefers the event id, then the issue id, then the top-level id", () => {
		expect(
			sentrySource.deliveryId({ data: { event: { event_id: "evt" }, issue: { id: "iss" } } }, {}),
		).toBe("evt");
		expect(sentrySource.deliveryId({ data: { issue: { id: "iss" } } }, {})).toBe("iss");
		expect(sentrySource.deliveryId({ id: "top" }, {})).toBe("top");
	});
});
