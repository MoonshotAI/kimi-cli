/**
 * DiffPreview component -- renders a unified diff with colored +/- lines.
 *
 * Parses old/new text using a SequenceMatcher-style algorithm (diffLines)
 * and renders:
 *  - Added lines in green with `+` prefix
 *  - Deleted lines in red with `-` prefix
 *  - Context lines in dim gray
 *
 * Mirrors the Python `render_diff_preview` from `diff_render.py`.
 */

import React from 'react';
import { Box, Text } from 'ink';

// ── DiffPreview Block (component-local, camelCase) ──────────────────

/**
 * Props interface for the diff block. Uses camelCase internally.
 * The caller (ApprovalPanel) maps from the Wire 2.1 snake_case
 * DiffDisplayBlock to this shape.
 */
export interface DiffPreviewBlock {
  type: 'diff';
  path: string;
  oldText: string;
  newText: string;
  oldStart?: number | undefined;
  newStart?: number | undefined;
  isSummary?: boolean | undefined;
}

// ── Diff Algorithm ───────────────────────────────────────────────────

export type DiffLineKind = 'context' | 'add' | 'delete';

export interface DiffLine {
  kind: DiffLineKind;
  lineNum: number;
  code: string;
}

/**
 * Compute a simple line-by-line diff between old and new text.
 * Returns an array of DiffLine objects.
 *
 * Uses a basic LCS approach: walk through both arrays and match equal lines.
 * For simplicity and correctness, we use a greedy algorithm similar to
 * Python's difflib.SequenceMatcher get_opcodes behavior.
 */
export function computeDiffLines(
  oldText: string,
  newText: string,
  oldStart: number = 1,
  newStart: number = 1,
): DiffLine[] {
  const oldLines = oldText ? oldText.split('\n') : [];
  const newLines = newText ? newText.split('\n') : [];

  // Simple LCS-based diff using dynamic programming
  const m = oldLines.length;
  const n = newLines.length;

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  // Backtrack to build diff
  const result: DiffLine[] = [];
  let i = m;
  let j = n;

  // Build in reverse, then reverse at the end
  const reversed: DiffLine[] = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      reversed.push({
        kind: 'context',
        lineNum: newStart + j - 1,
        code: newLines[j - 1]!,
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      reversed.push({
        kind: 'add',
        lineNum: newStart + j - 1,
        code: newLines[j - 1]!,
      });
      j--;
    } else {
      reversed.push({
        kind: 'delete',
        lineNum: oldStart + i - 1,
        code: oldLines[i - 1]!,
      });
      i--;
    }
  }

  // Reverse to get the correct order
  for (let k = reversed.length - 1; k >= 0; k--) {
    result.push(reversed[k]!);
  }

  return result;
}

/**
 * Compute diff stats from a list of DiffLines.
 */
export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === 'add') added++;
    if (line.kind === 'delete') removed++;
  }
  return { added, removed };
}

// ── Component Props ──────────────────────────────────────────────────

export interface DiffPreviewProps {
  /** The diff display block (camelCase props, mapped from wire format by caller). */
  readonly block: DiffPreviewBlock;
  /** Maximum number of changed lines to show. */
  readonly maxLines?: number;
}

// ── DiffPreview ──────────────────────────────────────────────────────

export default function DiffPreview({
  block,
  maxLines = 12,
}: DiffPreviewProps): React.JSX.Element {
  const { path, oldText, newText, oldStart, newStart } = block;
  const diffLines = computeDiffLines(
    oldText,
    newText,
    oldStart ?? 1,
    newStart ?? 1,
  );
  const stats = diffStats(diffLines);

  // Only show changed lines (not context) up to maxLines
  const changedLines = diffLines.filter((l) => l.kind !== 'context');
  const shownLines = changedLines.slice(0, maxLines);
  const remaining = changedLines.length - shownLines.length;

  return (
    <Box flexDirection="column">
      {/* Header: file path + stats */}
      <Box>
        <Text>
          {stats.added > 0 ? <Text color="green" bold>{`+${stats.added} `}</Text> : null}
          {stats.removed > 0 ? <Text color="red" bold>{`-${stats.removed} `}</Text> : null}
          <Text>{path}</Text>
        </Text>
      </Box>

      {/* Changed lines */}
      {shownLines.map((line, idx) => {
        const marker = line.kind === 'add' ? '+' : '-';
        const color = line.kind === 'add' ? 'green' : 'red';
        return (
          <Box key={`diff-${idx}`}>
            <Text color="gray">{String(line.lineNum).padStart(4)} </Text>
            <Text color={color}>{marker} </Text>
            <Text color={color}>{line.code}</Text>
          </Box>
        );
      })}

      {/* Overflow indicator */}
      {remaining > 0 ? (
        <Box>
          <Text dimColor italic>{`  ... ${remaining} more lines`}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
