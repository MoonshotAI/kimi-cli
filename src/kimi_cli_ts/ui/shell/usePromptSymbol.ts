/**
 * usePromptSymbol.ts — Derives the prompt symbol from UI state.
 *
 * Matches Python's _render_agent_prompt_label logic:
 *   shell mode → "$"
 *   plan mode  → "📋"
 *   thinking model (capability flag, not streaming state) → "💫"
 *   otherwise  → "✨"
 */

import type { UIMode } from "./input-state.ts";

/** Compute the prompt symbol based on current mode and state. */
export function getPromptSymbol(
	mode: UIMode,
	shellMode: boolean,
	thinking: boolean,
	planMode: boolean,
): string {
	if (mode.type === "panel_input") return "▸ ";
	if (shellMode) return "$ ";
	if (planMode) return "📋 ";
	if (thinking) return "💫 ";
	return "✨ ";
}
