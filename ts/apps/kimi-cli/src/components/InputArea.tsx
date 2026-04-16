/**
 * Bottom input dock — multi-line editing with paste placeholder support.
 *
 * Stays mounted during streaming so the bottom chrome keeps a stable height.
 * During streaming it becomes read-only and surfaces the active hint.
 */

import { Box, Text, useApp as useInkApp, useInput, usePaste } from 'ink';
import React, { useEffect, useRef, useState } from 'react';

import { useActions, useChrome } from '../app/context.js';
import { PastePlaceholderManager } from './paste-placeholder.js';
import { computeDisplayHeight, useInputBuffer } from './use-input-buffer.js';

const CURSOR = '▎';
const DEFAULT_MAX_INPUT_LINES = 10;
const BORDER_ROWS = 2;

export interface InputAreaProps {
  readonly columns: number;
  readonly maxInputLines?: number;
  readonly onContentLines?: (lines: number) => void;
}

export default function InputArea({
  columns,
  maxInputLines = DEFAULT_MAX_INPUT_LINES,
  onContentLines,
}: InputAreaProps): React.JSX.Element {
  const { state, styles, showSessionPicker } = useChrome();
  const { appendTranscriptEntry, cancelStream, executeSlashCommand, sendMessage } = useActions();
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Ink's useApp().exit is a stable callback, not a class method.
  const { exit } = useInkApp();

  const buf = useInputBuffer();
  const pasteManager = useRef(new PastePlaceholderManager());
  const [cursorVisible, setCursorVisible] = useState(true);

  const isLocked = state.isStreaming || showSessionPicker;

  // Blink cursor
  useEffect(() => {
    if (isLocked) {
      setCursorVisible(true);
      return;
    }
    const timer = setInterval(() => {
      setCursorVisible((v) => !v);
    }, 530);
    return () => clearInterval(timer);
  }, [isLocked]);

  // Available width inside the bordered box (border + padding each side)
  const innerWidth = Math.max(1, columns - 4);

  const displayLines = computeDisplayHeight(buf.buffer.lines, innerWidth);

  const effectiveLines = Math.min(displayLines, maxInputLines);

  // Notify parent of content line count
  useEffect(() => {
    onContentLines?.(displayLines);
  }, [displayLines, onContentLines]);

  // Viewport scrolling when content exceeds max visible lines
  const [viewportStart, setViewportStart] = useState(0);
  useEffect(() => {
    const cursorLine = buf.buffer.cursor.line;
    if (cursorLine < viewportStart) {
      setViewportStart(cursorLine);
    } else if (cursorLine >= viewportStart + maxInputLines) {
      setViewportStart(cursorLine - maxInputLines + 1);
    }
  }, [buf.buffer.cursor.line, maxInputLines, viewportStart]);

  useInput((input, key) => {
    if (key.ctrl && input === 'd') {
      exit();
      return;
    }

    if (key.ctrl && input === 'c') {
      cancelStream();
      return;
    }

    if (isLocked) return;

    // Submit on plain Enter
    if (key.return && !key.ctrl && !key.meta) {
      const trimmed = buf.text().trim();
      if (trimmed.length === 0) return;

      const expanded = pasteManager.current.expandPlaceholders(trimmed);
      buf.clear();
      pasteManager.current.reset();
      setViewportStart(0);

      if (expanded.startsWith('/')) {
        void executeSlashCommand(expanded).then((message) => {
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
        sendMessage(expanded);
      }
      return;
    }

    // Newline: Ctrl+J (legacy terminals send '\n'; kitty sends ctrl+j),
    // or Meta+Enter (\x1b\r → key.meta + key.return)
    if (input === '\n' || (key.ctrl && input === 'j') || (key.meta && key.return)) {
      buf.insertNewline();
      return;
    }

    if (key.backspace || key.delete) {
      buf.deleteBack();
      return;
    }

    if (key.leftArrow) { buf.moveCursor('left'); return; }
    if (key.rightArrow) { buf.moveCursor('right'); return; }
    if (key.upArrow) { buf.moveCursor('up'); return; }
    if (key.downArrow) { buf.moveCursor('down'); return; }

    if (
      key.tab ||
      key.escape ||
      key.pageUp ||
      key.pageDown ||
      key.home ||
      key.end
    ) {
      return;
    }

    if (input.length > 0 && !key.ctrl && !key.meta) {
      buf.insertChar(input);
    }
  });

  usePaste((text) => {
    if (isLocked) return;
    const result = pasteManager.current.maybePlaceholderize(text);
    buf.insertText(result);
  }, { isActive: !isLocked });

  const placeholder = showSessionPicker
    ? 'Session picker is active above. Press Esc to close it.'
    : state.isStreaming
      ? 'Streaming in progress. Press Ctrl-C to interrupt the current turn.'
      : 'Ask Kimi anything or type / for commands...';

  const { lines, cursor } = buf.buffer;
  const visibleLines = lines.length > maxInputLines
    ? lines.slice(viewportStart, viewportStart + maxInputLines)
    : lines;
  const visibleCursorLine = cursor.line - viewportStart;

  const inputHeight = effectiveLines + BORDER_ROWS;

  return (
    <Box height={inputHeight} flexDirection="column">
      <Box
        borderStyle="round"
        borderColor={isLocked ? styles.colors.border : styles.colors.textDim}
        paddingLeft={1}
        paddingRight={1}
        flexDirection="column"
      >
        {buf.isEmpty || isLocked ? (
          <Text>
            {!isLocked ? (
              <Text color={styles.colors.primary}>{cursorVisible ? CURSOR : ' '}</Text>
            ) : null}
            <Text color={styles.colors.textMuted}>{placeholder}</Text>
          </Text>
        ) : (
          visibleLines.map((line, i) => (
            // eslint-disable-next-line react/no-array-index-key -- lines are positional, not keyed by content
            <Text key={i}>
              {i === visibleCursorLine ? (
                <>
                  {line.slice(0, cursor.col)}
                  <Text color={styles.colors.primary}>{cursorVisible ? CURSOR : ' '}</Text>
                  {line.slice(cursor.col)}
                </>
              ) : (
                line || ' '
              )}
            </Text>
          ))
        )}
      </Box>
    </Box>
  );
}
