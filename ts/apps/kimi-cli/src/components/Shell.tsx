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
 *     <ApprovalPanel />        -- approval request (when pending)
 *     <SessionPicker />        -- session selection overlay (when open)
 *     <Spinner />              -- loading indicator
 *     <InputArea />            -- user input
 *     <StatusBar />            -- bottom status bar
 *   </Box>
 */

import React, { useCallback, useContext, useMemo } from 'react';
import { Box, Static, Text } from 'ink';

import { AppContext } from '../app/context.js';
import type { CompletedBlock } from '../app/context.js';
import Welcome from './Welcome.js';
import StreamingMessage from './message/StreamingMessage.js';
import ToolCallBlock from './message/ToolCallBlock.js';
import ToolResultBlock from './message/ToolResultBlock.js';
import ApprovalPanel from './approval/ApprovalPanel.js';
import SessionPicker from './session/SessionPicker.js';
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
      if (block.toolCallData) {
        return (
          <Box marginTop={1}>
            <ToolCallBlock
              toolCall={block.toolCallData}
              result={block.toolCallData.result}
              successColor={colors.success}
              errorColor={colors.error}
              dimColor={colors.textDim}
            />
          </Box>
        );
      }
      return (
        <Box>
          <Text color={colors.success}>{'● '}</Text>
          <Text color={colors.success}>{block.content}</Text>
        </Box>
      );
    case 'tool_result':
      if (block.toolResultData) {
        return (
          <Box marginLeft={2}>
            <ToolResultBlock
              toolName="tool"
              result={block.toolResultData}
              successColor={colors.success}
              errorColor={colors.error}
              dimColor={colors.textDim}
            />
          </Box>
        );
      }
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
  const {
    completedBlocks,
    streamingThinkText,
    pendingToolCall,
    pendingApproval,
    handleApprovalResponse,
    styles,
    state,
    sessions,
    loadingSessions,
    switchSession,
    showSessionPicker,
    setShowSessionPicker,
  } = useContext(AppContext);

  // Prepend the welcome block so it is always the first Static item.
  const staticItems = useMemo<CompletedBlock[]>(
    () => [WELCOME_BLOCK, ...completedBlocks],
    [completedBlocks],
  );

  const handleSessionSelect = useCallback(
    (sessionId: string) => {
      switchSession(sessionId);
      setShowSessionPicker(false);
    },
    [switchSession, setShowSessionPicker],
  );

  const handleSessionCancel = useCallback(() => {
    setShowSessionPicker(false);
  }, [setShowSessionPicker]);

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
      {/* Dynamic area: streaming thinking content */}
      {state.streamingPhase === 'thinking' && streamingThinkText.length > 0 ? (
        <Box marginTop={1}>
          <ThinkingBlock text={streamingThinkText} />
        </Box>
      ) : null}
      {/* Dynamic area: pending tool call with loading spinner */}
      {pendingToolCall !== null ? (
        <Box marginTop={1}>
          <ToolCallBlock
            toolCall={pendingToolCall}
            result={pendingToolCall.result}
            successColor={styles.colors.success}
            errorColor={styles.colors.error}
            dimColor={styles.colors.textDim}
          />
        </Box>
      ) : null}
      <StreamingMessage />
      {pendingApproval !== null ? (
        <ApprovalPanel
          request={pendingApproval}
          onResponse={handleApprovalResponse}
        />
      ) : null}
      {/* Session picker overlay */}
      {showSessionPicker ? (
        <SessionPicker
          sessions={sessions}
          loading={loadingSessions}
          currentSessionId={state.sessionId}
          colors={styles.colors}
          onSelect={handleSessionSelect}
          onCancel={handleSessionCancel}
        />
      ) : null}
      <Spinner />
      <InputArea />
      <StatusBar />
    </Box>
  );
}
