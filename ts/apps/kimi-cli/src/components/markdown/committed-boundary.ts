/**
 * Committed boundary algorithm for incremental Markdown rendering.
 *
 * During streaming, we receive Markdown text incrementally. We need to
 * determine which portion of the text is "committed" (i.e., contains only
 * fully-closed block-level tokens that can be safely rendered as Markdown)
 * and which portion is "pending" (may contain incomplete blocks that should
 * be displayed as raw text to avoid rendering glitches).
 *
 * The algorithm uses marked's lexer to parse the text into tokens, then
 * finds the boundary between the second-to-last and last top-level blocks.
 * The last block is considered potentially incomplete during streaming.
 */

import { lexer, type Token, type TokensList } from 'marked';

export interface CommittedBoundaryResult {
  /** Text that can be safely rendered as Markdown. */
  committed: string;
  /** Text that may be incomplete and should be shown as raw text. */
  pending: string;
}

/**
 * Determine the committed boundary in streaming Markdown text.
 *
 * Uses marked's lexer to parse tokens and identifies the last fully-closed
 * block. The last block is assumed potentially incomplete (e.g., an unclosed
 * code fence, a list still being appended to, etc.).
 *
 * @param text - The accumulated streaming Markdown text.
 * @returns An object with `committed` and `pending` portions.
 */
export function committedBoundary(text: string): CommittedBoundaryResult {
  if (text.length === 0) {
    return { committed: '', pending: '' };
  }

  let tokens: TokensList;
  try {
    tokens = lexer(text);
  } catch {
    // If parsing fails entirely, treat everything as pending.
    return { committed: '', pending: text };
  }

  // Filter out 'space' tokens -- they are just whitespace separators, not blocks.
  const blockTokens = tokens.filter(
    (t: Token) => t.type !== 'space',
  );

  if (blockTokens.length < 2) {
    // With fewer than 2 blocks, we can't confidently commit anything.
    // The single block (or no block) might still be in progress.
    return { committed: '', pending: text };
  }

  // We commit everything except the last block.
  // To find the character offset, we sum up the `raw` lengths of all
  // committed blocks (including the space tokens between them).
  const lastBlockToken = blockTokens[blockTokens.length - 1]!;
  const lastBlockRaw = lastBlockToken.raw;

  // Find where the last block starts in the original text.
  // We search from the end to handle any edge cases with repeated content.
  const lastBlockStart = text.lastIndexOf(lastBlockRaw);

  if (lastBlockStart <= 0) {
    // Can't find boundary or it's at the very start -- nothing to commit.
    return { committed: '', pending: text };
  }

  const committed = text.slice(0, lastBlockStart);
  const pending = text.slice(lastBlockStart);

  return { committed, pending };
}
