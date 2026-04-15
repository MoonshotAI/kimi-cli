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

import type { CompactionOptions, CompactionProvider, SummaryMessage } from '../soul/index.js';

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
