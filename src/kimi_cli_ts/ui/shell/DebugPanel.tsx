/**
 * DebugPanel.tsx — Context debug viewer.
 * Corresponds to Python's ui/shell/debug.py.
 *
 * Features:
 * - Display full context (all messages with role colors)
 * - Token count
 * - Checkpoint information
 */

import React from "react";
import { Box, Text } from "ink";

// ── Types ───────────────────────────────────────────────

export interface ContextInfo {
  totalMessages: number;
  tokenCount: number;
  checkpoints: number;
  trajectory?: string;
}

export interface DebugMessage {
  role: string;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
  partial?: boolean;
}

export interface DebugPanelProps {
  context: ContextInfo;
  messages: DebugMessage[];
}

// ── Role colors ─────────────────────────────────────────

const ROLE_COLORS: Record<string, string> = {
  system: "magenta",
  developer: "magenta",
  user: "green",
  assistant: "blue",
  tool: "yellow",
};

function getRoleColor(role: string): string {
  return ROLE_COLORS[role] || "white";
}

// ── ContentPart formatting ──────────────────────────────

function formatContent(content: string): React.ReactNode {
  const trimmed = content.trim();
  if (trimmed.startsWith("<system>") && trimmed.endsWith("</system>")) {
    const inner = trimmed.slice(8, -9).trim();
    return (
      <Box
        borderStyle="single"
        borderColor="yellow"
        paddingX={1}
        flexDirection="column"
      >
        <Text dimColor>system</Text>
        <Text>{inner}</Text>
      </Box>
    );
  }
  return <Text color="white">{content}</Text>;
}

// ── ToolCall formatting ─────────────────────────────────

function ToolCallDebugView({
  toolCall,
}: {
  toolCall: { id: string; name: string; arguments: string };
}) {
  let argsFormatted: string;
  try {
    argsFormatted = JSON.stringify(JSON.parse(toolCall.arguments), null, 2);
  } catch {
    argsFormatted = toolCall.arguments;
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="yellow"
      paddingX={1}
    >
      <Text color="yellow" bold>Tool Call</Text>
      <Text color="cyan" bold>Function: {toolCall.name}</Text>
      <Text dimColor>Call ID: {toolCall.id}</Text>
      <Text bold>Arguments:</Text>
      <Text>{argsFormatted}</Text>
    </Box>
  );
}

// ── Message formatting ──────────────────────────────────

function MessageDebugView({
  msg,
  index,
}: {
  msg: DebugMessage;
  index: number;
}) {
  const roleColor = getRoleColor(msg.role);
  let title = `#${index + 1} ${msg.role.toUpperCase()}`;
  if (msg.name) title += ` (${msg.name})`;
  if (msg.toolCallId) title += ` → ${msg.toolCallId}`;
  if (msg.partial) title += " (partial)";

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={roleColor}
      paddingX={1}
      marginBottom={1}
    >
      <Text color={roleColor} bold>{title}</Text>
      {msg.content ? (
        formatContent(msg.content)
      ) : (
        <Text dimColor italic>[empty message]</Text>
      )}
      {msg.toolCalls?.map((tc) => (
        <ToolCallDebugView key={tc.id} toolCall={tc} />
      ))}
    </Box>
  );
}

// ── DebugPanel ──────────────────────────────────────────

export function DebugPanel({ context, messages }: DebugPanelProps) {
  if (messages.length === 0) {
    return (
      <Box borderStyle="single" borderColor="yellow" paddingX={2} paddingY={1}>
        <Text>Context is empty - no messages yet</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {/* Context info */}
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor="cyan"
        paddingX={1}
        marginBottom={1}
      >
        <Text color="white" bold>Context Info</Text>
        <Text bold>Total messages: {context.totalMessages}</Text>
        <Text bold>Token count: {context.tokenCount.toLocaleString()}</Text>
        <Text bold>Checkpoints: {context.checkpoints}</Text>
        {context.trajectory && (
          <Text dimColor>Trajectory: {context.trajectory}</Text>
        )}
      </Box>

      {/* Separator */}
      <Text dimColor>{"─".repeat(60)}</Text>

      {/* All messages */}
      {messages.map((msg, idx) => (
        <MessageDebugView key={idx} msg={msg} index={idx} />
      ))}
    </Box>
  );
}

export default DebugPanel;
