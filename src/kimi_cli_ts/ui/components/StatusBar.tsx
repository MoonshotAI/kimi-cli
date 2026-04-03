/**
 * StatusBar component — bottom status bar.
 * Matches Python's toolbar: separator line + single status line.
 *
 * Layout:
 * ──────────────────────────────────────────────────────
 * agent (kimi-k2.5 ●)  ~/workdir  main    context: 0.0%
 */

import React from "react";
import { Box, Text, useStdout } from "ink";
import type { StatusUpdate } from "../../wire/types";

const DIM = "#888888";

interface StatusBarProps {
  modelName?: string;
  workDir?: string;
  status: StatusUpdate | null;
  isStreaming: boolean;
  stepCount: number;
  isCompacting?: boolean;
  planMode?: boolean;
  yolo?: boolean;
  thinking?: boolean;
}

export function StatusBar({
  modelName = "",
  workDir,
  status,
  isStreaming,
  stepCount,
  isCompacting = false,
  planMode = false,
  yolo = false,
  thinking = false,
}: StatusBarProps) {
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;

  // Context usage
  const contextUsage = status?.context_usage;
  const contextPercent =
    contextUsage != null ? (contextUsage * 100).toFixed(1) : "0.0";

  // Shorten workDir
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const displayDir = workDir
    ? workDir.startsWith(home)
      ? "~" + workDir.slice(home.length)
      : workDir
    : "";

  // Build left section: [yolo] [plan] agent (model ●)
  const leftParts: string[] = [];
  if (yolo) leftParts.push("yolo");
  if (planMode) leftParts.push("plan");

  const thinkingDot = thinking ? "●" : "○";
  const modeStr = modelName
    ? `agent (${modelName} ${thinkingDot})`
    : "agent";
  leftParts.push(modeStr);
  const leftText = leftParts.join("  ");

  // Build right section
  const rightText = `context: ${contextPercent}%`;

  // Separator
  const separator = "─".repeat(columns);

  return (
    <Box flexDirection="column">
      <Text color={DIM}>{separator}</Text>
      <Box justifyContent="space-between">
        <Box gap={2}>
          {yolo && (
            <Text color="yellow" bold>
              yolo
            </Text>
          )}
          {planMode && (
            <Text color="magenta" bold>
              plan
            </Text>
          )}
          <Text>{modeStr}</Text>
          {displayDir && <Text color={DIM}>{displayDir}</Text>}
          {isStreaming && (
            <Text color="#1e90ff">step {stepCount}</Text>
          )}
          {isCompacting && <Text color="yellow">compacting...</Text>}
        </Box>
        <Box gap={2}>
          <Text color={DIM}>
            shift-tab: plan mode | ctrl-o: editor
          </Text>
          <Text color={DIM}>{rightText}</Text>
        </Box>
      </Box>
    </Box>
  );
}

function formatTokenCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}
