/**
 * StatusBar component.
 *
 * Line 1: separator
 * Line 2: flags + mode + cwd + tips
 * Line 3: context usage
 */

import React from 'react';
import { Box, Text, useStdout } from 'ink';

import { useChrome } from '../app/context.js';

const MAX_CWD_COLS = 30;

/** Replace home dir with ~ and truncate from left if too long. */
function shortenCwd(path: string): string {
  const home = process.env['HOME'] ?? '';
  let shortened = path;
  if (home && path === home) {
    shortened = '~';
  } else if (home && path.startsWith(home + '/')) {
    shortened = '~' + path.slice(home.length);
  }
  if (shortened.length > MAX_CWD_COLS) {
    return '…' + shortened.slice(shortened.length - MAX_CWD_COLS + 1);
  }
  return shortened;
}

/** Format context usage for display. */
function formatContextStatus(usage: number, tokens?: number, maxTokens?: number): string {
  const pct = `${(Math.max(0, Math.min(usage, 1)) * 100).toFixed(1)}%`;
  if (maxTokens && maxTokens > 0 && tokens !== undefined) {
    return `context: ${pct} (${formatTokenCount(tokens)}/${formatTokenCount(maxTokens)})`;
  }
  return `context: ${pct}`;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Color for context usage bar: green < 50%, yellow 50-85%, red > 85%. */
function contextColor(usage: number, colors: { success: string; warning: string; error: string }): string {
  if (usage > 0.85) return colors.error;
  if (usage > 0.5) return colors.warning;
  return colors.success;
}

export default function StatusBar(): React.JSX.Element {
  const { state, styles } = useChrome();
  const { stdout } = useStdout();
  const { colors } = styles;
  const columns = stdout?.columns ?? 80;

  // Thinking indicator
  const thinkingDot = state.thinking ? '●' : '○';

  // Mode + model
  const modeLabel = 'agent';
  const modeText = state.model
    ? `${modeLabel} (${state.model} ${thinkingDot})`
    : modeLabel;

  // Shortened CWD
  const cwd = shortenCwd(state.workDir);

  // Tips
  const tips = '/help: show commands';

  // Context status (right-aligned on line 2)
  const contextText = formatContextStatus(state.contextUsage, state.contextTokens, state.maxContextTokens);
  const contextClr = 'white';

  // Separator line
  const separator = '─'.repeat(columns);

  return (
    <Box flexDirection="column">
      {/* Separator */}
      <Text color={colors.border}>{separator}</Text>

      {/* Line 1: flags + mode + cwd + tips */}
      <Box flexDirection="row" gap={1}>
        {state.yolo ? <Text color={colors.warning} bold>yolo</Text> : null}
        {state.planMode ? <Text color={colors.primary} bold>plan</Text> : null}
        <Text color={colors.text}>{modeText}</Text>
        <Text color={colors.status}>{cwd}</Text>
        <Text color={colors.textMuted}>{tips}</Text>
      </Box>

      {/* Line 2: context usage */}
      <Box justifyContent="flex-end">
        <Text color={contextClr}>{contextText}</Text>
      </Box>
    </Box>
  );
}
