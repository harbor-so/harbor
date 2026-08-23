// SPDX-License-Identifier: LicenseRef-FSL-1.1-Apache-2.0
/**
 * Runtime → normalizer. Nullable for the same reason the connector registry is:
 * an unknown `[runtime]` segment must be a 404, not a 500.
 *
 * `conductor` runs Claude Code *or* Codex under the hood — it has no hook format of
 * its own, it just drives whichever binary is selected. Both of those binaries
 * speak the same PascalCase dialect (which is exactly why claude-code and codex
 * share `normalizeClaudeStyle`), so one parser covers a Conductor workspace no
 * matter which runtime it launched. The route still stamps `conductor` as the
 * stored runtime, so the dashboard can tell a Conductor session apart from a bare
 * Claude Code or Codex one.
 */

import { claudeCodeNormalizer } from "./claude-code.js";
import { codexNormalizer } from "./codex.js";
import { cursorNormalizer } from "./cursor.js";
import { devinNormalizer } from "./devin.js";
import { opencodeNormalizer } from "./opencode.js";
import type { ActivityNormalizer } from "./types.js";

export function normalizerFor(runtime: string): ActivityNormalizer | null {
	switch (runtime) {
		case "claude-code":
		case "conductor":
			return claudeCodeNormalizer;
		case "codex":
			return codexNormalizer;
		case "cursor":
			return cursorNormalizer;
		case "opencode":
			return opencodeNormalizer;
		case "devin":
			return devinNormalizer;
		default:
			return null;
	}
}
