/**
 * QuestionPanel.tsx — Interactive question panel with React Ink.
 * Corresponds to Python's ui/shell/question_panel.py.
 *
 * Uses useSelectionInput hook for keyboard logic (shared with SelectionPanel).
 *
 * Features:
 * - Multi-question tabs (◀/▶ to switch)
 * - Number key selection (1-9)
 * - Multi-select with SPACE toggle
 * - "Other" free text input (auto-activates when selected)
 * - Draft persistence when navigating away from Other
 */

import React, { useState, useCallback } from "react";
import { Box, Text } from "ink";
import type { QuestionRequest, QuestionItem } from "../../wire/types";
import {
	useSelectionInput,
	type SelectionInputOption,
} from "./useSelectionInput.ts";
import { TitleBox } from "../components/TitleBox.tsx";

const OTHER_OPTION_LABEL = "Other";

export interface QuestionPanelProps {
	request: QuestionRequest;
	onAnswer: (answers: Record<string, string>) => void;
	onCancel: () => void;
}

export function QuestionPanel({
	request,
	onAnswer,
	onCancel,
}: QuestionPanelProps) {
	const [questionIndex, setQuestionIndex] = useState(0);
	const [answers, setAnswers] = useState<Record<string, string>>({});

	const question: QuestionItem = request.questions[questionIndex]!;
	const isMultiSelect = question.multi_select;

	// Build option list: regular options + "Other" (with inputMode)
	const selectionOptions: SelectionInputOption[] = [
		...question.options.map(() => ({})),
		{ inputMode: true }, // "Other" option
	];
	const otherIdx = selectionOptions.length - 1;
	const optionLabels = [
		...question.options.map((o) => o.label),
		question.other_label || OTHER_OPTION_LABEL,
	];
	const optionDescs = [
		...question.options.map((o) => o.description),
		question.other_description || "",
	];

	// Advance to next unanswered question or submit all
	const advanceOrSubmit = useCallback(
		(newAnswers: Record<string, string>) => {
			setAnswers(newAnswers);
			const total = request.questions.length;
			if (Object.keys(newAnswers).length >= total) {
				onAnswer(newAnswers);
				return;
			}
			for (let offset = 1; offset <= total; offset++) {
				const idx = (questionIndex + offset) % total;
				if (!(request.questions[idx]!.question in newAnswers)) {
					setQuestionIndex(idx);
					sel.reset();
					return;
				}
			}
			onAnswer(newAnswers);
		},
		[questionIndex, request.questions, onAnswer],
	);

	const sel = useSelectionInput({
		options: selectionOptions,
		multiSelect: isMultiSelect,

		// Single-select: confirm option
		onSelect: (idx) => {
			const newAnswers = {
				...answers,
				[question.question]: optionLabels[idx]!,
			};
			advanceOrSubmit(newAnswers);
		},

		// Single-select Other: submit typed text
		onInputSubmit: (_idx, text) => {
			const newAnswers = {
				...answers,
				[question.question]: text,
			};
			advanceOrSubmit(newAnswers);
		},

		// Multi-select: submit all checked + optional Other text
		onMultiSubmit: (selected, inputText) => {
			const labels = [...selected]
				.filter((i) => i < question.options.length)
				.sort()
				.map((i) => optionLabels[i]!);
			if (inputText) labels.push(inputText);
			if (labels.length === 0) return; // nothing selected
			const newAnswers = {
				...answers,
				[question.question]: labels.join(", "),
			};
			advanceOrSubmit(newAnswers);
		},

		onCancel,

		// ◄/► for question tabs
		onExtraKey: (input, key) => {
			if (key.leftArrow && questionIndex > 0) {
				setQuestionIndex(questionIndex - 1);
				sel.reset();
				return true;
			}
			if (
				(key.rightArrow || key.tab) &&
				questionIndex < request.questions.length - 1
			) {
				setQuestionIndex(questionIndex + 1);
				sel.reset();
				return true;
			}
			return false;
		},
	});

	return (
		<TitleBox
			title="? QUESTION"
			titleColor="cyan"
			borderStyle="round"
			borderColor="cyan"
			flexDirection="column"
			paddingX={1}
		>
			{/* Tabs for multi-question */}
			{request.questions.length > 1 && (
				<>
					<Box gap={2}>
						{request.questions.map((q, i) => {
							const label = q.header || `Q${i + 1}`;
							const isActive = i === questionIndex;
							const isAnswered = q.question in answers;
							const icon = isActive ? "●" : isAnswered ? "✓" : "○";
							const color = isActive ? "cyan" : isAnswered ? "green" : "grey";
							return (
								<Text key={i} color={color} bold={isActive}>
									({icon}) {label}
								</Text>
							);
						})}
					</Box>
					<Text> </Text>
				</>
			)}

			{/* Question text */}
			<Text color="yellow">? {question.question}</Text>
			{isMultiSelect && (
				<Text dimColor italic>
					{"  "}(SPACE to toggle, ENTER to submit)
				</Text>
			)}
			<Text> </Text>

			{/* Body hint */}
			{question.body && (
				<>
					<Text color="cyan" bold>
						{"  "}▶ Press ctrl-e to view full content
					</Text>
					<Text> </Text>
				</>
			)}

			{/* Options */}
			{selectionOptions.map((_, i) => {
				const num = i + 1;
				const isSelected = i === sel.selectedIndex;
				const isOther = i === otherIdx;
				const label = optionLabels[i]!;
				const desc = optionDescs[i];

				if (isMultiSelect) {
					const checked = sel.multiSelected.has(i) ? "✓" : " ";
					// Other with input cursor
					if (isOther && isSelected) {
						return (
							<Text key={i} color="cyan">
								[{checked}] {label}: {sel.inputText}█
							</Text>
						);
					}
					return (
						<Text key={i} color={isSelected ? "cyan" : "grey"}>
							[{checked}] {label}
							{desc ? ` — ${desc}` : ""}
						</Text>
					);
				}

				// Single-select: Other with input cursor
				if (isOther && isSelected) {
					return (
						<Text key={i} color="cyan">
							→ [{num}] {label}: {sel.inputText}█
						</Text>
					);
				}

				return (
					<Text key={i} color={isSelected ? "cyan" : "grey"}>
						{isSelected ? "→" : " "} [{num}] {label}
						{desc ? ` — ${desc}` : ""}
					</Text>
				);
			})}

			{/* Hints */}
			<Text> </Text>
			{sel.isInputActive ? (
				<Text dimColor italic>
					{"  "}Type your answer, then press Enter to submit.
				</Text>
			) : request.questions.length > 1 ? (
				<Text dimColor>
					{"  "}◄/► switch question {"  "}▲/▼ select {"  "}↵ submit {"  "}esc
					exit
				</Text>
			) : (
				<Text dimColor>
					{"  "}▲/▼ select {"  "}↵ submit {"  "}esc exit
				</Text>
			)}
		</TitleBox>
	);
}

export default QuestionPanel;
