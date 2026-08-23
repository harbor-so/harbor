// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Claude Code posts its hook JSON straight to Harbor over a native `type:"http"`
 * hook — no forwarder script — so the raw payload arrives here unmodified. It also
 * covers Conductor, which runs Claude Code under the hood and inherits the same
 * committed `.claude/settings.json`; the route stamps `conductor` as the runtime
 * while this same parser reads the body.
 */

import { normalizeClaudeStyle } from "./claude-style.js";
import type { ActivityNormalizer } from "./types.js";

export const claudeCodeNormalizer: ActivityNormalizer = {
	runtime: "claude-code",
	normalize: normalizeClaudeStyle,
};
