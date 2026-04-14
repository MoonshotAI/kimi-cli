/**
 * Shell component -- the main TUI layout.
 *
 * Structure (per plan):
 *   <Box flexDirection="column">
 *     <Static items={[welcomeBlock, ...completedBlocks]}>
 *       {(item) => item.type === 'welcome'
 *         ? <Welcome key="welcome" />
 *         : <CompletedBlockView key={item.id} block={item} />}
 *     </Static>
 *     <StreamingMessage />     -- current streaming content (dynamic)
 *     <Spinner />              -- loading indicator
 *     <InputArea />            -- user input
 *     <StatusBar />            -- bottom status bar
 *   </Box>
 *
 * The `<Static>` items array starts with a synthetic "welcome" block
 * so that the welcome banner is rendered once and never redrawn.
 */

import React, { useContext, useMemo } from 'react';
import { Box, Static, Text } from 'ink';

import { AppContext } from '../app/context.js';
import type { CompletedBlock } from '../app/context.js';
import Welcome from './Welcome.js';
import StreamingMessage from './message/StreamingMessage.js';
import Spinner from './Spinner.js';
import InputArea from './InputArea.js';
import StatusBar from './StatusBar.js';
import { MarkdownRenderer } from './markdown/index.js';
import ThinkingBlock from './message/ThinkingBlock.js';

// A synthetic block representing the welcome banner.
const WELCOME_BLOCK: CompletedBlock = {
  id: 'welcome',
  type: 'welcome',
  content: '',
};

/**
 * Render a single completed block based on its type.
 */
function CompletedBlockView({ block }: { readonly block: CompletedBlock }): React.JSX.Element {
  const { styles } = useContext(AppContext);
  const { colors } = styles;

  switch (block.type) {
    case 'user':
      return (
        <Box marginTop={1}>
          <Text color={colors.user} bold>{'✨ '}</Text>
          <Text color={colors.user}>{block.content}</Text>
        </Box>
      );
    case 'assistant':
      return (
        <Box marginTop={1} flexDirection="row">
          <Text color={colors.text}>{'● '}</Text>
          <Box flexDirection="column">
            <MarkdownRenderer text={block.content} />
          </Box>
        </Box>
      );
    case 'thinking':
      return (
        <Box marginTop={1}>
          <ThinkingBlock text={block.content} />
        </Box>
      );
    case 'tool_call':
      return (
        <Box>
          <Text color={colors.success}>{'● '}</Text>
          <Text color={colors.success}>{block.content}</Text>
        </Box>
      );
    case 'tool_result':
      return (
        <Box marginLeft={2}>
          <Text dimColor>{block.content}</Text>
        </Box>
      );
    case 'status':
      return (
        <Box marginLeft={2}>
          <Text dimColor>{block.content}</Text>
        </Box>
      );
    default:
      return <Text>{block.content}</Text>;
  }
}

export default function Shell(): React.JSX.Element {
  const { completedBlocks } = useContext(AppContext);

  // Prepend the welcome block so it is always the first Static item.
  const staticItems = useMemo<CompletedBlock[]>(
    () => [WELCOME_BLOCK, ...completedBlocks],
    [completedBlocks],
  );

  return (
    <Box flexDirection="column">
      <Static items={staticItems}>
        {(item: CompletedBlock) =>
          item.type === 'welcome' ? (
            <Welcome key="welcome" />
          ) : (
            <CompletedBlockView key={item.id} block={item} />
          )
        }
      </Static>
      <StreamingMessage />
      <Spinner />
      <InputArea />
      <StatusBar />
    </Box>
  );
}
