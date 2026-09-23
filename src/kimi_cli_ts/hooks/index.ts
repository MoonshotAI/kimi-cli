/**
 * Hooks barrel export — corresponds to Python hooks/__init__.py
 */

export {
	HOOK_EVENT_TYPES,
	type HookDef,
	type HookEventType,
} from "./config.ts";
export { HookEngine } from "./engine.ts";
export { type HookResult, runHook } from "./runner.ts";
