/**
 * ThinkingBlock component -- renders a collapsed preview of thinking content.
 *
 * Shows the thinking text with a "💭 Thinking..." prefix in themed gray italic.
 * Long text is truncated to a configurable number of lines (default 6).
 */

import React, { useContext } from 'react';
import { Box, Text } from 'ink';

import { AppContext } from '../../app/context.js';

/** Default maximum number of preview lines to show. */
const DEFAULT_MAX_LINES = 6;
const DEFAULT_THINK_COLOR = '#888888';

export interface ThinkingBlockProps {
  readonly text: string;
  readonly maxLines?: number | undefined;
}

export default function ThinkingBlock({
  text,
  maxLines = DEFAULT_MAX_LINES,
}: ThinkingBlockProps): React.JSX.Element {
  const ctx = useContext(AppContext);
  const thinkColor = ctx?.styles?.colors?.thinking ?? DEFAULT_THINK_COLOR;

  if (text.length === 0) {
    return (
      <Box>
        <Text color={thinkColor} italic>💭 </Text>
      </Box>
    );
  }

  const lines = text.split('\n');
  const isTruncated = lines.length > maxLines;
  const displayLines = isTruncated ? lines.slice(0, maxLines) : lines;
  const displayText = displayLines.join('\n');

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={thinkColor} italic>💭 {displayText}</Text>
      </Box>
      {isTruncated ? (
        <Box marginLeft={2}>
          <Text color={thinkColor} italic dimColor>
            {`... (${String(lines.length - maxLines)} more lines)`}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
