// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Adding a connector is one file and one line here.
 *
 * That is the entire extensibility story, and it is deliberate. If each connector
 * were its own deployable service, "we also use Jira" would mean writing a
 * service, provisioning it and adding it to the on-call rotation — a cost few
 * teams pay, which is why that shape tends to ship three connectors forever. Here
 * it means implementing the `Connector` interface and adding a line below, and
 * the result runs inside the app the operator already has running.
 *
 * Lookup is nullable because persisted connector rows outlive implementations: a
 * row for a connector that has been removed from a build must not turn webhook
 * ingest into a 500 for every other connector sharing the route.
 */

import { githubConnector } from "./github.js";
import { gitlabConnector } from "./gitlab.js";
import { linearConnector } from "./linear.js";
import { slackConnector } from "./slack.js";
import type { Connector } from "./types.js";

const CONNECTORS: Connector[] = [githubConnector, gitlabConnector, linearConnector, slackConnector];

export function connectorFor(type: string): Connector | null {
	return CONNECTORS.find((connector) => connector.type === type) ?? null;
}

/** Every connector, for the `/connectors` page and for generating CONNECTORS.md. */
export function allConnectors(): readonly Connector[] {
	return CONNECTORS;
}
