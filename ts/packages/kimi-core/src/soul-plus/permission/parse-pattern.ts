/**
 * DSL parser for PermissionRule `pattern` strings (v2 §9-E.3.1).
 *
 * Grammar:
 *   pattern    := toolName ( "(" argPattern ")" )?
 *   toolName   := identifier characters (e.g. `Bash`, `mcp__github__*`)
 *   argPattern := any string (may start with `!` for negation)
 *
 * Examples:
 *   "Write"            → { toolName: "Write" }
 *   "Read(/etc/**)"    → { toolName: "Read", argPattern: "/etc/**" }
 *   "Bash(!rm *)"      → { toolName: "Bash", argPattern: "!rm *" }
 *   "mcp__github__*"   → { toolName: "mcp__github__*" }
 */

export interface ParsedPattern {
  readonly toolName: string;
  readonly argPattern?: string | undefined;
}

/**
 * Parse a DSL pattern. Throws on malformed input (missing closing paren,
 * empty tool name). The parser is the single source of truth for DSL
 * syntax and is exercised by table-driven tests.
 */
export function parsePattern(pattern: string): ParsedPattern {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) {
    throw new Error('permission pattern: empty string');
  }

  const openIdx = trimmed.indexOf('(');
  if (openIdx === -1) {
    return { toolName: trimmed };
  }

  if (!trimmed.endsWith(')')) {
    throw new Error(`permission pattern: missing closing paren in "${pattern}"`);
  }

  const toolName = trimmed.slice(0, openIdx);
  const argPattern = trimmed.slice(openIdx + 1, -1);
  if (toolName.length === 0) {
    throw new Error(`permission pattern: empty tool name in "${pattern}"`);
  }
  // Empty arg pattern (`Read()`) is treated as "toolName only" — it
  // matches every call to that tool. This aligns with the intuition
  // that writing `Read()` is an odd but non-fatal way of saying `Read`.
  return { toolName, argPattern: argPattern.length > 0 ? argPattern : undefined };
}
