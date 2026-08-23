// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * CONNECTORS.md must agree with the code.
 *
 * This is the test that makes `outboundWrites` a declaration rather than
 * documentation. A security document that drifts from the implementation is worse
 * than no document — it is a false assurance somebody approved a deployment on —
 * and "remember to update the docs" is not a mechanism.
 *
 * With this test, a connector cannot gain an outbound capability without
 * CONNECTORS.md changing in the same commit, because the build fails until it
 * does.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allConnectors } from "./registry.js";
import { generateSection } from "../../scripts/gen-connectors-doc.js";

describe("CONNECTORS.md", () => {
	const doc = readFileSync("CONNECTORS.md", "utf8");

	it("contains the generated section verbatim", () => {
		const expected = generateSection();
		if (!doc.includes(expected)) {
			throw new Error(
				"CONNECTORS.md does not match the connector registry.\n\n"
					+ "A connector's outbound capabilities changed and the security document did "
					+ "not. Run:\n\n    npm run docs:connectors\n\n"
					+ "and commit the result in the same commit as the code change.",
			);
		}
		expect(doc.includes(expected)).toBe(true);
	});

	/**
	 * Every connector has to say something, including "nothing". An empty
	 * `outboundWrites` on a connector that does in fact write is the failure this
	 * whole mechanism exists to prevent, and the only defence against it is that
	 * the absence is visible in the rendered table rather than being a missing row
	 * nobody notices.
	 */
	it("names every registered connector", () => {
		for (const connector of allConnectors()) {
			expect(doc).toContain(`### ${connector.type}`);
		}
	});

	/**
	 * The prose above the generated table makes specific claims. If somebody
	 * relaxes one of these in code, the claim here becomes a lie, and a reviewer
	 * has no way to know.
	 */
	it("still makes the claims the code has to keep", () => {
		expect(doc).toContain("raw bytes");
		expect(doc).toContain("five-minute window in **either** direction");
		expect(doc).toContain("Harbor never closes, assigns, labels or estimates");
		expect(doc).toContain("Every Slack message is a thread reply");
	});

	it("declares an explicit scope for every outbound call", () => {
		for (const connector of allConnectors()) {
			for (const write of connector.outboundWrites) {
				expect(write.scope.trim().length).toBeGreaterThan(0);
				// `triggeredBy` is what turns "can post messages" into a risk statement
				// somebody can evaluate. Without it the table says what is possible
				// rather than what happens, and only the second is useful.
				expect(write.triggeredBy.trim().length).toBeGreaterThan(20);
			}
		}
	});
});
