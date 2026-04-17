import { Box, Text } from 'ink';
import React from 'react';

import { useActions, useChrome } from '../app/context.js';

export default function QueuedMessages(): React.JSX.Element | null {
  const { queuedMessages } = useActions();
  const { styles } = useChrome();

  if (queuedMessages.length === 0) return null;

  return (
    <Box flexDirection="column" marginBottom={0}>
      {queuedMessages.map((item) => (
        <Text key={item.id} color="cyan" dimColor>
          {'  '}❯ {item.text}
        </Text>
      ))}
      <Text dimColor>
        {'  '}↑ to edit · ctrl-s to steer immediately
      </Text>
    </Box>
  );
}
