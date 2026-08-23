// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Codex hooks run local commands only, so a tiny forwarder curls the stdin JSON
 * here. Codex uses the same PascalCase event dialect as Claude Code, so the
 * parsing is shared; the forwarder passes the event as a `?event=` query param
 * (surfaced via NormalizeContext) in case a given payload omits it.
 */

import { normalizeClaudeStyle } from "./claude-style.js";
import type { ActivityNormalizer } from "./types.js";

export const codexNormalizer: ActivityNormalizer = {
	runtime: "codex",
	normalize: normalizeClaudeStyle,
};
