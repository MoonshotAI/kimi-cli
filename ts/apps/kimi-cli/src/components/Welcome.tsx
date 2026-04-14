/**
 * Welcome component -- displayed as the first item in the <Static> list.
 *
 * Shows a bordered panel with:
 *  - Application name and help hint
 *  - Working directory
 *  - Session ID
 *  - Model name
 *  - Version
 *
 * Mirrors the Python `_print_welcome_info()` in `ui/shell/__init__.py`.
 */

import React, { useContext } from 'react';
import { Box, Text } from 'ink';

import { AppContext } from '../app/context.js';

export default function Welcome(): React.JSX.Element {
  const { state, styles } = useContext(AppContext);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={styles.colors.primary}
      paddingX={2}
      paddingY={1}
    >
      <Text bold color={styles.colors.primary}>
        Welcome to Kimi Code CLI!
      </Text>
      <Text dimColor>Send /help for help information.</Text>
      <Text> </Text>
      <Text>
        <Text dimColor bold>Directory: </Text>
        <Text>{state.workDir}</Text>
      </Text>
      <Text>
        <Text dimColor bold>Session:   </Text>
        <Text>{state.sessionId}</Text>
      </Text>
      <Text>
        <Text dimColor bold>Model:     </Text>
        <Text>{state.model}</Text>
      </Text>
      <Text>
        <Text dimColor bold>Version:   </Text>
        <Text>{state.version}</Text>
      </Text>
    </Box>
  );
}
