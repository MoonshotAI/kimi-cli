/**
 * YOLO mode dynamic injection — corresponds to Python soul/dynamic_injections/yolo_mode.py
 * Injects a one-time reminder when yolo mode is active.
 */

import type { Message } from "../../types.ts";
import type { KimiSoul } from "../kimisoul.ts";
import type {
	DynamicInjection,
	DynamicInjectionProvider,
} from "../dynamic_injection.ts";

const YOLO_INJECTION_TYPE = "yolo_mode";

const YOLO_PROMPT =
	"You are running in non-interactive mode. The user cannot answer questions " +
	"or provide feedback during execution.\n" +
	"- Do NOT call AskUserQuestion. If you need to make a decision, make your " +
	"best judgment and proceed.\n" +
	"- For EnterPlanMode / ExitPlanMode, they will be auto-approved. You can use " +
	"them normally but expect no user feedback.";

export class YoloModeInjectionProvider implements DynamicInjectionProvider {
	private _injected = false;

	async getInjections(
		_history: readonly Message[],
		soul: KimiSoul,
	): Promise<DynamicInjection[]> {
		if (!soul.isYolo) {
			return [];
		}
		if (this._injected) {
			return [];
		}
		this._injected = true;
		return [{ type: YOLO_INJECTION_TYPE, content: YOLO_PROMPT }];
	}
}
