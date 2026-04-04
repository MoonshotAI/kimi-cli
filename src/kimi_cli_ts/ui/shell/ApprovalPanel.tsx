/**
 * ApprovalPanel.tsx — Full approval request panel with React Ink.
 * Corresponds to Python's ui/shell/approval_panel.py.
 *
 * Features:
 * - 4 options: approve once, approve for session, reject, reject with feedback
 * - Content preview with line-budget truncation (diff, shell, brief)
 * - Inline feedback input with draft persistence
 * - Keyboard navigation (↑↓ or 1-4 number keys)
 */

import React, { useState, useCallback, useRef } from "react";
import { Box, Text } from "ink";
import { useInputLayer } from "./input-stack.ts";
import type {
  ApprovalRequest,
  ApprovalResponseKind,
  DisplayBlock,
  DiffDisplayBlock,
  ShellDisplayBlock,
  BriefDisplayBlock,
} from "../../wire/types";

const MAX_PREVIEW_LINES = 4;
const FEEDBACK_OPTION_INDEX = 3;

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

function ContentPreview({
  blocks,
  truncatedRef,
}: {
  blocks: DisplayBlock[];
  truncatedRef: React.MutableRefObject<boolean>;
}) {
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
        <Text key={`brief-${i}`} color="grey" italic>
          {showLines.join("\n")}
        </Text>,
      );
    }
  }

  truncatedRef.current = truncated;

  return (
    <Box flexDirection="column">
      {elements}
      {truncated && (
        <Text dimColor italic>
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
  // Feedback draft: persisted when navigating away from option 4
  const feedbackDraftRef = useRef("");
  const nonDiffTruncatedRef = useRef(false);

  const hasDiff = request.display.some((b) => b.type === "diff");
  const hasExpandableContent = hasDiff || nonDiffTruncatedRef.current;

  const submit = useCallback(
    (index: number) => {
      if (index === FEEDBACK_OPTION_INDEX) {
        setFeedbackMode(true);
        // Restore draft if available
        if (feedbackDraftRef.current) {
          setFeedbackText(feedbackDraftRef.current);
        }
        return;
      }
      feedbackDraftRef.current = "";
      onRespond(OPTIONS[index]!.response);
    },
    [onRespond],
  );

  useInputLayer((input, key) => {
    if (feedbackMode) {
      if (key.return) {
        // Only submit if non-empty (matches Python: empty enter does nothing)
        if (feedbackText.trim()) {
          feedbackDraftRef.current = "";
          onRespond("reject", feedbackText.trim());
        }
        return;
      }
      if (key.escape) {
        // Esc in feedback mode: reject with empty feedback
        feedbackDraftRef.current = "";
        onRespond("reject", "");
        return;
      }
      if (key.backspace || key.delete) {
        setFeedbackText((t) => t.slice(0, -1));
        return;
      }
      if (key.upArrow) {
        // Save draft, navigate away
        feedbackDraftRef.current = feedbackText;
        setFeedbackMode(false);
        setFeedbackText("");
        setSelectedIndex(
          (i) => (i - 1 + OPTIONS.length) % OPTIONS.length,
        );
        return;
      }
      if (key.downArrow) {
        feedbackDraftRef.current = feedbackText;
        setFeedbackMode(false);
        setFeedbackText("");
        setSelectedIndex((i) => (i + 1) % OPTIONS.length);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setFeedbackText((t) => t + input);
      }
      return;
    }

    // Normal navigation
    if (key.upArrow) {
      setSelectedIndex((prev) => {
        const next = (prev - 1 + OPTIONS.length) % OPTIONS.length;
        if (next === FEEDBACK_OPTION_INDEX && feedbackDraftRef.current) {
          setFeedbackMode(true);
          setFeedbackText(feedbackDraftRef.current);
        }
        return next;
      });
    } else if (key.downArrow) {
      setSelectedIndex((prev) => {
        const next = (prev + 1) % OPTIONS.length;
        if (next === FEEDBACK_OPTION_INDEX && feedbackDraftRef.current) {
          setFeedbackMode(true);
          setFeedbackText(feedbackDraftRef.current);
        }
        return next;
      });
    } else if (key.return) {
      submit(selectedIndex);
    } else if (key.escape) {
      onRespond("reject");
    } else if (input >= "1" && input <= "4") {
      const idx = parseInt(input) - 1;
      if (idx < OPTIONS.length) {
        setSelectedIndex(idx);
        if (idx === FEEDBACK_OPTION_INDEX) {
          setFeedbackMode(true);
          if (feedbackDraftRef.current) {
            setFeedbackText(feedbackDraftRef.current);
          }
        } else {
          submit(idx);
        }
      }
    }
  });

  // Check whether we have non-diff content blocks
  const hasNonDiffBlocks = request.display.some(
    (b) => b.type === "shell" || b.type === "brief",
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
    >
      {/* Title — matches Python Panel(title="⚠ ACTION REQUIRED", border_style="bold yellow") */}
      <Text color="yellow" bold>
        ⚠ ACTION REQUIRED
      </Text>
      <Text>{" "}</Text>

      {/* Request header — matches Python render() content_lines */}
      <Box paddingLeft={1} flexDirection="column">
        <Text color="yellow">
          {request.sender} is requesting approval to {request.action}:
        </Text>

        {/* Source metadata — matches Python _render_source_metadata_lines() */}
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

      <Text>{" "}</Text>

      {/* Description (only if no display blocks) — matches Python line 74-83 */}
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

      {/* Non-diff content preview (shell/brief) with line budget */}
      {hasNonDiffBlocks && (
        <Box paddingLeft={1}>
          <ContentPreview
            blocks={request.display}
            truncatedRef={nonDiffTruncatedRef}
          />
        </Box>
      )}

      <Text>{" "}</Text>

      {/* Options — matches Python render() menu section */}
      {OPTIONS.map((option, i) => {
        const num = i + 1;
        const isSelected = i === selectedIndex;
        const isFeedbackOption = i === FEEDBACK_OPTION_INDEX;

        // Feedback input line: → [4] Reject: {text}█
        if (isFeedbackOption && feedbackMode && isSelected) {
          return (
            <Text key={i} color="cyan">
              → [{num}] Reject: {feedbackText}█
            </Text>
          );
        }

        return (
          <Text key={i} color={isSelected ? "cyan" : "grey"}>
            {isSelected ? "→" : " "} [{num}] {option.label}
          </Text>
        );
      })}

      <Text>{" "}</Text>

      {/* Keyboard hints — matches Python render() hint lines */}
      {feedbackMode ? (
        <Text dimColor>
          {"  "}Type your feedback, then press Enter to submit.
        </Text>
      ) : (
        <Text dimColor>
          {"  "}▲/▼ select{"  "}1/2/3/4 choose{"  "}↵ confirm
          {hasExpandableContent ? "  ctrl-e expand" : ""}
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
