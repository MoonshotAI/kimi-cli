/**
 * QuestionPanel.tsx — Interactive question panel with React Ink.
 * Corresponds to Python's ui/shell/question_panel.py.
 *
 * Features:
 * - Multi-question tabs (◀/▶ to switch)
 * - Number key selection (1-6)
 * - Multi-select with space toggle
 * - "Other" free text input
 * - Body content area
 */

import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import type { QuestionRequest, QuestionItem, QuestionOption } from "../../wire/types";

const OTHER_OPTION_LABEL = "Other";

interface OptionEntry {
  label: string;
  description: string;
}

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
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [multiSelected, setMultiSelected] = useState<Set<number>>(new Set());
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [otherMode, setOtherMode] = useState(false);
  const [otherText, setOtherText] = useState("");
  const [otherDrafts, setOtherDrafts] = useState<Record<number, string>>({});

  const question: QuestionItem = request.questions[questionIndex]!;
  const options: OptionEntry[] = [
    ...question.options.map((o) => ({
      label: o.label,
      description: o.description,
    })),
    {
      label: question.other_label || OTHER_OPTION_LABEL,
      description: question.other_description || "",
    },
  ];
  const isMultiSelect = question.multi_select;
  const isOtherSelected = selectedIndex === options.length - 1;
  const otherIdx = options.length - 1;

  const advance = useCallback(() => {
    const newAnswers = { ...answers };
    // Find next unanswered
    const total = request.questions.length;
    if (Object.keys(newAnswers).length >= total) {
      onAnswer(newAnswers);
      return true;
    }
    for (let offset = 1; offset <= total; offset++) {
      const idx = (questionIndex + offset) % total;
      if (!(request.questions[idx]!.question in newAnswers)) {
        setQuestionIndex(idx);
        setSelectedIndex(0);
        setMultiSelected(new Set());
        setOtherMode(false);
        setOtherText("");
        return false;
      }
    }
    onAnswer(newAnswers);
    return true;
  }, [answers, questionIndex, request.questions, onAnswer]);

  const submitCurrent = useCallback(() => {
    if (isMultiSelect) {
      if (otherIdx in [...multiSelected] && multiSelected.has(otherIdx)) {
        // Need other input first
        setOtherMode(true);
        return;
      }
      const selected = [...multiSelected]
        .filter((i) => i < question.options.length)
        .sort()
        .map((i) => options[i]!.label);
      if (selected.length === 0) return;
      const newAnswers = { ...answers, [question.question]: selected.join(", ") };
      setAnswers(newAnswers);
      // Check if all answered
      if (Object.keys(newAnswers).length >= request.questions.length) {
        onAnswer(newAnswers);
      } else {
        advance();
      }
    } else {
      if (isOtherSelected) {
        setOtherMode(true);
        return;
      }
      const newAnswers = {
        ...answers,
        [question.question]: options[selectedIndex]!.label,
      };
      setAnswers(newAnswers);
      if (Object.keys(newAnswers).length >= request.questions.length) {
        onAnswer(newAnswers);
      } else {
        // Find next unanswered
        const total = request.questions.length;
        for (let offset = 1; offset <= total; offset++) {
          const idx = (questionIndex + offset) % total;
          if (!(request.questions[idx]!.question in newAnswers)) {
            setQuestionIndex(idx);
            setSelectedIndex(0);
            setMultiSelected(new Set());
            return;
          }
        }
        onAnswer(newAnswers);
      }
    }
  }, [
    isMultiSelect,
    multiSelected,
    otherIdx,
    question,
    options,
    selectedIndex,
    isOtherSelected,
    answers,
    request.questions,
    questionIndex,
    onAnswer,
    advance,
  ]);

  const submitOther = useCallback(
    (text: string) => {
      let newAnswers: Record<string, string>;
      if (isMultiSelect) {
        const selected = [...multiSelected]
          .filter((i) => i < question.options.length && i !== otherIdx)
          .sort()
          .map((i) => options[i]!.label);
        if (text) selected.push(text);
        newAnswers = {
          ...answers,
          [question.question]: selected.join(", ") || text,
        };
      } else {
        newAnswers = { ...answers, [question.question]: text };
      }
      setAnswers(newAnswers);
      setOtherMode(false);
      setOtherText("");
      if (Object.keys(newAnswers).length >= request.questions.length) {
        onAnswer(newAnswers);
      } else {
        const total = request.questions.length;
        for (let offset = 1; offset <= total; offset++) {
          const idx = (questionIndex + offset) % total;
          if (!(request.questions[idx]!.question in newAnswers)) {
            setQuestionIndex(idx);
            setSelectedIndex(0);
            setMultiSelected(new Set());
            return;
          }
        }
        onAnswer(newAnswers);
      }
    },
    [
      isMultiSelect,
      multiSelected,
      question,
      otherIdx,
      options,
      answers,
      request.questions,
      questionIndex,
      onAnswer,
    ],
  );

  useInput((input, key) => {
    // Other text input mode
    if (otherMode) {
      if (key.return) {
        submitOther(otherText.trim());
        return;
      }
      if (key.escape) {
        setOtherMode(false);
        setOtherText("");
        onCancel();
        return;
      }
      if (key.backspace || key.delete) {
        setOtherText((t) => t.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setOtherText((t) => t + input);
      }
      return;
    }

    // Navigation
    if (key.upArrow) {
      setSelectedIndex((i) => (i - 1 + options.length) % options.length);
    } else if (key.downArrow) {
      setSelectedIndex((i) => (i + 1) % options.length);
    } else if (key.leftArrow) {
      // Previous tab
      if (questionIndex > 0) {
        setQuestionIndex(questionIndex - 1);
        setSelectedIndex(0);
        setMultiSelected(new Set());
      }
    } else if (key.rightArrow || key.tab) {
      // Next tab
      if (questionIndex < request.questions.length - 1) {
        setQuestionIndex(questionIndex + 1);
        setSelectedIndex(0);
        setMultiSelected(new Set());
      }
    } else if (input === " " && isMultiSelect) {
      // Toggle multi-select
      setMultiSelected((prev) => {
        const next = new Set(prev);
        if (next.has(selectedIndex)) {
          next.delete(selectedIndex);
        } else {
          next.add(selectedIndex);
        }
        return next;
      });
    } else if (key.return) {
      submitCurrent();
    } else if (key.escape) {
      onCancel();
    } else if (input >= "1" && input <= "6") {
      const idx = parseInt(input) - 1;
      if (idx < options.length) {
        setSelectedIndex(idx);
        if (isMultiSelect) {
          setMultiSelected((prev) => {
            const next = new Set(prev);
            if (next.has(idx)) {
              next.delete(idx);
            } else {
              next.add(idx);
            }
            return next;
          });
        } else if (idx !== otherIdx) {
          // Direct submit for non-other
          const newAnswers = {
            ...answers,
            [question.question]: options[idx]!.label,
          };
          setAnswers(newAnswers);
          if (Object.keys(newAnswers).length >= request.questions.length) {
            onAnswer(newAnswers);
          } else {
            const total = request.questions.length;
            for (let offset = 1; offset <= total; offset++) {
              const nextIdx = (questionIndex + offset) % total;
              if (
                !(request.questions[nextIdx]!.question in newAnswers)
              ) {
                setQuestionIndex(nextIdx);
                setSelectedIndex(0);
                setMultiSelected(new Set());
                return;
              }
            }
            onAnswer(newAnswers);
          }
        } else {
          setOtherMode(true);
        }
      }
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      {/* Title */}
      <Text color="cyan" bold>
        ? QUESTION
      </Text>
      <Text> </Text>

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
      {options.map((option, i) => {
        const num = i + 1;
        const isSelected = i === selectedIndex;
        const isOther = i === otherIdx;

        if (isMultiSelect) {
          const checked = multiSelected.has(i) ? "✓" : " ";
          return (
            <Box key={i} flexDirection="column">
              <Text color={isSelected ? "cyan" : "grey"}>
                [{checked}] {option.label}
              </Text>
              {option.description && !isSelected && (
                <Text dimColor>{"      "}{option.description}</Text>
              )}
            </Box>
          );
        }

        if (isOther && otherMode && isSelected) {
          return (
            <Text key={i} color="cyan">
              → [{num}] {option.label}: {otherText}█
            </Text>
          );
        }

        return (
          <Box key={i} flexDirection="column">
            <Text color={isSelected ? "cyan" : "grey"}>
              {isSelected ? "→" : " "} [{num}] {option.label}
            </Text>
            {option.description && !(isOther && otherMode) && (
              <Text dimColor>{"      "}{option.description}</Text>
            )}
          </Box>
        );
      })}

      {/* Hints */}
      <Text> </Text>
      {otherMode ? (
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
    </Box>
  );
}

export default QuestionPanel;
