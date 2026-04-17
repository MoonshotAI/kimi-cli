/**
 * MCP tool output conversion + output budget (v2 Slice 2.6 / §11).
 *
 * Ports Python `src/kimi_cli/soul/toolset.py:convert_mcp_tool_result`
 * (commits `d03315c7`, `73696fc8`, `682e9ef8`). Three invariants:
 *
 *   1. **Character budget.** All content shares a single
 *      {@link MCP_MAX_OUTPUT_CHARS}-char budget. Text parts are counted
 *      by `text.length`; image parts are counted by the length of their
 *      rendered `data:` URL. Exceeding blocks are truncated in place
 *      (text) or dropped entirely (image). A truncation notice is
 *      appended at the end when any block was affected.
 *   2. **Unsupported content is not a crash.** MCP may return content
 *      types kimi-core can't render directly (audio / video / blob
 *      resources with non-image mime / unknown types). These are
 *      replaced by a `[Unsupported content: ...]` text placeholder
 *      instead of throwing.
 *   3. **Error path parity.** `isError: true` results go through the
 *      exact same truncation logic; the resulting `ToolResult` keeps
 *      `isError: true`.
 *
 * The budget cap exists to prevent MCP servers like Playwright from
 * blowing up the LLM context window with full DOM dumps or 500 KB
 * screenshots. 100 K characters is a deliberate choice: wider than the
 * 50 K that the built-in `ToolResultBuilder` uses because multi-part
 * MCP results (text + image) are common, but narrow enough that a
 * single oversized payload cannot monopolise context.
 */

import type { ToolResult, ToolResultContent } from '../../soul/types.js';

/**
 * Maximum characters allowed in a single MCP tool result. Text is
 * counted by `text.length`; images are counted by the length of the
 * rendered `data:<mime>;base64,<data>` URL.
 *
 * Python parity: `MCP_MAX_OUTPUT_CHARS = 100_000` in
 * `src/kimi_cli/soul/toolset.py:653`.
 */
export const MCP_MAX_OUTPUT_CHARS = 100_000;

/**
 * Structural subset of the MCP SDK `CallToolResult.content` block
 * union. Covers every shape the SDK currently emits (text / image /
 * audio / resource / resource_link) plus unknown `type` values for
 * forward compatibility.
 *
 * Declared as a local interface so this module does not depend on
 * `@modelcontextprotocol/sdk` at compile time — tests can fabricate
 * result objects without loading the SDK.
 */
export interface McpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  resource?: {
    uri?: string;
    text?: string;
    blob?: string;
    mimeType?: string;
  };
  [key: string]: unknown;
}

export interface McpToolResultInput {
  content: readonly McpContentBlock[];
  isError?: boolean | undefined;
}

/**
 * Convert a raw MCP tool-call result into a kimi-core `ToolResult`,
 * applying the shared {@link MCP_MAX_OUTPUT_CHARS} budget.
 *
 * The returned `content` is always a `ToolResultContent[]` — a plain
 * string is never returned, because an MCP result can mix text and
 * images and because the trailing truncation notice is added as a
 * separate text part when any block is truncated or dropped.
 */
export function convertMcpToolResult(result: McpToolResultInput): ToolResult {
  const parts: ToolResultContent[] = [];
  let budget = MCP_MAX_OUTPUT_CHARS;
  let truncated = false;

  for (const block of result.content) {
    const converted = convertBlock(block);

    if (converted.type === 'text') {
      const text = converted.text;
      if (budget <= 0) {
        truncated = true;
        continue;
      }
      if (text.length > budget) {
        parts.push({ type: 'text', text: text.slice(0, budget) });
        budget = 0;
        truncated = true;
        continue;
      }
      parts.push(converted);
      budget -= text.length;
      continue;
    }

    // image / video part — budget cost = full data URL length
    const cost = mediaDataUrlLength(converted);
    if (cost > budget) {
      truncated = true;
      continue;
    }
    parts.push(converted);
    budget -= cost;
  }

  if (truncated) {
    parts.push({
      type: 'text',
      text:
        `\n\n[Output truncated: exceeded ${MCP_MAX_OUTPUT_CHARS} character limit. ` +
        'Use pagination or more specific queries to get remaining content.]',
    });
  }

  return {
    content: parts,
    isError: result.isError ?? false,
  };
}

/**
 * Convert a single MCP content block to a kimi-core
 * {@link ToolResultContent}.
 *
 * **Invariant: this function never throws.**
 *
 * Python's `convert_mcp_content` raises `ValueError` for unsupported
 * content types and the caller wraps it in `try/except` to swap in a
 * placeholder `TextPart`. Porting the control flow verbatim would
 * leak a throw point into a hot inner loop and force every call site
 * to repeat the same guard. Instead we hoist the placeholder
 * decision into this function's own branch table: every unsupported
 * shape returns a `[Unsupported content: ...]` text part directly,
 * and the caller ({@link convertMcpToolResult}) can treat the
 * function as total. A reader diff-ing this against the Python code
 * will notice the missing `raise` / `except`; that is deliberate.
 *
 * Exported for test inspection; callers should use
 * {@link convertMcpToolResult} which also applies the budget.
 */
export function convertBlock(block: McpContentBlock): ToolResultContent {
  const type = typeof block.type === 'string' ? block.type : '';

  if (type === 'text' && typeof block.text === 'string') {
    return { type: 'text', text: block.text };
  }

  if (type === 'image' && typeof block.data === 'string') {
    const mime = typeof block.mimeType === 'string' ? block.mimeType : 'image/png';
    return imagePart(block.data, mime);
  }

  if (type === 'resource' && block.resource !== undefined) {
    const res = block.resource;
    if (typeof res.text === 'string') {
      return { type: 'text', text: res.text };
    }
    if (typeof res.blob === 'string') {
      const mime = typeof res.mimeType === 'string' ? res.mimeType : '';
      if (mime.startsWith('image/')) {
        return imagePart(res.blob, mime);
      }
      return unsupportedPlaceholder(
        `resource blob with unsupported mime type "${mime || 'unknown'}"`,
      );
    }
    return unsupportedPlaceholder('resource with no text or blob payload');
  }

  if (type === 'resource_link') {
    const uri = typeof block.uri === 'string' ? block.uri : '(unknown uri)';
    return unsupportedPlaceholder(`resource_link to ${uri}`);
  }

  if (type === 'audio') {
    return unsupportedPlaceholder('audio content is not supported by kimi-core tool results');
  }

  if (type === '') {
    return unsupportedPlaceholder('unknown block type');
  }

  return unsupportedPlaceholder(`unknown content type "${type}"`);
}

function imagePart(data: string, mimeType: string): ToolResultContent {
  return {
    type: 'image',
    source: {
      type: 'base64',
      data,
      media_type: mimeType,
    },
  };
}

function unsupportedPlaceholder(reason: string): ToolResultContent {
  return { type: 'text', text: `[Unsupported content: ${reason}]` };
}

/**
 * Compute the rendered data-URL length for an image / video part.
 * Mirrors Python `_media_part_size` which measures
 * `len(part.image_url.url)` — the cost the media actually imposes on
 * the downstream LLM request payload.
 *
 * Phase 17 §E.3 — renamed from `imageDataUrlLength` and taught to
 * count `type: 'video'` parts the same way so future MCP video
 * responses don't silently bypass the budget.
 */
export function mediaDataUrlLength(part: ToolResultContent): number {
  if (part.type !== 'image' && part.type !== 'video') return 0;
  const mime = part.source.media_type;
  const data = part.source.data;
  // Format: `data:${mime};base64,${data}`
  return 'data:'.length + mime.length + ';base64,'.length + data.length;
}
