/**
 * Table component -- renders a Markdown table with aligned columns.
 *
 * Calculates column widths based on content, renders header with a
 * separator line, and aligns cell content according to the table's
 * alignment specification.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Tokens, Token } from 'marked';

export interface TableProps {
  readonly token: Tokens.Table;
}

/**
 * Extract plain text from inline tokens for width calculation.
 */
function plainText(tokens: Token[]): string {
  return tokens
    .map((t) => {
      const asAny = t as { text?: string; tokens?: Token[] };
      if (asAny.tokens && asAny.tokens.length > 0) {
        return plainText(asAny.tokens);
      }
      return asAny.text ?? '';
    })
    .join('');
}

/**
 * Pad a string to a given width with alignment.
 */
function padCell(text: string, width: number, align: string | null): string {
  const diff = width - text.length;
  if (diff <= 0) return text;

  switch (align) {
    case 'right':
      return ' '.repeat(diff) + text;
    case 'center': {
      const left = Math.floor(diff / 2);
      const right = diff - left;
      return ' '.repeat(left) + text + ' '.repeat(right);
    }
    default:
      // 'left' or null
      return text + ' '.repeat(diff);
  }
}

export default function Table({ token }: TableProps): React.JSX.Element {
  const { header, rows, align } = token;

  // Calculate column widths.
  const colWidths: number[] = header.map((h) => plainText(h.tokens).length);
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      const cell = row[i]!;
      const w = plainText(cell.tokens).length;
      if (i < colWidths.length && w > colWidths[i]!) {
        colWidths[i] = w;
      }
    }
  }

  // Build header row.
  const headerCells = header.map((h, i) =>
    padCell(plainText(h.tokens), colWidths[i]!, align[i] ?? null),
  );
  const headerLine = `| ${headerCells.join(' | ')} |`;

  // Build separator.
  const sepCells = colWidths.map((w, i) => {
    const a = align[i];
    if (a === 'center') return `:${'-'.repeat(Math.max(1, w - 2))}:`;
    if (a === 'right') return `${'-'.repeat(Math.max(1, w - 1))}:`;
    if (a === 'left') return `:${'-'.repeat(Math.max(1, w - 1))}`;
    return '-'.repeat(w);
  });
  const sepLine = `| ${sepCells.join(' | ')} |`;

  // Build data rows.
  const dataLines = rows.map((row) => {
    const cells = row.map((cell, i) =>
      padCell(plainText(cell.tokens), colWidths[i]!, align[i] ?? null),
    );
    return `| ${cells.join(' | ')} |`;
  });

  return (
    <Box flexDirection="column">
      <Text bold>{headerLine}</Text>
      <Text dimColor>{sepLine}</Text>
      {dataLines.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
    </Box>
  );
}
