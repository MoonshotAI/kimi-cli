/**
 * KosongCompactionProvider — real CompactionProvider that uses kosong's
 * `generate()` to produce a conversation summary (Slice 3.3 / M05).
 *
 * Replaces `createStubCompactionProvider()` from Slice 3 for production
 * use. The stub remains available for tests that do not need real LLM
 * interaction.
 *
 * The implementation mirrors Python's `SimpleCompaction.compact()`:
 *   1. Format the input messages into a single compaction prompt
 *   2. Call the LLM (via kosong generate) with a system prompt
 *   3. Extract the summary text from the response
 *   4. Return a `SummaryMessage` with the summary and metadata
 */

import { generate } from '@moonshot-ai/kosong';
import type { ChatProvider, Message } from '@moonshot-ai/kosong';

// ── Compaction types (moved here from src/soul/runtime.ts — Phase 20 §C.1 / R-3) ──
//
// Ownership: these interfaces describe a SoulPlus-owned capability that
// the Soul layer never directly executes. They live in this module (the
// real implementation site) and are re-exported from `src/soul/runtime.ts`
// for backward-compatible imports. The re-export is type-only, so
// TypeScript erases it and Soul gains no runtime reference to SoulPlus
// (铁律 3 preserved).

/**
 * v2 §附录 D.4 — the opaque summary carrier returned from compaction.
 * Slice 2 treats this as a data container; its final shape is reconciled
 * against Slice 1's `SummaryMessage` during Slice 6 (Compaction).
 */
export interface SummaryMessage {
  content: string;
  original_turn_count?: number | undefined;
  original_token_count?: number | undefined;
}

export interface CompactionOptions {
  targetTokens?: number | undefined;
  userInstructions?: string | undefined;
}

export interface CompactionProvider {
  /**
   * Run compaction on the given message history and return a single opaque
   * summary blob (SummaryMessage { content: string }).
   *
   * Contract (决策 #101): if the input `messages` array ends with an
   * **unpaired user message** (one without a following assistant response),
   * the implementation must preserve that user message verbatim in the
   * post-compaction conversation state, as a separate standalone message —
   * not folded / paraphrased / merely mentioned inside the summary text.
   *
   * Rationale: if a user types a short prompt at the tail of a
   * context-overflowing conversation and Soul triggers compaction on step 0,
   * the summary would absorb their prompt and the LLM would see no standalone
   * "pending user message" to respond to, causing the turn to end with no
   * response. TurnManager enforces this contract with a guard after calling
   * `run()` (see TurnManager.executeCompaction — tail user_message guard).
   */
  run(
    messages: Message[],
    signal: AbortSignal,
    options?: CompactionOptions,
  ): Promise<SummaryMessage>;
}

const COMPACTION_SYSTEM_PROMPT =
  'You are a helpful assistant that compacts conversation context. ' +
  'Summarize the conversation concisely while preserving all important ' +
  'details, decisions, code snippets, file paths, and action items.';

const COMPACTION_INSTRUCTION =
  'Summarize the above conversation. Preserve:\n' +
  '- Key decisions and their reasoning\n' +
  '- Important code snippets, file paths, and technical details\n' +
  '- Action items and their status\n' +
  '- Any constraints or requirements mentioned\n' +
  '\nBe concise but thorough. Do not lose critical context.';

/**
 * Build the compaction prompt from conversation messages.
 *
 * Each message is formatted as a numbered block with its role and text
 * content. Non-text content (images, tool calls, etc.) is omitted —
 * the summary is text-only, matching the Python implementation.
 */
function buildCompactionPrompt(messages: Message[], userInstructions?: string): string {
  const parts: string[] = [];

  for (const [i, msg] of messages.entries()) {
    const textParts = msg.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text);

    if (textParts.length > 0) {
      parts.push(`## Message ${i + 1}\nRole: ${msg.role}\nContent:\n${textParts.join('\n')}`);
    }
  }

  let prompt = parts.join('\n\n') + '\n\n' + COMPACTION_INSTRUCTION;

  if (userInstructions !== undefined && userInstructions.length > 0) {
    prompt +=
      "\n\n**User's Custom Compaction Instruction:**\n" +
      'The user has specifically requested the following focus during compaction. ' +
      'You MUST prioritize this instruction above the default compression priorities:\n' +
      userInstructions;
  }

  return prompt;
}

export class KosongCompactionProvider implements CompactionProvider {
  private readonly provider: ChatProvider;

  constructor(provider: ChatProvider) {
    this.provider = provider;
  }

  async run(
    messages: Message[],
    signal: AbortSignal,
    options?: CompactionOptions,
  ): Promise<SummaryMessage> {
    const promptText = buildCompactionPrompt(messages, options?.userInstructions);
    const compactionMessage: Message = {
      role: 'user',
      content: [{ type: 'text', text: promptText }],
      toolCalls: [],
    };

    const result = await generate(
      this.provider,
      COMPACTION_SYSTEM_PROMPT,
      [], // no tools
      [compactionMessage],
      undefined, // no callbacks
      { signal },
    );

    // Extract text content from the response, dropping think blocks
    const summaryText = result.message.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('\n');

    return {
      content: summaryText,
      original_turn_count: messages.length,
    };
  }
}

export function createKosongCompactionProvider(provider: ChatProvider): KosongCompactionProvider {
  return new KosongCompactionProvider(provider);
}
