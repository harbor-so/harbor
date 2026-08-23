// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Generate the outbound-writes table in CONNECTORS.md from the code.
 *
 * CONNECTORS.md is written for a security reviewer, and a security document that
 * drifts from the code is worse than none — it is a false assurance somebody
 * approved a deployment on. The prose is hand-written and stays that way; the
 * table of what each connector can write is generated, and `connectors-doc.test.ts`
 * fails the build when the file on disk disagrees with the registry.
 *
 * So the guarantee is not "somebody remembered to update the docs". It is that a
 * connector cannot gain an outbound capability without the document changing in
 * the same commit.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { allConnectors } from "@app/connectors/registry.js";

const START = "<!-- BEGIN GENERATED: outbound writes -->";
const END = "<!-- END GENERATED: outbound writes -->";

export function generateSection(): string {
	const lines: string[] = [START, ""];

	for (const connector of allConnectors()) {
		lines.push(`### ${connector.type}`, "");
		if (connector.outboundWrites.length === 0) {
			lines.push(
				"**Harbor writes nothing to this service through the connector.** Inbound sync only.",
				"",
			);
			continue;
		}
		lines.push("| Call | Scope needed | What it does | When |", "|---|---|---|---|");
		for (const write of connector.outboundWrites) {
			lines.push(
				`| \`${write.action}\` | \`${write.scope}\` | ${write.description.replace(/\s+/g, " ")} | ${write.triggeredBy.replace(/\s+/g, " ")} |`,
			);
		}
		lines.push("");
	}

	lines.push(END);
	return lines.join("\n");
}

export function applyToDoc(existing: string): string {
	const start = existing.indexOf(START);
	const end = existing.indexOf(END);
	if (start === -1 || end === -1) {
		throw new Error(
			`CONNECTORS.md is missing the ${START} / ${END} markers. They delimit the `
				+ "generated table; without them this script cannot tell what it may replace.",
		);
	}
	return existing.slice(0, start) + generateSection() + existing.slice(end + END.length);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const path = "CONNECTORS.md";
	writeFileSync(path, applyToDoc(readFileSync(path, "utf8")));
	console.log("CONNECTORS.md regenerated from the connector registry.");
}
