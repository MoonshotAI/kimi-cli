/**
 * Shell component -- the main TUI layout.
 *
 * Layout:
 *   <StaticTranscript />
 *   <NotificationToast />
 *   <LiveFrame />
 */

import { Box, Static, Text, useWindowSize } from 'ink';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  useActions,
  useChrome,
  useLiveTurn,
  useTranscript,
  type TranscriptEntry,
} from '../app/context.js';
import ApprovalPanel from './approval/ApprovalPanel.js';
import InputArea from './InputArea.js';
import { MarkdownRenderer } from './markdown/index.js';
import NotificationToast from './NotificationToast.js';
import QueuedMessages from './QueuedMessages.js';
import QuestionDialog from './question/QuestionDialog.js';
import SessionPicker from './session/SessionPicker.js';
import Spinner from './Spinner.js';
import StatusBar from './StatusBar.js';
import Welcome from './Welcome.js';

import ThinkingBlock from './message/ThinkingBlock.js';
import ThinkingViewport from './message/ThinkingViewport.js';
import ToolCallBlock from './message/ToolCallBlock.js';
import { computeThinkingMaxHeight } from './message/thinking-layout.js';

const WELCOME_ENTRY: TranscriptEntry = {
  id: 'welcome',
  kind: 'welcome',
  turnId: undefined,
  renderMode: 'plain',
  content: '',
};

const STATUS_BAR_HEIGHT = 3;
const INPUT_BORDER_ROWS = 2;
const DEFAULT_MAX_INPUT_LINES = 10;
const PHASE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const PHASE_INTERVAL_MS = 80;

function TranscriptEntryView({ entry, showBullet }: { readonly entry: TranscriptEntry; readonly showBullet: boolean }): React.JSX.Element {
  const { styles } = useChrome();
  const { colors } = styles;

  switch (entry.kind) {
    case 'user':
      return (
        <Box marginTop={1}>
          <Text color={colors.user} bold>
            {'✨ '}
          </Text>
          <Text color={colors.user}>{entry.content}</Text>
        </Box>
      );
    case 'assistant':
      return (
        <Box marginTop={showBullet ? 1 : 0} flexDirection="row">
          <Text color={colors.text}>{showBullet ? '● ' : '  '}</Text>
          <Box flexDirection="column">
            <MarkdownRenderer text={entry.content} />
          </Box>
        </Box>
      );
    case 'thinking':
      return (
        <Box marginTop={1}>
          <ThinkingBlock text={entry.content} showMarker={true} />
        </Box>
      );
    case 'tool_call':
      if (entry.toolCallData === undefined) {
        return (
          <Box marginLeft={2}>
            <Text dimColor>{entry.content}</Text>
          </Box>
        );
      }
      return (
        <Box marginTop={1} flexDirection="column">
          <ToolCallBlock
            toolCall={entry.toolCallData}
            result={entry.toolCallData.result}
            successColor={colors.success}
            errorColor={colors.error}
            dimColor={colors.textDim}
          />
        </Box>
      );
    case 'status':
      return (
        <Box marginLeft={2}>
          {entry.color
            ? <Text color={entry.color}>{entry.content}</Text>
            : <Text dimColor>{entry.content}</Text>}
        </Box>
      );
    default:
      return <Text>{entry.content}</Text>;
  }
}

function StaticTranscript(): React.JSX.Element {
  const { entries } = useTranscript();
  const items = useMemo<TranscriptEntry[]>(() => [WELCOME_ENTRY, ...entries], [entries]);

  const continuationIds = useMemo(() => {
    const set = new Set<string>();
    for (let i = 1; i < items.length; i++) {
      const curr = items[i]!;
      const prev = items[i - 1]!;
      if (curr.kind === 'assistant' && prev.kind === 'assistant') {
        set.add(curr.id);
      }
    }
    return set;
  }, [items]);

  return (
    <Static items={items}>
      {(entry: TranscriptEntry) =>
        entry.kind === 'welcome' ? (
          <Welcome key="welcome" />
        ) : (
          <TranscriptEntryView key={entry.id} entry={entry} showBullet={!continuationIds.has(entry.id)} />
        )
      }
    </Static>
  );
}

function WaitingPane(): React.JSX.Element {
  return <Spinner active={true} />;
}

function phaseLabel(phase: string): string | null {
  switch (phase) {
    case 'thinking':
      return 'thinking...';
    case 'composing':
      return 'composing...';
    default:
      return null;
  }
}

function StreamPhaseLine({
  phase,
}: {
  readonly phase: 'thinking' | 'composing';
}): React.JSX.Element | null {
  const { styles } = useChrome();
  const [frame, setFrame] = useState(0);
  const livePhase = useMemo(() => phaseLabel(phase), [phase]);

  useEffect(() => {
    if (livePhase === null) return;

    const timer = setInterval(() => {
      setFrame((value) => (value + 1) % PHASE_FRAMES.length);
    }, PHASE_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [livePhase]);

  if (livePhase === null) {
    return null;
  }

  const color = phase === 'thinking' ? styles.colors.text : styles.colors.primary;

  return (
    <Box>
      <Text color={color}>
        {PHASE_FRAMES[frame % PHASE_FRAMES.length]} {livePhase}
      </Text>
    </Box>
  );
}

function ToolPane({ height }: { readonly height: number }): React.JSX.Element | null {
  const { pane } = useLiveTurn();
  const { styles } = useChrome();

  if (pane.pendingToolCall === null) {
    return null;
  }

  return (
    <Box
      height={Math.max(3, Math.min(height, 5))}
      borderStyle="round"
      borderColor={styles.colors.border}
      paddingX={1}
      flexDirection="column"
      justifyContent="center"
    >
      <Text color={styles.colors.textDim}>tool</Text>
      <ToolCallBlock
        toolCall={pane.pendingToolCall}
        result={pane.pendingToolCall.result}
        successColor={styles.colors.success}
        errorColor={styles.colors.error}
        dimColor={styles.colors.textDim}
      />
    </Box>
  );
}

function ActivityPane({ maxHeight }: { readonly maxHeight: number }): React.JSX.Element | null {
  const { pane } = useLiveTurn();
  const { styles, sessions, loadingSessions, showSessionPicker, state } = useChrome();
  const {
    handleApprovalResponse,
    handleQuestionResponse,
    setShowSessionPicker,
    switchSession,
  } = useActions();
  const { rows } = useWindowSize();

  const thinkingHeight = useMemo(
    () => computeThinkingMaxHeight(rows, Math.max(1, maxHeight)),
    [maxHeight, rows],
  );

  const handleSessionSelect = useCallback(
    (sessionId: string) => {
      switchSession(sessionId);
      setShowSessionPicker(false);
    },
    [setShowSessionPicker, switchSession],
  );

  const handleSessionCancel = useCallback(() => {
    setShowSessionPicker(false);
  }, [setShowSessionPicker]);

  let content: React.JSX.Element | null = null;

  if (showSessionPicker) {
    content = (
      <SessionPicker
        sessions={sessions}
        loading={loadingSessions}
        currentSessionId={state.sessionId}
        colors={styles.colors}
        onSelect={handleSessionSelect}
        onCancel={handleSessionCancel}
        maxVisibleSessions={Math.max(1, maxHeight - 2)}
      />
    );
  } else if (pane.pendingApproval !== null) {
    content = (
      <ApprovalPanel
        request={pane.pendingApproval}
        onResponse={handleApprovalResponse}
        maxBodyHeight={Math.max(6, maxHeight)}
      />
    );
  } else if (pane.pendingQuestion !== null) {
    content = (
      <QuestionDialog
        request={pane.pendingQuestion}
        onAnswer={handleQuestionResponse}
        maxVisibleOptions={Math.max(2, maxHeight - 4)}
      />
    );
  } else {
    switch (pane.mode) {
      case 'waiting':
        content = <WaitingPane />;
        break;
      case 'thinking':
        content = (
          <Box flexDirection="column">
            <StreamPhaseLine phase="thinking" />
            <ThinkingViewport text={pane.thinkingText} maxHeight={thinkingHeight} />
          </Box>
        );
        break;
      case 'tool':
        content = <ToolPane height={5} />;
        break;
      default:
        if (state.streamingPhase === 'composing') {
          content = <StreamPhaseLine phase="composing" />;
        } else {
          content = null;
        }
        break;
    }
  }

  if (content === null) {
    return null;
  }

  return <Box flexDirection="column" marginTop={1}>{content}</Box>;
}

const MAX_SLASH_PANEL_ROWS = 9;

function LiveFrame(): React.JSX.Element {
  const { rows, columns } = useWindowSize();
  const [inputContentLines, setInputContentLines] = useState(1);

  const effectiveInputLines = Math.min(inputContentLines, DEFAULT_MAX_INPUT_LINES + MAX_SLASH_PANEL_ROWS);
  const inputDockHeight = effectiveInputLines + INPUT_BORDER_ROWS;
  const maxActivityHeight = Math.max(1, rows - inputDockHeight - STATUS_BAR_HEIGHT);

  return (
    <Box flexDirection="column">
      <ActivityPane maxHeight={maxActivityHeight} />
      <QueuedMessages />
      <InputArea
        columns={columns}
        maxInputLines={DEFAULT_MAX_INPUT_LINES}
        onContentLines={setInputContentLines}
      />
      <StatusBar />
    </Box>
  );
}

export default function Shell(): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <StaticTranscript />
      <NotificationToast />
      <LiveFrame />
    </Box>
  );
}
