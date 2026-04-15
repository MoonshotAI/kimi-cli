/**
 * ApprovalPanel component -- interactive approval request UI.
 *
 * Wire 2.1: Approval comes as a Core-initiated request (type: 'request',
 * method: 'approval.request'). The response is sent via
 * wireClient.respondToRequest().
 *
 * Displays a bordered panel with:
 *  - Description of the requested action
 *  - Display blocks (diff preview, shell commands, brief text)
 *  - 4 options navigable via arrow keys, number keys, or shortcut keys
 *
 * Options:
 *  1. Approve once (y)
 *  2. Approve for this session (a)
 *  3. Reject (n)
 *  4. Reject with feedback (f)
 */

import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';

import type { PendingApproval } from '../../app/context.js';
import type { ApprovalResponseData, DisplayBlock } from '../../wire/index.js';
import DiffPreview from './DiffPreview.js';

// ── Types ────────────────────────────────────────────────────────────

export type ApprovalDecision = 'approved' | 'approved_for_session' | 'rejected';

interface ApprovalOption {
  label: string;
  shortcut: string;
  decision: ApprovalDecision;
  isFeedback: boolean;
}

const APPROVAL_OPTIONS: ApprovalOption[] = [
  { label: 'Approve once', shortcut: 'y', decision: 'approved', isFeedback: false },
  { label: 'Approve for this session', shortcut: 'a', decision: 'approved_for_session', isFeedback: false },
  { label: 'Reject', shortcut: 'n', decision: 'rejected', isFeedback: false },
  { label: 'Reject with feedback', shortcut: 'f', decision: 'rejected', isFeedback: true },
];

// ── Component Props ──────────────────────────────────────────────────

export interface ApprovalPanelProps {
  /** The pending approval request. */
  readonly request: PendingApproval;
  /** Callback when the user responds to the approval. */
  readonly onResponse: (response: ApprovalResponseData) => void;
}

// ── Display Block Renderer ───────────────────────────────────────────

function DisplayBlockView({ block }: { readonly block: DisplayBlock }): React.JSX.Element | null {
  switch (block.type) {
    case 'diff':
      return <DiffPreview block={{
        type: 'diff',
        path: block.path,
        oldText: block.old_text,
        newText: block.new_text,
        oldStart: block.old_start,
        newStart: block.new_start,
        isSummary: block.is_summary,
      }} />;
    case 'shell':
      return (
        <Box>
          <Text color="gray">{`$ ${block.command}`}</Text>
        </Box>
      );
    case 'brief':
      return block.text ? (
        <Box>
          <Text color="gray">{block.text}</Text>
        </Box>
      ) : null;
    default:
      return null;
  }
}

// ── ApprovalPanel ────────────────────────────────────────────────────

export default function ApprovalPanel({
  request,
  onResponse,
}: ApprovalPanelProps): React.JSX.Element {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');

  const { data } = request;

  const submit = useCallback(
    (index: number, feedback: string = '') => {
      const option = APPROVAL_OPTIONS[index];
      if (!option) return;
      onResponse({
        response: option.decision,
        feedback: feedback || undefined,
      });
    },
    [onResponse],
  );

  const selectAndSubmit = useCallback(
    (index: number) => {
      const option = APPROVAL_OPTIONS[index];
      if (!option) return;
      if (option.isFeedback) {
        setSelectedIndex(index);
        setFeedbackMode(true);
      } else {
        submit(index);
      }
    },
    [submit],
  );

  useInput((input, key) => {
    // In feedback mode, handle text editing
    if (feedbackMode) {
      if (key.return) {
        // Submit with feedback
        submit(selectedIndex, feedbackText);
        return;
      }
      if (key.escape) {
        // Cancel feedback, go back to menu
        setFeedbackMode(false);
        setFeedbackText('');
        return;
      }
      if (key.upArrow) {
        setFeedbackMode(false);
        setSelectedIndex((prev) => (prev - 1 + APPROVAL_OPTIONS.length) % APPROVAL_OPTIONS.length);
        return;
      }
      if (key.downArrow) {
        setFeedbackMode(false);
        setSelectedIndex((prev) => (prev + 1) % APPROVAL_OPTIONS.length);
        return;
      }
      if (key.backspace || key.delete) {
        setFeedbackText((prev) => prev.slice(0, -1));
        return;
      }
      // Regular character input
      if (input.length > 0 && !key.ctrl && !key.meta && !key.tab) {
        setFeedbackText((prev) => prev + input);
      }
      return;
    }

    // Normal menu navigation
    if (key.upArrow) {
      setSelectedIndex((prev) => (prev - 1 + APPROVAL_OPTIONS.length) % APPROVAL_OPTIONS.length);
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((prev) => (prev + 1) % APPROVAL_OPTIONS.length);
      return;
    }
    if (key.return) {
      selectAndSubmit(selectedIndex);
      return;
    }

    // Number keys 1-4
    if (input === '1') { selectAndSubmit(0); return; }
    if (input === '2') { selectAndSubmit(1); return; }
    if (input === '3') { selectAndSubmit(2); return; }
    if (input === '4') { selectAndSubmit(3); return; }

    // Shortcut keys y/a/n/f
    if (input === 'y') { selectAndSubmit(0); return; }
    if (input === 'a') { selectAndSubmit(1); return; }
    if (input === 'n') { selectAndSubmit(2); return; }
    if (input === 'f') { selectAndSubmit(3); return; }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingLeft={1}
      paddingRight={1}
      marginTop={1}
    >
      {/* Title */}
      <Box marginBottom={1}>
        <Text color="yellow" bold>approval</Text>
      </Box>

      {/* Description */}
      <Box marginLeft={1}>
        <Text color="yellow">
          {data.tool_name} is requesting approval to {data.action}:
        </Text>
      </Box>
      {data.description ? (
        <Box marginLeft={1}>
          <Text color="gray">{data.description}</Text>
        </Box>
      ) : null}

      {/* Display blocks */}
      {data.display.length > 0 ? (
        <Box flexDirection="column" marginLeft={1} marginTop={1}>
          {data.display.map((block, idx) => (
            <DisplayBlockView key={`display-${idx}`} block={block} />
          ))}
        </Box>
      ) : null}

      {/* Options */}
      <Box flexDirection="column" marginTop={1}>
        {APPROVAL_OPTIONS.map((option, idx) => {
          const isSelected = idx === selectedIndex;
          const num = idx + 1;

          if (feedbackMode && option.isFeedback && isSelected) {
            // Show inline feedback input
            return (
              <Box key={option.shortcut}>
                <Text color="cyan">
                  {`\u2192 [${num}] Reject: ${feedbackText}\u2588`}
                </Text>
              </Box>
            );
          }

          return (
            <Box key={option.shortcut}>
              {isSelected ? (
                <Text color="cyan">{`\u2192 [${num}] ${option.label}`}</Text>
              ) : (
                <Text color="gray">{`  [${num}] ${option.label}`}</Text>
              )}
            </Box>
          );
        })}
      </Box>

      {/* Keyboard hints */}
      <Box marginTop={1}>
        {feedbackMode ? (
          <Text dimColor>  Type your feedback, then press Enter to submit.</Text>
        ) : (
          <Text dimColor>  {'\u25B2'}/{'\u25BC'} select  1/2/3/4 choose  y/a/n/f shortcut  {'\u21B5'} confirm</Text>
        )}
      </Box>
    </Box>
  );
}

export { APPROVAL_OPTIONS };
export type { ApprovalOption };
