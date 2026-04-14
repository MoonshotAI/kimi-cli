/**
 * StreamingMessage component -- renders the current in-flight text.
 *
 * Displays the accumulated text from ContentPart events that have not
 * yet been finalised into a CompletedBlock. Visible only while streaming.
 *
 * Phase 4: plain text rendering only (no Markdown).
 */

import React, { useContext } from 'react';
import { Box, Text } from 'ink';

import { AppContext } from '../../app/context.js';

export default function StreamingMessage(): React.JSX.Element | null {
  const { streamingText, state, styles } = useContext(AppContext);

  if (!state.isStreaming || streamingText.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="row" marginTop={1}>
      <Text color={styles.colors.text}>{'● '}</Text>
      <Text>{streamingText}</Text>
    </Box>
  );
}
