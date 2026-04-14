/**
 * InputArea component -- bordered input box with cursor, Claude Code style.
 *
 * Layout (rounded border, theme-colored):
 *   ╭──────────────────────────────────╮
 *   │ hello world▎                     │
 *   ╰──────────────────────────────────╯
 *
 * Uses Ink's `useInput` hook to capture keystrokes.
 *  - Enter: submit the current input text
 *  - Ctrl-C: cancel the current streaming turn
 *  - Ctrl-D: exit the application
 *  - Backspace: delete the last character
 *  - Regular characters: append to input buffer
 */

import React, { useContext, useState, useRef, useEffect } from 'react';
import { Box, Text, useInput, useApp as useInkApp } from 'ink';

import { AppContext } from '../app/context.js';

/** Blinking cursor character */
const CURSOR = '▎';

export default function InputArea(): React.JSX.Element {
  const { state, styles, sendMessage, cancelStream } = useContext(AppContext);
  const { exit } = useInkApp();
  const [inputText, setInputText] = useState('');
  const inputRef = useRef('');
  const [cursorVisible, setCursorVisible] = useState(true);

  // Blink cursor every 530ms
  useEffect(() => {
    if (state.isStreaming) return;
    const timer = setInterval(() => {
      setCursorVisible((v) => !v);
    }, 530);
    return () => clearInterval(timer);
  }, [state.isStreaming]);

  useInput((input, key) => {
    // Ctrl-D: exit the application (always active).
    if (key.ctrl && input === 'd') {
      exit();
      return;
    }

    // Ctrl-C: cancel the current stream.
    if (key.ctrl && input === 'c') {
      cancelStream();
      return;
    }

    // When streaming, ignore all other input.
    if (state.isStreaming) {
      return;
    }

    // Enter: submit.
    if (key.return) {
      const trimmed = inputRef.current.trim();
      if (trimmed.length > 0) {
        sendMessage(trimmed);
        inputRef.current = '';
        setInputText('');
      }
      return;
    }

    // Backspace: delete last character.
    if (key.backspace || key.delete) {
      inputRef.current = inputRef.current.slice(0, -1);
      setInputText(inputRef.current);
      return;
    }

    // Tab, arrows, escape, etc. -- ignore for now.
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

    // Regular character input.
    if (input.length > 0 && !key.ctrl && !key.meta) {
      inputRef.current += input;
      setInputText(inputRef.current);
    }
  });

  // Hide the input area while streaming.
  if (state.isStreaming) {
    return <Box />;
  }

  return (
    <Box
      borderStyle="round"
      borderColor={styles.colors.textDim}
      paddingLeft={1}
      paddingRight={1}
      marginTop={1}
    >
      {inputText.length === 0 ? (
        <Text>
          <Text color={styles.colors.primary}>{cursorVisible ? CURSOR : ' '}</Text>
          <Text color={styles.colors.textMuted}> Ask Kimi anything or type / for commands...</Text>
        </Text>
      ) : (
        <Text>
          {inputText}
          <Text color={styles.colors.primary}>{cursorVisible ? CURSOR : ' '}</Text>
        </Text>
      )}
    </Box>
  );
}
