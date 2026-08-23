// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * The trigger-source registry — one array, one lookup.
 *
 * Adding an inbound source is a new file implementing `TriggerSource` plus one
 * line here, exactly like `src/connectors/registry.ts`. `sourceFor` returns null
 * for an unknown type rather than throwing, because a persisted automation row
 * can name a source an older or newer build does not implement, and a 404 is the
 * honest answer to "deliver to a source this deployment does not have".
 */

import type { TriggerSource } from "./types.js";
import { webhookSource } from "./webhook.js";
import { sentrySource } from "./sentry.js";

const SOURCES: TriggerSource[] = [webhookSource, sentrySource];

/** The set of sources an automation may be created with, for validation. */
export const TRIGGER_SOURCE_TYPES = SOURCES.map((source) => source.type);

export function sourceFor(type: string): TriggerSource | null {
	return SOURCES.find((source) => source.type === type) ?? null;
}
