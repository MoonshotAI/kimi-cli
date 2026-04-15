/**
 * Minimal YAML frontmatter parser — Slice 2.5.
 *
 * Real SKILL.md files only use a small slice of YAML: top-level
 * scalar keys plus optional list values. kimi-core has no YAML
 * dependency and Slice 2.5 explicitly avoids adding one (the parser
 * runs on trusted user files at startup; a hand-rolled subset keeps
 * the bundle size flat). Supported:
 *
 *   - `---` fenced frontmatter at the top of the file
 *   - Top-level `key: value` scalar entries
 *   - Bare words / single-quoted / double-quoted scalars
 *   - Inline flow arrays:  `key: [a, b, c]`
 *   - Block arrays:        `key:\n  - a\n  - b`
 *   - `#`-prefixed comments (line-level only)
 *   - Keys that use `-` or `_` separators (parser preserves the raw
 *     form; kebab→camel normalisation happens in `parser.ts`)
 *
 * NOT supported (rejected with `FrontmatterError` — the skill is
 * then skipped at scan time): nested mappings, multi-line scalars,
 * anchors, tags, and any other advanced YAML construct. If a real
 * skill ever needs those, a proper YAML dependency is warranted.
 */

export class FrontmatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrontmatterError';
  }
}

export interface ParsedFrontmatter {
  /** Raw parsed frontmatter map. `null` when no frontmatter block is present. */
  readonly data: Record<string, unknown> | null;
  /** The markdown body (everything after the closing `---` fence). */
  readonly body: string;
}

const FENCE = '---';

export function parseFrontmatter(text: string): ParsedFrontmatter {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || lines[0]?.trim() !== FENCE) {
    return { data: null, body: text };
  }

  const yamlLines: string[] = [];
  let closeIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === FENCE) {
      closeIndex = i;
      break;
    }
    yamlLines.push(lines[i] ?? '');
  }
  if (closeIndex === -1) {
    return { data: null, body: text };
  }

  const body = lines.slice(closeIndex + 1).join('\n');
  const trimmed = yamlLines.join('\n').trim();
  if (trimmed.length === 0) {
    return { data: {}, body };
  }

  const data = parseYamlMapping(yamlLines);
  return { data, body };
}

/**
 * Parse a list of YAML lines into a flat mapping. Only supports the
 * subset documented at the top of this file. Throws
 * `FrontmatterError` on anything it cannot handle, rather than
 * silently dropping keys — upper layers catch the error and skip
 * the whole skill with a warning.
 */
function parseYamlMapping(lines: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i] ?? '';
    const line = stripComment(raw).replace(/\s+$/, '');
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Top-level keys must be unindented.
    if (/^\s/.test(line)) {
      throw new FrontmatterError(`Unexpected indentation at line ${i + 1}: "${line}"`);
    }

    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) {
      throw new FrontmatterError(`Missing ":" in line ${i + 1}: "${line}"`);
    }

    const key = line.slice(0, colonIndex).trim();
    const valueText = line.slice(colonIndex + 1).trim();

    if (key === '') {
      throw new FrontmatterError(`Empty key at line ${i + 1}`);
    }

    if (valueText === '') {
      // Possibly a block array on the following lines, otherwise null.
      const nextIdx = peekNonBlank(lines, i + 1);
      if (nextIdx !== -1 && /^\s*-\s/.test(lines[nextIdx] ?? '')) {
        const { items, nextIndex } = collectBlockList(lines, i + 1);
        result[key] = items;
        i = nextIndex;
        continue;
      }
      result[key] = null;
      i++;
      continue;
    }

    result[key] = parseScalarOrInlineArray(valueText, i + 1);
    i++;
  }
  return result;
}

function stripComment(line: string): string {
  // Strip `#` comments outside of quotes.
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '#' && !inSingle && !inDouble) {
      return line.slice(0, i);
    }
  }
  return line;
}

function peekNonBlank(lines: readonly string[], start: number): number {
  for (let i = start; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() !== '') return i;
  }
  return -1;
}

function collectBlockList(
  lines: readonly string[],
  start: number,
): { items: unknown[]; nextIndex: number } {
  const items: unknown[] = [];
  let i = start;
  while (i < lines.length) {
    const raw = lines[i] ?? '';
    const stripped = stripComment(raw).replace(/\s+$/, '');
    if (stripped.trim() === '') {
      i++;
      continue;
    }
    const match = /^(\s*)-\s*(.*)$/.exec(stripped);
    if (!match) {
      break;
    }
    const itemText = (match[2] ?? '').trim();
    items.push(parseScalar(itemText, i + 1));
    i++;
  }
  return { items, nextIndex: i };
}

function parseScalarOrInlineArray(text: string, lineNo: number): unknown {
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) {
      throw new FrontmatterError(`Unterminated inline array at line ${lineNo}: "${text}"`);
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
  // Quoted strings
  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2) {
      throw new FrontmatterError(`Unterminated double-quoted string at line ${lineNo}`);
    }
    return unescapeDoubleQuoted(text.slice(1, -1));
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) {
      throw new FrontmatterError(`Unterminated single-quoted string at line ${lineNo}`);
    }
    // Single-quoted YAML: only `''` is an escape for `'`.
    return text.slice(1, -1).replaceAll("''", "'");
  }
  // Booleans / null
  if (text === 'true' || text === 'True') return true;
  if (text === 'false' || text === 'False') return false;
  if (text === 'null' || text === '~' || text === 'Null') return null;
  // Number (int / float)
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (/^-?\d+\.\d+$/.test(text)) return Number.parseFloat(text);
  // Bare string
  return text;
}

function unescapeDoubleQuoted(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) {
      const next = text[i + 1] ?? '';
      switch (next) {
        case 'n': {
          out += '\n';
          break;
        }
        case 't': {
          out += '\t';
          break;
        }
        case 'r': {
          out += '\r';
          break;
        }
        case '\\': {
          out += '\\';
          break;
        }
        case '"': {
          out += '"';
          break;
        }
        default: {
          out += next;
        }
      }
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}
