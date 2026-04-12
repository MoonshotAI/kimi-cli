import {
  APIConnectionError as OpenAIConnectionError,
  APIConnectionTimeoutError as OpenAITimeoutError,
  APIError as OpenAIAPIError,
  OpenAIError,
} from 'openai';

import {
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  ChatProviderError,
} from '../errors.js';
import { extractText } from '../message.js';
import type { ContentPart, Message } from '../message.js';
import type { ThinkingEffort } from '../provider.js';
import type { Tool } from '../tool.js';
import type { TokenUsage } from '../usage.js';

// ── Content part conversion ──────────────────────────────────────────

export interface OpenAIContentPart {
  type: string;
  text?: string | undefined;
  image_url?: { url: string; id?: string | null } | undefined;
  audio_url?: { url: string; id?: string | null } | undefined;
  video_url?: { url: string; id?: string | null } | undefined;
}

/**
 * Convert a kosong `ContentPart` to OpenAI-compatible content part.
 * Returns `null` for think parts (handled separately as reasoning_content).
 */
export function convertContentPart(part: ContentPart): OpenAIContentPart | null {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'think':
      // Think parts are handled separately as reasoning_content — skip them here.
      return null;
    case 'image_url':
      return {
        type: 'image_url',
        image_url:
          part.imageUrl.id === undefined
            ? { url: part.imageUrl.url }
            : { url: part.imageUrl.url, id: part.imageUrl.id },
      };
    case 'audio_url':
      return {
        type: 'audio_url',
        audio_url:
          part.audioUrl.id === undefined
            ? { url: part.audioUrl.url }
            : { url: part.audioUrl.url, id: part.audioUrl.id },
      };
    case 'video_url':
      return {
        type: 'video_url',
        video_url:
          part.videoUrl.id === undefined
            ? { url: part.videoUrl.url }
            : { url: part.videoUrl.url, id: part.videoUrl.id },
      };
  }
}

// ── Tool conversion ───────────────────────────────────────────────────

export interface OpenAIToolParam {
  type: string;
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/**
 * Convert a kosong `Tool` to OpenAI tool format.
 */
export function toolToOpenAI(tool: Tool): OpenAIToolParam {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

// ── Error conversion ──────────────────────────────────────────────────

const NETWORK_RE = /network|connection|connect|disconnect/i;
const TIMEOUT_RE = /timed?\s*out|timeout|deadline/i;

function classifyBaseApiError(message: string): ChatProviderError {
  if (TIMEOUT_RE.test(message)) {
    return new APITimeoutError(message);
  }
  if (NETWORK_RE.test(message)) {
    return new APIConnectionError(message);
  }
  return new ChatProviderError(`Error: ${message}`);
}

/**
 * Convert an OpenAI SDK error (or raw Error) to a kosong `ChatProviderError`.
 */
export function convertOpenAIError(error: unknown): ChatProviderError {
  // v6: APIConnectionTimeoutError extends APIConnectionError, check timeout first
  if (error instanceof OpenAITimeoutError) {
    return new APITimeoutError(error.message);
  }
  if (error instanceof OpenAIConnectionError) {
    return new APIConnectionError(error.message);
  }
  // APIError with a status code => status error
  if (error instanceof OpenAIAPIError && error.status !== undefined) {
    const reqId = error.requestID ?? null;
    return new APIStatusError(error.status, error.message, reqId);
  }
  // Base APIError with no status and no body => transport-layer failure.
  // When the error has a body (e.g. SSE error events from the server),
  // skip the heuristic to avoid misclassifying server-side errors.
  if (
    error instanceof OpenAIAPIError &&
    error.constructor === OpenAIAPIError &&
    error.error === undefined
  ) {
    return classifyBaseApiError(error.message);
  }
  if (error instanceof OpenAIError) {
    return new ChatProviderError(`Error: ${error.message}`);
  }
  if (error instanceof Error) {
    return new ChatProviderError(`Error: ${error.message}`);
  }
  return new ChatProviderError(`Error: ${String(error)}`);
}

// ── Function tool call guard ─────────────────────────────────────────

/** Shape of a function-type tool call (subset used by the guard). */
export interface FunctionToolCallShape {
  type: 'function';
  id: string;
  function: { name: string; arguments: string | null };
}

/**
 * Type guard: narrow a tool call union to the function-type variant.
 * Works with OpenAI SDK's `ChatCompletionMessageToolCall` as well as
 * any object carrying `{ type: string }`.
 */
export function isFunctionToolCall<T extends { type: string }>(
  tc: T,
): tc is T & FunctionToolCallShape {
  return tc.type === 'function';
}

// ── Thinking effort mapping ───────────────────────────────────────────

/**
 * Map kosong `ThinkingEffort` to OpenAI `reasoning_effort` string.
 */
export function thinkingEffortToReasoningEffort(effort: ThinkingEffort): string | undefined {
  switch (effort) {
    case 'off':
      return undefined;
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
  }
}

/**
 * Map OpenAI `reasoning_effort` string back to kosong `ThinkingEffort`.
 */
export function reasoningEffortToThinkingEffort(
  reasoning: string | undefined,
): ThinkingEffort | null {
  if (reasoning === undefined || reasoning === null) {
    return null;
  }
  switch (reasoning) {
    case 'low':
    case 'minimal':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
    case 'xhigh':
      return 'high';
    case 'none':
      return 'off';
    default:
      return 'off';
  }
}

// ── Usage extraction ──────────────────────────────────────────────────

/**
 * Extract `TokenUsage` from an OpenAI-compatible usage object.
 */
export function extractUsage(usage: unknown): TokenUsage | null {
  if (usage === null || usage === undefined || typeof usage !== 'object') {
    return null;
  }
  const u = usage as Record<string, unknown>;
  const promptTokens = typeof u['prompt_tokens'] === 'number' ? u['prompt_tokens'] : 0;
  const completionTokens = typeof u['completion_tokens'] === 'number' ? u['completion_tokens'] : 0;

  let cached = 0;
  // Moonshot proprietary: top-level cached_tokens
  if (typeof u['cached_tokens'] === 'number') {
    cached = u['cached_tokens'];
  } else if (
    typeof u['prompt_tokens_details'] === 'object' &&
    u['prompt_tokens_details'] !== null
  ) {
    const details = u['prompt_tokens_details'] as Record<string, unknown>;
    if (typeof details['cached_tokens'] === 'number') {
      cached = details['cached_tokens'];
    }
  }

  return {
    inputOther: promptTokens - cached,
    output: completionTokens,
    inputCacheRead: cached,
    inputCacheCreation: 0,
  };
}

// ── Tool message content conversion ──────────────────────────────────

/**
 * Strategy for converting tool-role message content.
 *
 * - `'extract_text'`: flatten all content parts into a single text string
 *   (some providers require tool results as plain text).
 * - `null`: convert content parts to the standard OpenAI content-part array.
 */
export type ToolMessageConversion = 'extract_text' | null;

/**
 * Convert tool-role message content according to the chosen strategy.
 */
export function convertToolMessageContent(
  message: Message,
  conversion: ToolMessageConversion,
): string | OpenAIContentPart[] {
  if (conversion === 'extract_text') {
    return extractText(message);
  }
  return message.content.map(convertContentPart).filter((p): p is OpenAIContentPart => p !== null);
}
