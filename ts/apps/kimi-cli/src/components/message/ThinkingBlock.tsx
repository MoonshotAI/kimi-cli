/**
 * ThinkingBlock component -- renders a collapsed preview of thinking content.
 *
 * Shows the thinking text in gray italic style with a "Thinking..." prefix.
 * Long text is truncated to a configurable number of lines (default 6).
 *
 * Used both in the streaming area (while thinking is in progress) and in
 * completed blocks (after the turn ends).
 */

import React from 'react';
import { Box, Text } from 'ink';

/** Default maximum number of preview lines to show. */
const DEFAULT_MAX_LINES = 6;

export interface ThinkingBlockProps {
  /** The full thinking text content. */
  readonly text: string;
  /** Maximum number of lines to display before truncating. Default: 6. */
  readonly maxLines?: number | undefined;
}

export default function ThinkingBlock({
  text,
  maxLines = DEFAULT_MAX_LINES,
}: ThinkingBlockProps): React.JSX.Element {
  if (text.length === 0) {
    return (
      <Box>
        <Text color="gray" italic>
          Thinking...
        </Text>
      </Box>
    );
  }

  const lines = text.split('\n');
  const isTruncated = lines.length > maxLines;
  const displayLines = isTruncated ? lines.slice(0, maxLines) : lines;
  const displayText = displayLines.join('\n');

  return (
    <Box flexDirection="column">
      <Text color="gray" italic>
        Thinking...
      </Text>
      <Box marginLeft={2}>
        <Text color="gray" italic>
          {displayText}
        </Text>
      </Box>
      {isTruncated ? (
        <Box marginLeft={2}>
          <Text color="gray" italic dimColor>
            {`... (${String(lines.length - maxLines)} more lines)`}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
