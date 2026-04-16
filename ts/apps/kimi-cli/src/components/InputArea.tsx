/**
 * Bottom input dock.
 *
 * The input box stays mounted while streaming so the bottom chrome keeps
 * a stable height. During streaming it becomes read-only and surfaces the
 * active hint instead of disappearing.
 */

import { Box, Text, useApp as useInkApp, useInput } from 'ink';
import React, { useEffect, useRef, useState } from 'react';

import { useActions, useChrome } from '../app/context.js';

const CURSOR = '▎';

export default function InputArea(): React.JSX.Element {
  const { state, styles, showSessionPicker } = useChrome();
  const { appendTranscriptEntry, cancelStream, executeSlashCommand, sendMessage } = useActions();
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Ink's useApp().exit is a stable callback, not a class method.
  const { exit } = useInkApp();
  const [inputText, setInputText] = useState('');
  const inputRef = useRef('');
  const [cursorVisible, setCursorVisible] = useState(true);

  const isLocked = state.isStreaming || showSessionPicker;

  useEffect(() => {
    if (isLocked) {
      setCursorVisible(true);
      return;
    }

    const timer = setInterval(() => {
      setCursorVisible((value) => !value);
    }, 530);
    return () => clearInterval(timer);
  }, [isLocked]);

  useInput((input, key) => {
    if (key.ctrl && input === 'd') {
      exit();
      return;
    }

    if (key.ctrl && input === 'c') {
      cancelStream();
      return;
    }

    if (isLocked) {
      return;
    }

    if (key.return) {
      const trimmed = inputRef.current.trim();
      if (trimmed.length === 0) return;

      inputRef.current = '';
      setInputText('');

      if (trimmed.startsWith('/')) {
        void executeSlashCommand(trimmed).then((message) => {
          if (!message) return;
          appendTranscriptEntry({
            id: `slash-${Date.now()}`,
            kind: 'status',
            turnId: undefined,
            renderMode: 'plain',
            content: message,
          });
        });
      } else {
        sendMessage(trimmed);
      }
      return;
    }

    if (key.backspace || key.delete) {
      inputRef.current = inputRef.current.slice(0, -1);
      setInputText(inputRef.current);
      return;
    }

    if (
      key.tab ||
      key.escape ||
      key.upArrow ||
      key.downArrow ||
      key.leftArrow ||
      key.rightArrow ||
      key.pageUp ||
      key.pageDown ||
      key.home ||
      key.end
    ) {
      return;
    }

    if (input.length > 0 && !key.ctrl && !key.meta) {
      inputRef.current += input;
      setInputText(inputRef.current);
    }
  });

  const placeholder = showSessionPicker
    ? 'Session picker is active above. Press Esc to close it.'
    : state.isStreaming
      ? 'Streaming in progress. Press Ctrl-C to interrupt the current turn.'
      : 'Ask Kimi anything or type / for commands...';

  return (
    <Box height={3} flexDirection="column">
      <Box
        borderStyle="round"
        borderColor={isLocked ? styles.colors.border : styles.colors.textDim}
        paddingLeft={1}
        paddingRight={1}
      >
        {inputText.length === 0 || isLocked ? (
          <Text>
            {!isLocked ? (
              <Text color={styles.colors.primary}>{cursorVisible ? CURSOR : ' '}</Text>
            ) : null}
            <Text color={styles.colors.textMuted}>{placeholder}</Text>
          </Text>
        ) : (
          <Text>
            {inputText}
            <Text color={styles.colors.primary}>{cursorVisible ? CURSOR : ' '}</Text>
          </Text>
        )}
      </Box>
    </Box>
  );
}
