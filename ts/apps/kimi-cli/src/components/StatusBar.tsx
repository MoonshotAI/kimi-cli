/**
 * StatusBar component -- two-line bottom toolbar, matching Python version.
 *
 * Line 1: ──────────────────────────────────  (separator)
 * Line 2: [yolo] [plan] mode (model ●) cwd [git] tips...
 * Line 3: (left toast)              context: 5.0% (500/100k)
 */

import React, { useContext } from 'react';
import { Box, Text, useStdout } from 'ink';

import { AppContext } from '../app/context.js';

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
  const { state, styles } = useContext(AppContext);
  const { stdout } = useStdout();
  const { colors } = styles;
  const columns = stdout?.columns ?? 80;

  // Thinking indicator
  const thinkingDot = state.thinking ? '●' : '○';

  // Mode + model
  const modeLabel = state.inputMode;
  const modeText = state.model
    ? `${modeLabel} (${state.model} ${thinkingDot})`
    : modeLabel;

  // Shortened CWD
  const cwd = shortenCwd(state.workDir);

  // Tips (rotating, hardcoded for now)
  const tips = 'ctrl-x: toggle mode | shift-tab: plan mode';

  // Context status (right-aligned on line 2)
  const contextText = formatContextStatus(state.contextUsage, 0, 0);
  const contextClr = contextColor(state.contextUsage, colors);

  // Separator line
  const separator = '─'.repeat(columns);

  return (
    <Box flexDirection="column" marginTop={1}>
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

      {/* Line 2: context usage right-aligned */}
      <Box justifyContent="flex-end">
        <Text color={contextClr}>{contextText}</Text>
      </Box>
    </Box>
  );
}
