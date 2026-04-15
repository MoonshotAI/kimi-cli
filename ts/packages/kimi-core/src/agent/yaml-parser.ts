/**
 * Purpose-built YAML parser for agent files — Slice 3.1.
 *
 * Supports the subset of YAML needed by agent.yaml files:
 *   - Top-level `key: value` scalars
 *   - Nested mappings (one level deep):  `tools:\n  include:\n    - a`
 *   - Block scalars: literal `|` and folded `>`
 *   - Block arrays: `key:\n  - a\n  - b`
 *   - Inline flow arrays: `key: [a, b, c]`
 *   - `#`-prefixed comments
 *   - Quoted strings (single/double)
 *
 * NOT supported: anchors, tags, multi-document, flow mappings, deep nesting (>2 levels).
 * Throws `AgentYamlError` for unsupported constructs.
 */

import { AgentYamlError } from './errors.js';

export function parseAgentYaml(text: string): Record<string, unknown> {
  const lines = text.split(/\r?\n/);
  const result: Record<string, unknown> = {};
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i]!;
    const line = stripComment(raw);
    const trimmed = line.trimEnd();

    // Skip blank lines
    if (trimmed.trim() === '') {
      i++;
      continue;
    }

    // Top-level keys must start at column 0
    if (/^\s/.test(trimmed)) {
      throw new AgentYamlError(`Unexpected indentation at line ${i + 1}: "${raw.trim()}"`);
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) {
      throw new AgentYamlError(`Missing ":" at line ${i + 1}: "${raw.trim()}"`);
    }

    const key = trimmed.slice(0, colonIdx).trim();
    const afterColon = trimmed.slice(colonIdx + 1).trim();

    if (key === '') {
      throw new AgentYamlError(`Empty key at line ${i + 1}`);
    }

    // Case 1: block scalar (| or >)
    if (afterColon === '|' || afterColon === '>') {
      const fold = afterColon === '>';
      const { value, nextIndex } = collectBlockScalar(lines, i + 1);
      result[key] = fold ? foldScalar(value) : value;
      i = nextIndex;
      continue;
    }

    // Case 2: value on the same line
    if (afterColon !== '') {
      result[key] = parseScalarOrInlineArray(afterColon, i + 1);
      i++;
      continue;
    }

    // Case 3: no value after colon — look ahead for nested content
    const nextIdx = peekNonBlank(lines, i + 1);
    if (nextIdx === -1) {
      // End of file — treat as null
      result[key] = null;
      i++;
      continue;
    }

    const nextLine = lines[nextIdx]!;
    const nextIndent = getIndent(nextLine);

    if (nextIndent === 0) {
      // Next non-blank line is a new top-level key — this key has null value
      result[key] = null;
      i++;
      continue;
    }

    // Check if it's a block array or nested mapping
    const strippedNext = stripComment(nextLine).trim();
    if (strippedNext.startsWith('- ') || strippedNext === '-') {
      // Block array at top level
      const { items, nextIndex } = collectBlockList(lines, nextIdx, nextIndent);
      result[key] = items;
      i = nextIndex;
      continue;
    }

    // Nested mapping (one level deep)
    const { mapping, nextIndex } = collectNestedMapping(lines, nextIdx, nextIndent);
    result[key] = mapping;
    i = nextIndex;
  }

  return result;
}

// ── Internal helpers ────────────────────────────────────────────────────

function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '#' && !inSingle && !inDouble) {
      return line.slice(0, i);
    }
  }
  return line;
}

function getIndent(line: string): number {
  let count = 0;
  for (const ch of line) {
    if (ch === ' ') count++;
    else if (ch === '\t') count += 2;
    else break;
  }
  return count;
}

function peekNonBlank(lines: readonly string[], start: number): number {
  for (let i = start; i < lines.length; i++) {
    if (lines[i]!.trim() !== '') return i;
  }
  return -1;
}

/**
 * Collect a literal block scalar. Lines must be indented deeper than
 * the parent key. The block ends when a line at the same or lesser
 * indentation is encountered (or EOF).
 */
function collectBlockScalar(
  lines: readonly string[],
  start: number,
): { value: string; nextIndex: number } {
  // Determine the indentation of the first content line
  const firstNonBlank = peekNonBlank(lines, start);
  if (firstNonBlank === -1) {
    return { value: '', nextIndex: lines.length };
  }

  const baseIndent = getIndent(lines[firstNonBlank]!);
  if (baseIndent === 0) {
    return { value: '', nextIndex: start };
  }

  const contentLines: string[] = [];
  let i = start;
  while (i < lines.length) {
    const raw = lines[i]!;
    // Blank lines inside block scalar are preserved
    if (raw.trim() === '') {
      contentLines.push('');
      i++;
      continue;
    }
    const indent = getIndent(raw);
    if (indent < baseIndent) break;
    // Strip the base indentation
    contentLines.push(raw.slice(baseIndent));
    i++;
  }

  // Trim trailing blank lines and add final newline
  while (contentLines.length > 0 && contentLines.at(-1) === '') {
    contentLines.pop();
  }

  return { value: contentLines.join('\n') + (contentLines.length > 0 ? '\n' : ''), nextIndex: i };
}

function foldScalar(literal: string): string {
  // Folded style: single newlines become spaces, double newlines become single newlines.
  // Use lookahead so the char after \n is not consumed — consecutive short lines fold correctly.
  return literal.replaceAll(/([^\n])\n(?=[^\n])/g, '$1 ');
}

function collectBlockList(
  lines: readonly string[],
  start: number,
  baseIndent: number,
): { items: unknown[]; nextIndex: number } {
  const items: unknown[] = [];
  let i = start;
  while (i < lines.length) {
    const raw = lines[i]!;
    if (raw.trim() === '') {
      i++;
      continue;
    }
    const indent = getIndent(raw);
    if (indent < baseIndent) break;

    const stripped = stripComment(raw).trim();
    const match = /^-\s*(.*)$/.exec(stripped);
    if (!match) break;

    const itemText = (match[1] ?? '').trim();
    items.push(parseScalar(itemText, i + 1));
    i++;
  }
  return { items, nextIndex: i };
}

function collectNestedMapping(
  lines: readonly string[],
  start: number,
  baseIndent: number,
): { mapping: Record<string, unknown>; nextIndex: number } {
  const mapping: Record<string, unknown> = {};
  let i = start;

  while (i < lines.length) {
    const raw = lines[i]!;
    if (raw.trim() === '') {
      i++;
      continue;
    }
    const indent = getIndent(raw);
    if (indent < baseIndent) break;

    const stripped = stripComment(raw).trimEnd();
    const content = stripped.trim();

    const colonIdx = content.indexOf(':');
    if (colonIdx === -1) {
      throw new AgentYamlError(`Missing ":" in nested mapping at line ${i + 1}: "${raw.trim()}"`);
    }

    const nKey = content.slice(0, colonIdx).trim();
    const afterColon = content.slice(colonIdx + 1).trim();

    if (nKey === '') {
      throw new AgentYamlError(`Empty key in nested mapping at line ${i + 1}`);
    }

    if (afterColon !== '') {
      mapping[nKey] = parseScalarOrInlineArray(afterColon, i + 1);
      i++;
      continue;
    }

    // Look ahead for block array under this nested key
    const nextIdx = peekNonBlank(lines, i + 1);
    if (nextIdx === -1) {
      mapping[nKey] = null;
      i++;
      continue;
    }

    const nextLine = lines[nextIdx]!;
    const nextInd = getIndent(nextLine);
    if (nextInd <= indent) {
      mapping[nKey] = null;
      i++;
      continue;
    }

    const nextStripped = stripComment(nextLine).trim();
    if (nextStripped.startsWith('- ') || nextStripped === '-') {
      const { items, nextIndex } = collectBlockList(lines, nextIdx, nextInd);
      mapping[nKey] = items;
      i = nextIndex;
      continue;
    }

    // Deeper nesting not supported
    throw new AgentYamlError(
      `Nesting deeper than 2 levels is not supported at line ${nextIdx + 1}: "${nextLine.trim()}"`,
    );
  }

  return { mapping, nextIndex: i };
}

function parseScalarOrInlineArray(text: string, lineNo: number): unknown {
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) {
      throw new AgentYamlError(`Unterminated inline array at line ${lineNo}: "${text}"`);
    }
    const inner = text.slice(1, -1).trim();
    if (inner === '') return [];
    return splitInlineArray(inner).map((s) => parseScalar(s.trim(), lineNo));
  }
  return parseScalar(text, lineNo);
}

function splitInlineArray(inner: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let buf = '';
  for (const ch of inner) {
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "'" && !inDouble) inSingle = !inSingle;
    if (!inSingle && !inDouble) {
      if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') depth--;
      else if (ch === ',' && depth === 0) {
        result.push(buf);
        buf = '';
        continue;
      }
    }
    buf += ch;
  }
  if (buf.trim() !== '') result.push(buf);
  return result;
}

function parseScalar(text: string, lineNo: number): unknown {
  if (text === '') return null;
  // Double-quoted string
  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2) {
      throw new AgentYamlError(`Unterminated double-quoted string at line ${lineNo}`);
    }
    return unescapeDoubleQuoted(text.slice(1, -1));
  }
  // Single-quoted string
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) {
      throw new AgentYamlError(`Unterminated single-quoted string at line ${lineNo}`);
    }
    return text.slice(1, -1).replaceAll("''", "'");
  }
  // Boolean
  if (text === 'true' || text === 'True') return true;
  if (text === 'false' || text === 'False') return false;
  // Null
  if (text === 'null' || text === '~' || text === 'Null') return null;
  // Integer
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  // Float
  if (/^-?\d+\.\d+$/.test(text)) return Number.parseFloat(text);
  // Bare string
  return text;
}

function unescapeDoubleQuoted(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\\' && i + 1 < text.length) {
      const next = text[i + 1]!;
      switch (next) {
        case 'n':
          out += '\n';
          break;
        case 't':
          out += '\t';
          break;
        case 'r':
          out += '\r';
          break;
        case '\\':
          out += '\\';
          break;
        case '"':
          out += '"';
          break;
        default:
          out += next;
      }
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}
