/**
 * ApprovalPanel.tsx — Full approval request panel with React Ink.
 * Corresponds to Python's ui/shell/approval_panel.py.
 *
 * Features:
 * - 4 options: approve once (y), approve for session (a), reject (n), reject with feedback (f)
 * - Diff preview panel
 * - Inline feedback input
 * - Truncation with expand hint
 * - Keyboard navigation (↑↓ or 1-4 number keys)
 */

import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import type {
  ApprovalRequest,
  ApprovalResponseKind,
  DisplayBlock,
  DiffDisplayBlock,
  ShellDisplayBlock,
  BriefDisplayBlock,
} from "../../wire/types";

const MAX_PREVIEW_LINES = 4;

interface ApprovalOption {
  label: string;
  response: ApprovalResponseKind;
}

const OPTIONS: ApprovalOption[] = [
  { label: "Approve once", response: "approve" },
  { label: "Approve for this session", response: "approve_for_session" },
  { label: "Reject", response: "reject" },
  { label: "Reject, tell the model what to do instead", response: "reject" },
];

const FEEDBACK_OPTION_INDEX = 3;

// ── DiffPreview ──────────────────────────────────────────

function DiffPreview({ blocks }: { blocks: DisplayBlock[] }) {
  const diffBlocks = blocks.filter(
    (b): b is DiffDisplayBlock => b.type === "diff",
  );
  if (diffBlocks.length === 0) return null;

  // Group by path
  const byPath = new Map<string, DiffDisplayBlock[]>();
  for (const block of diffBlocks) {
    const existing = byPath.get(block.path) || [];
    existing.push(block);
    byPath.set(block.path, existing);
  }

  return (
    <Box flexDirection="column">
      {[...byPath.entries()].map(([path, diffs]) => (
        <Box key={path} flexDirection="column">
          <Text color="cyan" bold>
            {path}
          </Text>
          {diffs.map((diff, idx) => (
            <Box key={idx} flexDirection="column">
              {diff.old_text
                .split("\n")
                .slice(0, MAX_PREVIEW_LINES)
                .map((line, lineIdx) => (
                  <Text key={`old-${lineIdx}`} color="#ff7b72">
                    - {line}
                  </Text>
                ))}
              {diff.new_text
                .split("\n")
                .slice(0, MAX_PREVIEW_LINES)
                .map((line, lineIdx) => (
                  <Text key={`new-${lineIdx}`} color="#56d364">
                    + {line}
                  </Text>
                ))}
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

// ── ContentPreview ───────────────────────────────────────

function ContentPreview({ blocks }: { blocks: DisplayBlock[] }) {
  let budget = MAX_PREVIEW_LINES;
  let truncated = false;
  const elements: React.ReactNode[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (budget <= 0) {
      truncated = true;
      break;
    }

    if (!block) continue;
    if (block.type === "shell") {
      const shellBlock = block as ShellDisplayBlock;
      const lines = shellBlock.command.trim().split("\n");
      const showLines = lines.slice(0, budget);
      if (lines.length > budget) truncated = true;
      budget -= showLines.length;
      elements.push(
        <Text key={`shell-${i}`} color="grey">
          {showLines.join("\n")}
        </Text>,
      );
    } else if (block.type === "brief") {
      const briefBlock = block as BriefDisplayBlock;
      const lines = briefBlock.brief.trim().split("\n");
      const showLines = lines.slice(0, budget);
      if (lines.length > budget) truncated = true;
      budget -= showLines.length;
      elements.push(
        <Text key={`brief-${i}`} color="grey">
          {showLines.join("\n")}
        </Text>,
      );
    }
  }

  return (
    <Box flexDirection="column">
      {elements}
      {truncated && (
        <Text color="grey" dimColor italic>
          ... (truncated, ctrl-e to expand)
        </Text>
      )}
    </Box>
  );
}

// ── ApprovalPanel ────────────────────────────────────────

export interface ApprovalPanelProps {
  request: ApprovalRequest;
  onRespond: (
    decision: ApprovalResponseKind,
    feedback?: string,
  ) => void;
}

export function ApprovalPanel({ request, onRespond }: ApprovalPanelProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");

  const isFeedbackSelected = selectedIndex === FEEDBACK_OPTION_INDEX;

  const submit = useCallback(
    (index: number) => {
      if (index === FEEDBACK_OPTION_INDEX) {
        setFeedbackMode(true);
        return;
      }
      onRespond(OPTIONS[index]!.response);
    },
    [onRespond],
  );

  useInput((input, key) => {
    if (feedbackMode) {
      if (key.return) {
        if (feedbackText.trim()) {
          onRespond("reject", feedbackText.trim());
        }
        return;
      }
      if (key.escape) {
        onRespond("reject", "");
        return;
      }
      if (key.backspace || key.delete) {
        setFeedbackText((t) => t.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setFeedbackText((t) => t + input);
      }
      return;
    }

    // Normal navigation
    if (key.upArrow) {
      setSelectedIndex((i) => (i - 1 + OPTIONS.length) % OPTIONS.length);
    } else if (key.downArrow) {
      setSelectedIndex((i) => (i + 1) % OPTIONS.length);
    } else if (key.return) {
      submit(selectedIndex);
    } else if (key.escape) {
      onRespond("reject");
    } else if (input >= "1" && input <= "4") {
      const idx = parseInt(input) - 1;
      if (idx < OPTIONS.length) {
        setSelectedIndex(idx);
        if (idx !== FEEDBACK_OPTION_INDEX) {
          submit(idx);
        } else {
          setFeedbackMode(true);
        }
      }
    }
  });

  const hasDiff = request.display.some((b) => b.type === "diff");
  const hasContent =
    hasDiff ||
    !!request.description ||
    request.display.some((b) => b.type === "shell" || b.type === "brief");

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
    >
      {/* Title */}
      <Text color="yellow" bold>
        ⚠ ACTION REQUIRED
      </Text>
      <Text> </Text>

      {/* Request header */}
      <Box paddingLeft={1} flexDirection="column">
        <Text color="yellow">
          {request.sender} is requesting approval to {request.action}:
        </Text>

        {/* Source metadata */}
        {(request.subagent_type || request.agent_id) && (
          <Text color="grey">
            Subagent:{" "}
            {request.subagent_type && request.agent_id
              ? `${request.subagent_type} (${request.agent_id})`
              : request.subagent_type || request.agent_id}
          </Text>
        )}
        {request.source_description && (
          <Text color="grey">Task: {request.source_description}</Text>
        )}
      </Box>

      <Text> </Text>

      {/* Description */}
      {request.description && !request.display.length && (
        <Box paddingLeft={1}>
          <Text>{truncateLines(request.description, MAX_PREVIEW_LINES)}</Text>
        </Box>
      )}

      {/* Diff preview */}
      {hasDiff && (
        <Box paddingLeft={1}>
          <DiffPreview blocks={request.display} />
        </Box>
      )}

      {/* Non-diff content preview */}
      {request.display.some(
        (b) => b.type === "shell" || b.type === "brief",
      ) && (
        <Box paddingLeft={1}>
          <ContentPreview blocks={request.display} />
        </Box>
      )}

      <Text> </Text>

      {/* Options */}
      {OPTIONS.map((option, i) => {
        const num = i + 1;
        const isSelected = i === selectedIndex;
        const isFeedback = i === FEEDBACK_OPTION_INDEX;

        if (isFeedback && feedbackMode && isSelected) {
          return (
            <Text key={i} color="cyan">
              → [{num}] Reject: {feedbackText}█
            </Text>
          );
        }

        return (
          <Text
            key={i}
            color={isSelected ? "cyan" : "grey"}
          >
            {isSelected ? "→" : " "} [{num}] {option.label}
          </Text>
        );
      })}

      <Text> </Text>

      {/* Keyboard hints */}
      {feedbackMode ? (
        <Text dimColor>
          {"  "}Type your feedback, then press Enter to submit.
        </Text>
      ) : (
        <Text dimColor>
          {"  "}▲/▼ select {"  "}1/2/3/4 choose {"  "}↵ confirm
          {hasContent ? "  ctrl-e expand" : ""}
        </Text>
      )}
    </Box>
  );
}

// ── Helpers ──────────────────────────────────────────────

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join("\n") + "\n...";
}

export default ApprovalPanel;
