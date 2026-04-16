/**
 * QuestionDialog — inline structured-question prompt (Slice 4.3 Part 2).
 *
 * Rendered when `pendingQuestion` is non-null. Walks through the
 * incoming `QuestionRequestItem[]` one at a time, shows the current
 * question with its options, and lets the user pick an option with
 * the arrow keys. Enter confirms; `Esc` dismisses and answers with an
 * empty string.
 *
 * Scope note: Slice 4.3 ships the simplest possible dialog that covers
 * the kimi-core schema (2–4 options per question, up to 4 questions).
 * Multi-select support and "Other" free-form input are deferred — the
 * user can use plain chat for anything the dialog cannot express.
 */

import { Box, Text, useInput } from 'ink';
import React, { useEffect, useState } from 'react';

import { useChrome } from '../../app/context.js';
import type { PendingQuestion } from '../../app/context.js';

export interface QuestionDialogProps {
  readonly request: PendingQuestion;
  readonly onAnswer: (answers: string[]) => void;
  readonly maxVisibleOptions?: number;
}

export default function QuestionDialog({
  request,
  onAnswer,
  maxVisibleOptions = 4,
}: QuestionDialogProps): React.JSX.Element {
  const { styles } = useChrome();
  const { colors } = styles;

  const [index, setIndex] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [collected, setCollected] = useState<string[]>([]);

  const total = request.data.questions.length;
  const current = request.data.questions[index];
  const options = current?.options ?? [];
  // M2 deferred warning (Slice 4.3 review round 1): multi_select
  // dialogs are not yet implemented — the dialog only lets the user
  // pick a single option per question. Surface a banner so the user
  // knows their first selection is what gets submitted, rather than
  // silently downgrading.
  const multiSelectRequested = current?.multi_select === true;

  // Reset cursor when the question changes so we never index past the
  // end of a shorter option list.
  useEffect(() => {
    setCursor(0);
  }, [index]);

  useInput((_input, key) => {
    if (current === undefined) return;

    if (key.upArrow) {
      setCursor((c) => (c <= 0 ? options.length - 1 : c - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => (c >= options.length - 1 ? 0 : c + 1));
      return;
    }
    if (key.escape) {
      onAnswer([]);
      return;
    }
    if (key.return) {
      const label = options[cursor]?.label ?? '';
      const next = [...collected, label];
      if (index + 1 >= total) {
        onAnswer(next);
      } else {
        setCollected(next);
        setIndex(index + 1);
      }
    }
  });

  if (current === undefined) {
    return <Box />;
  }

  const visibleWindowStart = Math.max(
    0,
    Math.min(
      cursor - Math.floor(maxVisibleOptions / 2),
      Math.max(0, options.length - maxVisibleOptions),
    ),
  );
  const visibleOptions = options.slice(visibleWindowStart, visibleWindowStart + maxVisibleOptions);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.primary}
      paddingLeft={1}
      paddingRight={1}
    >
      <Box>
        <Text color={colors.textDim}>
          Question {index + 1}/{total}
          {current.header !== undefined && current.header.length > 0 ? ` — ${current.header}` : ''}
        </Text>
      </Box>
      {multiSelectRequested ? (
        <Box>
          <Text color={colors.error}>
            ⚠️ Multi-select not yet supported — only the first selection will be submitted.
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={colors.text}>{current.question}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {visibleOptions.map((opt, visibleIndex) => {
          const optionIndex = visibleWindowStart + visibleIndex;
          const selected = optionIndex === cursor;
          return (
            <Box key={`${String(index)}-${String(optionIndex)}`}>
              <Text color={selected ? colors.primary : colors.text}>
                {selected ? '› ' : '  '}
                {opt.label}
              </Text>
              {opt.description !== undefined && opt.description.length > 0 ? (
                <Text color={colors.textDim}> — {opt.description}</Text>
              ) : null}
            </Box>
          );
        })}
      </Box>
      {options.length > visibleOptions.length ? (
        <Box>
          <Text color={colors.textDim}>
            {`Showing ${String(visibleWindowStart + 1)}-${String(visibleWindowStart + visibleOptions.length)} of ${String(options.length)} options`}
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={colors.textDim}>↑/↓ select · Enter confirm · Esc dismiss</Text>
      </Box>
    </Box>
  );
}
