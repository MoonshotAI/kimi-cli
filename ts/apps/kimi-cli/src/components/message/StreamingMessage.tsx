/**
 * StreamingMessage component -- renders the current in-flight text.
 *
 * Displays the accumulated text from ContentPart events that have not
 * yet been finalised into a CompletedBlock. Visible only while streaming.
 *
 * Uses the committed boundary algorithm to split the streaming text:
 *  - committed portion: rendered as full Markdown via MarkdownRenderer
 *  - pending portion: rendered as normal text (not dimmed, to avoid
 *    the "gray flash" effect during real-time streaming)
 */

import React, { useMemo, useContext } from 'react';
import { Box, Text } from 'ink';

import { AppContext } from '../../app/context.js';
import { MarkdownRenderer, committedBoundary } from '../markdown/index.js';

export default function StreamingMessage(): React.JSX.Element | null {
  const { streamingText, state, styles } = useContext(AppContext);

  const { committed, pending } = useMemo(
    () => committedBoundary(streamingText),
    [streamingText],
  );

  if (!state.isStreaming || streamingText.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text color={styles.colors.text}>{'● '}</Text>
        <Box flexDirection="column">
          {committed.length > 0 ? <MarkdownRenderer text={committed} /> : null}
          {pending.length > 0 ? <Text>{pending}</Text> : null}
        </Box>
      </Box>
    </Box>
  );
}
