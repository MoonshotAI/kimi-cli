import { Box, Text, useBoxMetrics, useWindowSize } from 'ink';
import React, { useMemo, useRef } from 'react';
import type { DOMElement } from 'ink';

import { useChrome } from '../../app/context.js';
import {
  computeThinkingMaxHeight,
  computeThinkingViewportHeight,
  tailLines,
  wrapThinkingText,
} from './thinking-layout.js';

export interface ThinkingViewportProps {
  readonly text: string;
  readonly maxHeight: number;
}

export default function ThinkingViewport({
  text,
  maxHeight,
}: ThinkingViewportProps): React.JSX.Element {
  const { styles } = useChrome();
  const { columns, rows } = useWindowSize();
  const ref = useRef<DOMElement>(null!);
  const metrics = useBoxMetrics(ref);

  const maxPaneHeight = useMemo(
    () => computeThinkingMaxHeight(rows, Math.max(1, maxHeight)),
    [maxHeight, rows],
  );

  const contentWidth = Math.max(1, metrics.hasMeasured ? metrics.width : columns);
  const wrappedLines = useMemo(
    () => wrapThinkingText(text, contentWidth),
    [contentWidth, text],
  );
  const paneHeight = useMemo(
    () => computeThinkingViewportHeight(wrappedLines.length, maxPaneHeight),
    [maxPaneHeight, wrappedLines.length],
  );
  const contentRows = Math.max(1, paneHeight);

  const visibleLines = useMemo(
    () => tailLines(wrappedLines, contentRows),
    [contentRows, wrappedLines],
  );

  return (
    <Box flexDirection="row">
      <Text>{'  '}</Text>
      <Box
        ref={ref}
        height={paneHeight}
        flexDirection="column"
        justifyContent="flex-end"
        flexGrow={1}
      >
        {visibleLines.length === 0 ? (
          <Text color={styles.colors.thinking} italic>
            {' '}
          </Text>
        ) : (
          visibleLines.map((line, index) => (
            <Text key={`thinking-line-${index}`} color={styles.colors.thinking} italic>
              {line}
            </Text>
          ))
        )}
      </Box>
    </Box>
  );
}
