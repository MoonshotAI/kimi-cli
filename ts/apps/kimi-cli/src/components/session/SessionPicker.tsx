/**
 * SessionPicker -- interactive session selection component.
 *
 * Fetches sessions from Wire, displays them in a navigable list,
 * and allows the user to select one to resume.
 *
 * Navigation:
 *  - Up/Down arrows: move selection
 *  - Enter: resume selected session
 *  - Escape: cancel and close the picker
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

import type { SessionInfo } from '../../wire/methods.js';

export interface SessionPickerProps {
  readonly sessions: SessionInfo[];
  readonly loading: boolean;
  readonly currentSessionId: string;
  readonly colors: {
    primary: string;
    text: string;
    textDim: string;
    textMuted: string;
    success: string;
    border: string;
  };
  readonly onSelect: (sessionId: string) => void;
  readonly onCancel: () => void;
  readonly maxVisibleSessions?: number;
}

/** Format a timestamp as a short relative-time string. */
function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Truncate a path for display. */
function shortenPath(path: string, maxLen: number = 40): string {
  const home = process.env['HOME'] ?? '';
  let shortened = path;
  if (home && path.startsWith(home)) {
    shortened = '~' + path.slice(home.length);
  }
  if (shortened.length > maxLen) {
    return '...' + shortened.slice(shortened.length - maxLen + 3);
  }
  return shortened;
}

export default function SessionPicker({
  sessions,
  loading,
  currentSessionId,
  colors,
  onSelect,
  onCancel,
  maxVisibleSessions = 6,
}: SessionPickerProps): React.JSX.Element {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (key.return && sessions.length > 0) {
      const session = sessions[selectedIndex];
      if (session) {
        onSelect(session.id);
      }
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(sessions.length - 1, prev + 1));
      return;
    }
  });

  if (loading) {
    return (
      <Box
        borderStyle="round"
        borderColor={colors.border}
        paddingX={2}
        paddingY={1}
        flexDirection="column"
      >
        <Text color={colors.primary} bold>Sessions</Text>
        <Text color={colors.textMuted}>Loading sessions...</Text>
      </Box>
    );
  }

  if (sessions.length === 0) {
    return (
      <Box
        borderStyle="round"
        borderColor={colors.border}
        paddingX={2}
        paddingY={1}
        flexDirection="column"
      >
        <Text color={colors.primary} bold>Sessions</Text>
        <Text color={colors.textMuted}>No sessions found. Press Escape to close.</Text>
      </Box>
    );
  }

  const visibleWindowStart = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(maxVisibleSessions / 2),
      Math.max(0, sessions.length - maxVisibleSessions),
    ),
  );
  const visibleSessions = sessions.slice(
    visibleWindowStart,
    visibleWindowStart + maxVisibleSessions,
  );

  return (
    <Box
      borderStyle="round"
      borderColor={colors.primary}
      paddingX={1}
      paddingY={0}
      flexDirection="column"
    >
      <Box marginBottom={0}>
        <Text color={colors.primary} bold>Sessions </Text>
        <Text color={colors.textMuted}>(↑↓ navigate, Enter select, Esc cancel)</Text>
      </Box>

      {visibleSessions.map((session, visibleIndex) => {
        const index = visibleWindowStart + visibleIndex;
        const isSelected = index === selectedIndex;
        const isCurrent = session.id === currentSessionId;
        const pointer = isSelected ? '❯' : ' ';
        const title = session.title ?? session.id;
        const time = formatRelativeTime(session.updated_at);
        const dir = shortenPath(session.work_dir);

        return (
          <Box key={session.id} flexDirection="row" gap={1}>
            <Text color={isSelected ? colors.primary : colors.textDim}>{pointer}</Text>
            <Text
              color={isSelected ? colors.primary : colors.text}
              bold={isSelected}
            >
              {title}
            </Text>
            {isCurrent ? <Text color={colors.success}>(current)</Text> : null}
            <Text color={colors.textMuted}>{dir}</Text>
            <Text color={colors.textDim}>{time}</Text>
          </Box>
        );
      })}
      {sessions.length > visibleSessions.length ? (
        <Box>
          <Text color={colors.textMuted}>
            {`Showing ${String(visibleWindowStart + 1)}-${String(visibleWindowStart + visibleSessions.length)} of ${String(sessions.length)} sessions`}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
