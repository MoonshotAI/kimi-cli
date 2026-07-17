/**
 * SelectionPanel.tsx — Reusable selection panel with optional inline text input.
 *
 * Uses useSelectionInput for keyboard logic. Renders a bordered panel with
 * numbered options, optional children slot, and keyboard hints.
 *
 * Used by ApprovalPanel and any future panel that needs option selection.
 */

import React from "react";
import { Box, Text } from "ink";
import {
	useSelectionInput,
	type SelectionInputOption,
} from "./useSelectionInput.ts";
import { TitleBox } from "../components/TitleBox.tsx";

// ── Types ────────────────────────────────────────────────

export interface SelectionOption extends SelectionInputOption {
	label: string;
	/** Prefix shown before the input cursor (e.g. "Reject: "). Defaults to label + ": ". */
	inputPrefix?: string;
}

export interface SelectionPanelProps {
	/** Options to display. */
	options: SelectionOption[];
	/** Called when user confirms a non-input option (Enter or number key). */
	onSelect: (index: number) => void;
	/** Called when user submits text from an inputMode option. */
	onInputSubmit?: (index: number, text: string) => void;
	/** Called on Escape. */
	onCancel?: () => void;
	/** Content rendered above the options (children slot). */
	children?: React.ReactNode;
	/** Border color. Default: "yellow". */
	borderColor?: string;
	/** Title text shown at top of panel. */
	title?: string;
	/** Title color. Default: same as borderColor. */
	titleColor?: string;
	/** Extra hint text appended after the standard keyboard hints. */
	extraHint?: string;
}

// ── Component ────────────────────────────────────────────

export function SelectionPanel({
	options,
	onSelect,
	onInputSubmit,
	onCancel,
	children,
	borderColor = "yellow",
	title,
	titleColor,
	extraHint,
}: SelectionPanelProps) {
	const { selectedIndex, isInputActive, inputText } = useSelectionInput({
		options,
		onSelect,
		onInputSubmit,
		onCancel,
	});

	const optCount = options.length;
	const effectiveTitleColor = titleColor ?? borderColor;

	return (
		<TitleBox
			title={title}
			titleColor={effectiveTitleColor}
			borderStyle="round"
			borderColor={borderColor}
			flexDirection="column"
			paddingX={1}
		>
			{/* Content slot */}
			{children}

			{children && <Text> </Text>}

			{/* Options */}
			{options.map((option, i) => {
				const num = i + 1;
				const isSelected = i === selectedIndex;

				// Input mode rendering
				if (option.inputMode && isInputActive && isSelected) {
					const prefix = option.inputPrefix ?? `${option.label}: `;
					return (
						<Text key={i} color="cyan">
							→ [{num}] {prefix}
							{inputText}█
						</Text>
					);
				}

				return (
					<Text key={i} color={isSelected ? "cyan" : "grey"}>
						{isSelected ? "→" : " "} [{num}] {option.label}
					</Text>
				);
			})}

			<Text> </Text>

			{/* Keyboard hints */}
			{isInputActive ? (
				<Text dimColor>
					{"  "}Type your feedback, then press Enter to submit.
				</Text>
			) : (
				<Text dimColor>
					{"  "}▲/▼ select{"  "}
					{optCount <= 9
						? Array.from({ length: optCount }, (_, i) => i + 1).join("/")
						: "1-9"}{" "}
					choose{"  "}↵ confirm
					{extraHint ?? ""}
				</Text>
			)}
		</TitleBox>
	);
}
