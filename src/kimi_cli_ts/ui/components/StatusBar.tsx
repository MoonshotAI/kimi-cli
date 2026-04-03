/**
 * StatusBar component — 3-line bottom toolbar matching Python's layout exactly.
 *
 * Layout:
 * ────────────────────────────────────────────────────────────────
 * [yolo] [plan] agent (model ●)  ~/cwd  main [± ↑1]  ⚙ bash:2  tip1 | tip2
 * [left toast]                                  context: 45.2% (12k/200k)
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useStdout } from "ink";
import type { StatusUpdate } from "../../wire/types.ts";
import type { Toast } from "./NotificationStack.tsx";

const DIM = "#888888";
const TIP_ROTATE_MS = 30_000;

const DEFAULT_TIPS = [
  "ctrl-x: toggle mode",
  "shift-tab: plan mode",
  "ctrl-o: editor",
  "ctrl-j: newline",
  "/feedback: send feedback",
  "/theme: switch dark/light",
  "@: mention files",
];

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
  shellMode?: boolean;
  // Git info
  gitBranch?: string | null;
  gitDirty?: boolean;
  gitAhead?: number;
  gitBehind?: number;
  // Background tasks
  bgTaskCount?: number;
  // Toast notifications (embedded in line 2)
  toasts?: Toast[];
  onDismissToast?: (id: string) => void;
  // Tips (rotatable)
  tips?: string[];
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
  shellMode = false,
  gitBranch,
  gitDirty = false,
  gitAhead = 0,
  gitBehind = 0,
  bgTaskCount = 0,
  toasts = [],
  onDismissToast,
  tips = DEFAULT_TIPS,
}: StatusBarProps) {
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;

  // Tip rotation
  const [tipIndex, setTipIndex] = useState(0);
  useEffect(() => {
    if (tips.length === 0) return;
    const timer = setInterval(() => {
      setTipIndex((i) => (i + 1) % tips.length);
    }, TIP_ROTATE_MS);
    return () => clearInterval(timer);
  }, [tips.length]);

  // Auto-dismiss toasts
  useEffect(() => {
    if (toasts.length === 0 || !onDismissToast) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const toast of toasts) {
      const duration = toast.duration ?? 5000;
      if (duration > 0) {
        const elapsed = Date.now() - toast.createdAt;
        const remaining = Math.max(0, duration - elapsed);
        timers.push(setTimeout(() => onDismissToast(toast.id), remaining));
      }
    }
    return () => timers.forEach(clearTimeout);
  }, [toasts, onDismissToast]);

  // Context usage — match Python format: "context: 45.3% (28.5k/128k)"
  const contextUsage = status?.context_usage;
  const contextPercent =
    contextUsage != null ? `${(contextUsage * 100).toFixed(1)}%` : "0.0%";
  const contextTokens = status?.context_tokens;
  const maxContextTokens = status?.max_context_tokens;
  const contextDetail =
    contextTokens != null && maxContextTokens != null && maxContextTokens > 0
      ? ` (${formatTokenCount(contextTokens)}/${formatTokenCount(maxContextTokens)})`
      : "";

  // Shorten workDir
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const displayDir = workDir
    ? workDir.startsWith(home)
      ? "~" + workDir.slice(home.length)
      : workDir
    : "";

  // Git badge — match Python format: "main [± ↑1]"
  let gitBadge = "";
  if (gitBranch) {
    gitBadge = truncate(gitBranch, 22);
    const parts: string[] = [];
    if (gitDirty) parts.push("±");
    if (gitAhead > 0) parts.push(`↑${gitAhead}`);
    if (gitBehind > 0) parts.push(`↓${gitBehind}`);
    if (parts.length > 0) {
      gitBadge += ` [${parts.join(" ")}]`;
    }
  }

  // Build mode string — match Python: "agent (kimi-k2.5 ●)" / "shell"
  const thinkingDot = thinking ? "●" : "○";
  const modeStr = shellMode
    ? "shell"
    : modelName
      ? `agent (${modelName} ${thinkingDot})`
      : "agent";

  // Rotating tips (show 2 tips separated by |)
  let tipText = "";
  if (tips.length > 0) {
    const tip1 = tips[tipIndex % tips.length]!;
    if (tips.length > 1) {
      const tip2 = tips[(tipIndex + 1) % tips.length]!;
      tipText = `${tip1} | ${tip2}`;
    } else {
      tipText = tip1;
    }
  }

  // Left toast (first unexpired toast with position=left)
  const leftToast = toasts.find((t) => (t.position ?? "left") === "left");
  const leftToastText = leftToast
    ? `${leftToast.title}${leftToast.body ? `: ${leftToast.body}` : ""}`
    : "";

  // Right side: context info
  const rightText = `context: ${contextPercent}${contextDetail}`;

  // Separator
  const separator = "─".repeat(columns);

  return (
    <Box flexDirection="column">
      {/* Line 0: separator */}
      <Text color={DIM}>{separator}</Text>

      {/* Line 1: status indicators */}
      <Box justifyContent="space-between">
        <Box gap={2}>
          {yolo && (
            <Text color="yellow" bold>
              yolo
            </Text>
          )}
          {planMode && (
            <Text color="cyan" bold>
              plan
            </Text>
          )}
          <Text>{modeStr}</Text>
          {displayDir && <Text color={DIM}>{truncate(displayDir, 30)}</Text>}
          {gitBadge && <Text color="#a5d6a7">{gitBadge}</Text>}
          {bgTaskCount > 0 && (
            <Text color="#56a4ff">⚙ bash: {bgTaskCount}</Text>
          )}
          {isStreaming && (
            <Text color="#1e90ff">step {stepCount}</Text>
          )}
          {isCompacting && <Text color="yellow">compacting...</Text>}
        </Box>
        <Box>
          <Text color={DIM}>{tipText}</Text>
        </Box>
      </Box>

      {/* Line 2: left toast + right context */}
      <Box justifyContent="space-between">
        <Box>
          {leftToastText ? (
            <Text color={leftToast?.severity === "error" ? "#ff7b72" : leftToast?.severity === "warning" ? "#f2cc60" : "#56a4ff"}>
              {truncate(leftToastText, Math.max(0, columns - rightText.length - 4))}
            </Text>
          ) : (
            <Text> </Text>
          )}
        </Box>
        <Box>
          <Text color={DIM}>{rightText}</Text>
        </Box>
      </Box>
    </Box>
  );
}

/**
 * Format token count matching Python: 123, 28.5k, 1.2M
 * Drops trailing .0 (e.g. "128k" not "128.0k")
 */
function formatTokenCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) {
    const k = count / 1000;
    return k % 1 === 0 ? `${k}k` : `${k.toFixed(1)}k`;
  }
  const m = count / 1_000_000;
  return m % 1 === 0 ? `${m}M` : `${m.toFixed(1)}M`;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "…";
}
