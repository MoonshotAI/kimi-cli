/**
 * ToolResultBlock component -- renders a completed tool result.
 *
 * Displays the outcome of a tool invocation:
 *  - Success: green checkmark + tool name + output preview
 *  - Failure: red cross + tool name + error output
 *
 * Wire 2.1: ToolResultData has `output` (string) and `is_error` (boolean).
 */

import React from 'react';
import { Box, Text } from 'ink';

import type { ToolResultBlockData } from '../../app/context.js';

// ── Helpers ──────────────────────────────────────────────────────────

/** Maximum lines of output to show. */
const MAX_OUTPUT_LINES = 6;

function truncateOutput(output: string, maxLines: number): string {
  const lines = output.split('\n');
  if (lines.length <= maxLines) return output;
  const shown = lines.slice(0, maxLines).join('\n');
  const remaining = lines.length - maxLines;
  return `${shown}\n... (${remaining} more lines)`;
}

// ── Component Props ──────────────────────────────────────────────────

export interface ToolResultBlockProps {
  /** The tool name that produced this result. */
  readonly toolName: string;
  /** The tool result data. */
  readonly result: ToolResultBlockData;
  /** Theme colors. */
  readonly successColor?: string;
  readonly errorColor?: string;
  readonly dimColor?: string;
}

// ── ToolResultBlock ──────────────────────────────────────────────────

export default function ToolResultBlock({
  toolName,
  result,
  successColor = '#4EC87E',
  errorColor = '#E85454',
  dimColor = '#888888',
}: ToolResultBlockProps): React.JSX.Element {
  const isError = result.is_error ?? false;

  // Status indicator
  const statusIcon = isError
    ? <Text color={errorColor}>{'✗ '}</Text>
    : <Text color={successColor}>{'✓ '}</Text>;

  // Output preview
  const truncatedOutput = result.output ? truncateOutput(result.output, MAX_OUTPUT_LINES) : '';

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        {statusIcon}
        <Text>
          <Text color={isError ? errorColor : successColor} bold>{toolName}</Text>
        </Text>
      </Box>
      {truncatedOutput ? (
        <Box marginLeft={2}>
          <Text color={dimColor}>{truncatedOutput}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
