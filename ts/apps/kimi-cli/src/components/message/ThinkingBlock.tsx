/**
 * ThinkingBlock component -- renders thinking content in full.
 *
 * Shows the thinking text in themed gray italic.
 */

import { Box, Text } from 'ink';
import React, { useContext } from 'react';

import { ChromeContext } from '../../app/context.js';

const DEFAULT_THINK_COLOR = '#888888';

export interface ThinkingBlockProps {
  readonly text: string;
  readonly showMarker?: boolean;
}

export default function ThinkingBlock({
  text,
  showMarker = false,
}: ThinkingBlockProps): React.JSX.Element {
  const chrome = useContext(ChromeContext);
  const thinkColor = chrome?.styles.colors.thinking ?? DEFAULT_THINK_COLOR;

  const prefix = showMarker ? '● ' : '  ';

  if (text.length === 0) {
    return (
      <Box flexDirection="row">
        <Text color={thinkColor}>{prefix}</Text>
        <Text color={thinkColor} italic>{''}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="row">
      <Text color={thinkColor}>{prefix}</Text>
      <Box flexDirection="column">
        <Text color={thinkColor} italic>{text}</Text>
      </Box>
    </Box>
  );
}
