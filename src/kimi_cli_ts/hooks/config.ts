/**
 * Hook configuration — corresponds to Python hooks/config.py
 * HookDef and HookEventType are already defined in config.ts,
 * re-exported here for convenience.
 */

export { HookDef, HookEventType } from "../config.ts";

export const HOOK_EVENT_TYPES: string[] = [
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"UserPromptSubmit",
	"Stop",
	"StopFailure",
	"SessionStart",
	"SessionEnd",
	"SubagentStart",
	"SubagentStop",
	"PreCompact",
	"PostCompact",
	"Notification",
];
