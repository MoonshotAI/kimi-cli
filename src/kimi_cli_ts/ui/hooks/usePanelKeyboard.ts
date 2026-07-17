/**
 * usePanelKeyboard — keyboard handling hook for terminal TUI panels.
 *
 * Internally pushes onto the input stack via useInputLayer so the panel
 * captures all keyboard events while mounted.
 */

import { useRef } from "react";

import { useInputLayer } from "../shell/input-stack.ts";
import type { InputKey } from "../shell/input-stack.ts";

export interface PanelKeyboardOptions {
	// Navigation (arrow keys)
	selectedIndex?: number;
	maxIndex?: number;
	onIndexChange?: (idx: number) => void;
	circular?: boolean; // wrap around at bounds (default: false)

	// Action keys
	onEnter?: (index: number) => void;
	onEscape?: () => void;
	onTab?: () => void;
	onSpace?: () => void;

	// Number key shortcuts (1-9)
	onNumberKey?: (num: number) => void;

	// Scroll (takes priority over index navigation)
	onScrollUp?: () => void;
	onScrollDown?: () => void;

	// Text input mode (for inline text editing)
	textInput?: boolean;
	onTextChange?: (char: string) => void;
	onTextSubmit?: (text: string) => void;
	onBackspace?: () => void;
}

export function usePanelKeyboard(opts: PanelKeyboardOptions): void {
	const optsRef = useRef(opts);
	optsRef.current = opts;

	useInputLayer((input: string, key: InputKey) => {
		const o = optsRef.current;

		// 1. Escape
		if (key.escape) {
			o.onEscape?.();
			return;
		}

		// 2. Enter/Return
		if (key.return) {
			o.onEnter?.(o.selectedIndex ?? 0);
			return;
		}

		// 3. Tab
		if (key.tab) {
			o.onTab?.();
			return;
		}

		// 4. Up arrow
		if (key.upArrow) {
			if (o.onScrollUp) {
				o.onScrollUp();
			} else if (o.onIndexChange && o.maxIndex != null) {
				const cur = o.selectedIndex ?? 0;
				const next = o.circular
					? (cur - 1 + o.maxIndex + 1) % (o.maxIndex + 1)
					: Math.max(0, cur - 1);
				o.onIndexChange(next);
			}
			return;
		}

		// 5. Down arrow
		if (key.downArrow) {
			if (o.onScrollDown) {
				o.onScrollDown();
			} else if (o.onIndexChange && o.maxIndex != null) {
				const cur = o.selectedIndex ?? 0;
				const next = o.circular
					? (cur + 1) % (o.maxIndex + 1)
					: Math.min(o.maxIndex, cur + 1);
				o.onIndexChange(next);
			}
			return;
		}

		// 6. Space
		if (input === " ") {
			o.onSpace?.();
			return;
		}

		// 7. Backspace / Delete
		if (key.backspace || key.delete) {
			o.onBackspace?.();
			return;
		}

		// 8. Number keys 1-9
		if (input >= "1" && input <= "9") {
			o.onNumberKey?.(parseInt(input));
			return;
		}

		// 9. Text input mode
		if (o.textInput && input && !key.ctrl && !key.meta) {
			o.onTextChange?.(input);
			return;
		}

		// 10. All other keys consumed — prevent leaking to outer handler
	});
}
