/**
 * useSelectionInput — Reusable keyboard logic for selection panels.
 *
 * Extracted from SelectionPanel so both ApprovalPanel and QuestionPanel
 * can share the same input behavior with different UIs.
 *
 * Features:
 * - ↑/↓ circular navigation
 * - Number key shortcuts (1-9)
 * - Inline text input for options marked with inputMode
 * - Draft persistence when navigating away from input options
 * - Multi-select with SPACE toggle
 * - Captures ALL keyboard input via useInputLayer
 */

import { useState, useRef, useCallback } from "react";
import { useInputLayer } from "./input-stack.ts";

export interface SelectionInputOption {
	/** If true, this option enters inline text input when selected. */
	inputMode?: boolean;
}

export interface UseSelectionInputOpts {
	/** Option definitions (only inputMode flag is needed). */
	options: SelectionInputOption[];
	/** Called when user confirms selection (Enter or number key in single-select). */
	onSelect: (index: number) => void;
	/** Called when user submits text from an inputMode option. */
	onInputSubmit?: (index: number, text: string) => void;
	/** Called on Escape. */
	onCancel?: () => void;
	/** Enable multi-select mode (SPACE to toggle, Enter to submit all). */
	multiSelect?: boolean;
	/** Called when user submits in multi-select mode. Receives set of selected indices. */
	onMultiSubmit?: (selected: Set<number>, inputText: string) => void;
	/** Extra key handler for custom keys (e.g., ◄/► for tabs). Return true to consume. */
	onExtraKey?: (input: string, key: Record<string, boolean>) => boolean;
}

export interface SelectionInputState {
	/** Currently highlighted option index. */
	selectedIndex: number;
	/** Whether the currently selected option is in text input mode. */
	isInputActive: boolean;
	/** Current text in the input field (only meaningful when isInputActive). */
	inputText: string;
	/** Set of selected indices (multi-select mode). */
	multiSelected: Set<number>;
	/** Programmatically set the selected index. */
	setSelectedIndex: (index: number | ((prev: number) => number)) => void;
	/** Reset all state (e.g., when switching questions). */
	reset: () => void;
}

export function useSelectionInput(
	opts: UseSelectionInputOpts,
): SelectionInputState {
	const {
		options,
		onSelect,
		onInputSubmit,
		onCancel,
		multiSelect = false,
		onMultiSubmit,
		onExtraKey,
	} = opts;
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [inputText, setInputText] = useState("");
	const [multiSelected, setMultiSelected] = useState<Set<number>>(new Set());
	const inputDraftRef = useRef("");

	const isInputActive = !!options[selectedIndex]?.inputMode;
	const optCount = options.length;

	const reset = useCallback(() => {
		setSelectedIndex(0);
		setInputText("");
		setMultiSelected(new Set());
		inputDraftRef.current = "";
	}, []);

	useInputLayer((input, key) => {
		// ── INPUT MODE (inputMode option selected) ──
		if (isInputActive) {
			if (key.return) {
				const text = inputText.trim();
				if (multiSelect) {
					// Multi-select: submit all selections + input text
					onMultiSubmit?.(multiSelected, text);
					return;
				}
				if (text) {
					setInputText("");
					inputDraftRef.current = "";
					onInputSubmit?.(selectedIndex, text);
				}
				return;
			}

			if (key.escape) {
				setInputText("");
				inputDraftRef.current = "";
				onCancel?.();
				return;
			}

			if (key.upArrow) {
				inputDraftRef.current = inputText;
				setInputText("");
				setSelectedIndex((i) => (i - 1 + optCount) % optCount);
				return;
			}

			if (key.downArrow) {
				inputDraftRef.current = inputText;
				setInputText("");
				setSelectedIndex((i) => (i + 1) % optCount);
				return;
			}

			if (key.backspace || key.delete) {
				setInputText((t) => t.slice(0, -1));
				return;
			}

			if (input && !key.ctrl && !key.meta) {
				setInputText((t) => t + input);
				return;
			}

			return; // Consume everything in input mode
		}

		// ── SELECTION MODE ──

		// Let caller handle custom keys first (e.g., ◄/► for tabs)
		if (onExtraKey?.(input, key as unknown as Record<string, boolean>)) {
			return;
		}

		if (key.upArrow) {
			setSelectedIndex((prev) => {
				const next = (prev - 1 + optCount) % optCount;
				if (options[next]?.inputMode && inputDraftRef.current) {
					setInputText(inputDraftRef.current);
				}
				return next;
			});
			return;
		}

		if (key.downArrow) {
			setSelectedIndex((prev) => {
				const next = (prev + 1) % optCount;
				if (options[next]?.inputMode && inputDraftRef.current) {
					setInputText(inputDraftRef.current);
				}
				return next;
			});
			return;
		}

		// SPACE: toggle in multi-select mode
		if (input === " " && multiSelect) {
			setMultiSelected((prev) => {
				const next = new Set(prev);
				if (next.has(selectedIndex)) {
					next.delete(selectedIndex);
				} else {
					next.add(selectedIndex);
				}
				return next;
			});
			return;
		}

		if (key.return) {
			inputDraftRef.current = "";
			if (multiSelect) {
				onMultiSubmit?.(multiSelected, "");
			} else {
				onSelect(selectedIndex);
			}
			return;
		}

		if (key.escape) {
			onCancel?.();
			return;
		}

		// Number keys 1-9 (up to option count)
		if (input >= "1" && input <= "9") {
			const idx = parseInt(input) - 1;
			if (idx < optCount) {
				setSelectedIndex(idx);
				if (options[idx]?.inputMode) {
					// Navigate to input option; restore draft
					if (inputDraftRef.current) {
						setInputText(inputDraftRef.current);
					}
				} else if (multiSelect) {
					// Toggle in multi-select
					setMultiSelected((prev) => {
						const next = new Set(prev);
						if (next.has(idx)) {
							next.delete(idx);
						} else {
							next.add(idx);
						}
						return next;
					});
				} else {
					// Direct select in single-select
					inputDraftRef.current = "";
					onSelect(idx);
				}
			}
			return;
		}

		// Consume all other keys
	});

	return {
		selectedIndex,
		isInputActive,
		inputText,
		multiSelected,
		setSelectedIndex,
		reset,
	};
}
