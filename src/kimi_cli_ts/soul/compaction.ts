/**
 * Compaction — corresponds to Python soul/compaction.py
 * Summarizes conversation history when context window is getting full.
 * Supports preserved messages: the last N user/assistant turns are kept verbatim.
 */

import type { LLM } from "../llm.ts";
import type { Message } from "../types.ts";
import type { Context } from "./context.ts";
import { logger } from "../utils/logging.ts";

/** Default number of recent user/assistant turns to preserve during compaction. */
const DEFAULT_MAX_PRESERVED_MESSAGES = 2;

/**
 * Estimate tokens from message text content using a character-based heuristic.
 * ~4 chars per token for English; somewhat underestimates for CJK text.
 */
export function estimateTextTokens(messages: readonly Message[]): number {
  let totalChars = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      totalChars += msg.content.length;
    } else {
      for (const part of msg.content) {
        if (part.type === "text") {
          totalChars += part.text.length;
        }
      }
    }
  }
  return Math.floor(totalChars / 4);
}

/**
 * Prepare messages for compaction by splitting into to-compact and to-preserve.
 * Preserves the last `maxPreservedMessages` user/assistant turns verbatim.
 */
export function prepareCompaction(
  messages: readonly Message[],
  maxPreservedMessages = DEFAULT_MAX_PRESERVED_MESSAGES,
): { toCompact: Message[]; toPreserve: Message[] } {
  if (!messages.length || maxPreservedMessages <= 0) {
    return { toCompact: [], toPreserve: [...messages] };
  }

  const history = [...messages];
  let preserveStartIndex = history.length;
  let nPreserved = 0;

  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index]!.role === "user" || history[index]!.role === "assistant") {
      nPreserved++;
      if (nPreserved === maxPreservedMessages) {
        preserveStartIndex = index;
        break;
      }
    }
  }

  if (nPreserved < maxPreservedMessages) {
    return { toCompact: [], toPreserve: [...messages] };
  }

  const toCompact = history.slice(0, preserveStartIndex);
  const toPreserve = history.slice(preserveStartIndex);

  if (toCompact.length === 0) {
    return { toCompact: [], toPreserve };
  }

  return { toCompact, toPreserve };
}

/**
 * Simple compaction strategy: ask the LLM to summarize the conversation.
 * Preserves recent messages verbatim.
 */
export async function compactContext(
  context: Context,
  llm: LLM,
  opts?: {
    focus?: string;
    maxPreservedMessages?: number;
    onBegin?: () => void;
    onEnd?: () => void;
  },
): Promise<void> {
  const history = context.history;
  if (history.length === 0) return;

  opts?.onBegin?.();

  try {
    const maxPreserved = opts?.maxPreservedMessages ?? DEFAULT_MAX_PRESERVED_MESSAGES;
    const { toCompact, toPreserve } = prepareCompaction(history, maxPreserved);

    // Nothing to compact — preserve all
    if (toCompact.length === 0) {
      return;
    }

    // Build summary request from to-compact messages
    const summaryPrompt = buildSummaryPrompt(toCompact, opts?.focus);

    // Ask LLM to summarize
    let summary = "";
    try {
      const stream = llm.chat(
        [{ role: "user", content: summaryPrompt }],
        {
          system:
            "You are a helpful assistant that compacts conversation context.",
          maxTokens: 4096,
        },
      );

      for await (const chunk of stream) {
        if (chunk.type === "text") {
          summary += chunk.text;
        }
      }
    } catch (err) {
      logger.warn(`Compaction LLM call failed, using fallback: ${err}`);
      summary = buildFallbackSummary(toCompact);
    }

    // Clear context and inject summary + preserved messages
    await context.compact();

    if (summary) {
      await context.appendMessage({
        role: "user",
        content: `<system>Previous context has been compacted. Here is the compaction output:</system>\n${summary}`,
      });
    }

    // Re-append preserved messages
    for (const msg of toPreserve) {
      await context.appendMessage(msg);
    }
  } finally {
    opts?.onEnd?.();
  }
}

function buildSummaryPrompt(
  messages: readonly Message[],
  focus?: string,
): string {
  const parts: string[] = [];

  // Build structured input matching Python's format
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    parts.push(`## Message ${i + 1}\nRole: ${msg.role}\nContent:`);
    if (typeof msg.content === "string") {
      parts.push(msg.content);
    } else {
      for (const part of msg.content) {
        if (part.type === "text") {
          parts.push(part.text);
        }
      }
    }
  }

  let promptText = "\n" + COMPACT_PROMPT;
  if (focus) {
    promptText +=
      "\n\n**User's Custom Compaction Instruction:**\n" +
      "The user has specifically requested the following focus during compaction. " +
      "You MUST prioritize this instruction above the default compression priorities:\n" +
      focus;
  }
  parts.push(promptText);

  return parts.join("\n");
}

const COMPACT_PROMPT = `Summarize the conversation above concisely. Preserve:
- Key decisions and outcomes
- Important file paths and code changes
- Tool call results that are still relevant
- Any pending tasks or goals
Be thorough but concise.`;

function buildFallbackSummary(history: readonly Message[]): string {
  // Simple fallback: keep last few messages as summary
  const last = history.slice(-6);
  const parts = ["[Fallback summary - LLM compaction failed]"];

  for (const msg of last) {
    const content =
      typeof msg.content === "string"
        ? msg.content.slice(0, 500)
        : msg.content
            .map((p) => ("text" in p ? p.text : `[${p.type}]`))
            .join("\n")
            .slice(0, 500);
    parts.push(`[${msg.role}]: ${content}`);
  }

  return parts.join("\n");
}

/**
 * Determine whether auto-compaction should be triggered.
 *
 * Returns true when either condition is met (whichever fires first):
 * - Ratio-based: tokenCount >= maxContextSize * triggerRatio
 * - Reserved-based: tokenCount + reservedContextSize >= maxContextSize
 */
export function shouldCompact(
  tokenCount: number,
  maxContextSize: number,
  reservedContextSize: number,
  triggerRatio: number,
): boolean {
  return (
    tokenCount >= maxContextSize * triggerRatio ||
    tokenCount + reservedContextSize >= maxContextSize
  );
}
