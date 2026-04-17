/**
 * Bottom input dock — multi-line editing with paste placeholder support.
 *
 * Stays mounted during streaming so the bottom chrome keeps a stable height.
 * During streaming it becomes read-only and surfaces the active hint.
 */

import { Box, Text, useApp as useInkApp, useInput, usePaste } from 'ink';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import { useActions, useChrome } from '../app/context.js';
import { PastePlaceholderManager } from './paste-placeholder.js';
import SlashCommandPanel from './SlashCommandPanel.js';
import { computeDisplayHeight, useInputBuffer } from './use-input-buffer.js';

const CURSOR = '▎';
const DEFAULT_MAX_INPUT_LINES = 10;
const BORDER_ROWS = 2;
const MAX_PANEL_ITEMS = 8;

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
  const { state, styles, showSessionPicker, registry } = useChrome();
  const { appendTranscriptEntry, cancelStream, executeSlashCommand, sendMessage, steerMessage, recallLastQueued, dequeueFirst } = useActions();
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Ink's useApp().exit is a stable callback, not a class method.
  const { exit } = useInkApp();

  const buf = useInputBuffer();
  const pasteManager = useRef(new PastePlaceholderManager());
  const [cursorVisible, setCursorVisible] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [panelDismissed, setPanelDismissed] = useState(false);

  const isLocked = showSessionPicker;
  const isStreaming = state.isStreaming;

  // Detect slash mode: input starts with "/" and no space yet (still typing command name)
  const currentText = buf.text();
  const slashPrefix = useMemo(() => {
    if (!currentText.startsWith('/')) return null;
    const spaceIdx = currentText.indexOf(' ');
    if (spaceIdx !== -1) return null;
    return currentText.slice(1);
  }, [currentText]);

  const showPanel = slashPrefix !== null && !isLocked && !isStreaming && !panelDismissed;

  const filteredCommands = useMemo(() => {
    if (slashPrefix === null) return [];
    return registry.search(slashPrefix);
  }, [registry, slashPrefix]);

  // Reset selection when filtered list changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredCommands.length, slashPrefix]);

  // Reset dismissed state when slash prefix changes or input is cleared
  useEffect(() => {
    setPanelDismissed(false);
  }, [slashPrefix]);

  const panelRows = showPanel && filteredCommands.length > 0
    ? Math.min(filteredCommands.length, MAX_PANEL_ITEMS) + (filteredCommands.length > MAX_PANEL_ITEMS ? 1 : 0)
    : 0;

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

  // Notify parent of content line count (including panel)
  useEffect(() => {
    onContentLines?.(displayLines + panelRows);
  }, [displayLines, panelRows, onContentLines]);

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

    // Ctrl+S: immediate steer (only during streaming)
    if (key.ctrl && input === 's') {
      if (!isStreaming) return;
      const text = buf.text().trim();
      if (text.length > 0) {
        const expanded = pasteManager.current.expandPlaceholders(text);
        buf.clear();
        pasteManager.current.reset();
        setViewportStart(0);
        steerMessage(expanded);
      } else {
        const first = dequeueFirst();
        if (first !== undefined) {
          steerMessage(first);
        }
      }
      return;
    }

    // When the slash panel is visible, intercept navigation keys
    if (showPanel && filteredCommands.length > 0) {
      if (key.upArrow) {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((prev) => Math.min(filteredCommands.length - 1, prev + 1));
        return;
      }

      // Tab: complete command name without executing
      if (key.tab) {
        const selected = filteredCommands[selectedIndex];
        if (selected) {
          buf.setText(`/${selected.name} `);
        }
        return;
      }

      // Escape: dismiss the panel
      if (key.escape) {
        setPanelDismissed(true);
        return;
      }

      // Enter: select and execute the command
      if (key.return && !key.ctrl && !key.meta) {
        const selected = filteredCommands[selectedIndex];
        if (selected) {
          const commandText = `/${selected.name}`;
          buf.clear();
          pasteManager.current.reset();
          setViewportStart(0);

          void executeSlashCommand(commandText).then((result) => {
            if (!result) return;
            appendTranscriptEntry({
              id: `slash-${Date.now()}`,
              kind: 'status',
              turnId: undefined,
              renderMode: 'plain',
              content: result.message,
              ...(result.color !== undefined ? { color: result.color } : {}),
            });
          });
        }
        return;
      }
    }

    // Submit on plain Enter
    if (key.return && !key.ctrl && !key.meta) {
      const trimmed = buf.text().trim();
      if (trimmed.length === 0) return;

      const expanded = pasteManager.current.expandPlaceholders(trimmed);
      buf.clear();
      pasteManager.current.reset();
      setViewportStart(0);

      if (expanded.startsWith('/')) {
        void executeSlashCommand(expanded).then((result) => {
          if (!result) return;
          appendTranscriptEntry({
            id: `slash-${Date.now()}`,
            kind: 'status',
            turnId: undefined,
            renderMode: 'plain',
            content: result.message,
            ...(result.color !== undefined ? { color: result.color } : {}),
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

    // Up arrow: during streaming with empty buffer, recall last queued message
    if (key.upArrow) {
      if (isStreaming && buf.text().length === 0) {
        const recalled = recallLastQueued();
        if (recalled !== undefined) {
          buf.setText(recalled);
        }
      } else {
        buf.moveCursor('up');
      }
      return;
    }
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
    : isStreaming
      ? 'Type to queue a message, Ctrl-S to steer, Ctrl-C to cancel'
      : 'Ask Kimi anything or type / for commands...';

  const { lines, cursor } = buf.buffer;
  const visibleLines = lines.length > maxInputLines
    ? lines.slice(viewportStart, viewportStart + maxInputLines)
    : lines;
  const visibleCursorLine = cursor.line - viewportStart;

  const inputHeight = effectiveLines + BORDER_ROWS;
  const totalHeight = inputHeight + panelRows;

  return (
    <Box height={totalHeight} flexDirection="column">
      <Box
        borderStyle="round"
        borderColor={isLocked ? styles.colors.border : styles.colors.textDim}
        paddingLeft={1}
        paddingRight={1}
        flexDirection="column"
      >
        {(buf.isEmpty && !isStreaming) || isLocked ? (
          <Text>
            {!isLocked ? (
              <Text color={styles.colors.primary}>{cursorVisible ? CURSOR : ' '}</Text>
            ) : null}
            <Text color={styles.colors.textMuted}>{placeholder}</Text>
          </Text>
        ) : buf.isEmpty && isStreaming ? (
          <Text>
            <Text color={styles.colors.primary}>{cursorVisible ? CURSOR : ' '}</Text>
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
      {showPanel && filteredCommands.length > 0 ? (
        <SlashCommandPanel
          commands={filteredCommands}
          selectedIndex={selectedIndex}
          maxVisible={MAX_PANEL_ITEMS}
          width={innerWidth}
        />
      ) : null}
    </Box>
  );
}
