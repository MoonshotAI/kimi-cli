/**
 * ToolResultBlock component -- renders a completed tool result.
 *
 * Displays the outcome of a tool invocation:
 *  - Success: green checkmark + tool name + result summary
 *  - Failure: red cross + tool name + error message
 *  - Shell results: command preview + truncated output
 *
 * This is used in the <Static> completed blocks area.
 */

import React from 'react';
import { Box, Text } from 'ink';

import type { ToolReturnValue, DisplayBlock } from '@moonshot-ai/kimi-wire-mock';

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

function getOutputText(output: string | Array<{ type: string; text?: string }>): string {
  if (typeof output === 'string') return output;
  // ContentPart[] -- extract text parts.
  return output
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
}

// ── Component Props ──────────────────────────────────────────────────

export interface ToolResultBlockProps {
  /** The tool name that produced this result. */
  readonly toolName: string;
  /** The tool result data. */
  readonly result: ToolReturnValue;
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
  const isError = result.isError;

  // Status indicator
  const statusIcon = isError
    ? <Text color={errorColor}>{'✗ '}</Text>
    : <Text color={successColor}>{'✓ '}</Text>;

  // Brief message
  const message = result.message || '';

  // Extract shell command from display blocks
  const shellBlock = result.display.find(
    (b: DisplayBlock) => b.type === 'shell',
  );
  const shellCommand = shellBlock?.type === 'shell' ? shellBlock.command : null;

  // Output preview
  const outputText = getOutputText(result.output);
  const truncatedOutput = outputText ? truncateOutput(outputText, MAX_OUTPUT_LINES) : '';

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        {statusIcon}
        <Text>
          <Text color={isError ? errorColor : successColor} bold>{toolName}</Text>
          {message ? <Text color={dimColor}>{` - ${message}`}</Text> : null}
        </Text>
      </Box>
      {shellCommand ? (
        <Box marginLeft={2}>
          <Text color={dimColor}>{`$ ${shellCommand}`}</Text>
        </Box>
      ) : null}
      {truncatedOutput ? (
        <Box marginLeft={2}>
          <Text color={dimColor}>{truncatedOutput}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
