/**
 * ThinkingBlock component -- renders thinking content in full.
 *
 * Shows the thinking text with a "💭" prefix in themed gray italic.
 */

import React, { useContext } from 'react';
import { Box, Text } from 'ink';

import { AppContext } from '../../app/context.js';

const DEFAULT_THINK_COLOR = '#888888';

export interface ThinkingBlockProps {
  readonly text: string;
}

export default function ThinkingBlock({
  text,
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

  return (
    <Box>
      <Text color={thinkColor} italic>💭 {text}</Text>
    </Box>
  );
}
