export type Role = 'system' | 'user' | 'assistant' | 'tool';

// ── Content Parts ──────────────────────────────────────────────────────

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ThinkPart {
  type: 'think';
  think: string;
  encrypted?: string; // Provider-specific reasoning signature
}

export interface ImageURLPart {
  type: 'image_url';
  imageUrl: { url: string; id?: string };
}

export interface AudioURLPart {
  type: 'audio_url';
  audioUrl: { url: string; id?: string };
}

export interface VideoURLPart {
  type: 'video_url';
  videoUrl: { url: string; id?: string };
}

/**
 * A single piece of content within a {@link Message}.
 *
 * The union covers text, model reasoning ("think"), images, audio, and video.
 * Providers convert these to their native content-block format during
 * {@link ChatProvider.generate}.
 */
export type ContentPart = TextPart | ThinkPart | ImageURLPart | AudioURLPart | VideoURLPart;

// ── Tool Calls ────────────────────────────────────────────���────────────

export interface ToolCallFunction {
  name: string;
  arguments: string | null;
}

export interface ToolCall {
  type: 'function';
  id: string;
  function: ToolCallFunction;
  extras?: Record<string, unknown>;
  /**
   * Provider-specific streaming index used to route argument deltas to the
   * correct parallel tool call. Set by streaming providers (OpenAI Chat
   * Completions `index`, Responses API `item_id`). Consumed internally by
   * {@link generate} and stripped before the ToolCall is stored on a Message.
   *
   * @internal
   */
  _streamIndex?: number | string;
}

/** Streaming delta for tool call arguments. */
export interface ToolCallPart {
  type: 'tool_call_part';
  argumentsPart: string | null;
  /**
   * Provider-specific index for routing this streaming delta to the correct
   * parallel tool call. Used by OpenAI Chat Completions (`index`) and
   * Responses API (`item_id`/`output_index`). When absent, the delta is
   * appended to the most-recently-seen ToolCall (single-tool-call fallback).
   */
  index?: number | string;
}

/**
 * A single chunk yielded by {@link StreamedMessage}'s async iterator.
 *
 * During streaming, the generate loop receives a sequence of these parts and
 * merges compatible consecutive parts (e.g. TextPart + TextPart) in-place so
 * the final {@link Message} contains fully-assembled content.
 */
export type StreamedMessagePart = ContentPart | ToolCall | ToolCallPart;

// ── Message ────────────────────────────────────────────────────────────

/**
 * A single message in a conversation.
 *
 * Messages carry a {@link role} (system, user, assistant, or tool), an array
 * of {@link ContentPart} content blocks, and optional {@link ToolCall} entries.
 * Tool result messages set {@link toolCallId} to correlate with the originating
 * call.
 */
export interface Message {
  /** The role of the message sender. */
  role: Role;
  /** Optional display name for the sender (used by some providers). */
  name?: string;
  /** Ordered content parts (text, images, thinking, etc.). */
  content: ContentPart[];
  /** Tool calls requested by the assistant in this message. */
  toolCalls: ToolCall[];
  /** For `tool` role messages, the ID of the tool call this result answers. */
  toolCallId?: string;
  /** When `true`, indicates the message was not fully received (e.g. stream interrupted). */
  partial?: boolean;
}

// ── Type Guards ────────────────────────────────────────────────────────

/** Check if a streamed part is a ContentPart (text, think, image_url, audio_url, video_url). */
export function isContentPart(part: StreamedMessagePart): part is ContentPart {
  const t = part.type;
  return (
    t === 'text' || t === 'think' || t === 'image_url' || t === 'audio_url' || t === 'video_url'
  );
}

/** Check if a streamed part is a ToolCall. */
export function isToolCall(part: StreamedMessagePart): part is ToolCall {
  return part.type === 'function';
}

/** Check if a streamed part is a ToolCallPart (streaming argument delta). */
export function isToolCallPart(part: StreamedMessagePart): part is ToolCallPart {
  return part.type === 'tool_call_part';
}

// ── Merge Logic ────────────────────────────────────────────────────────

/**
 * Merge `source` into `target` in-place for streaming accumulation.
 *
 * Supported combinations:
 * - TextPart + TextPart -> concatenate text
 * - ThinkPart + ThinkPart -> concatenate think (refuse if target.encrypted already set)
 * - ToolCall + ToolCallPart -> append arguments
 *
 * **Routing for parallel tool calls**: When OpenAI (or compatible) APIs stream
 * multiple tool calls in parallel, argument deltas may interleave across calls.
 * To handle this, {@link generate} routes ToolCallParts by their optional
 * {@link ToolCallPart.index} field (mirroring the provider's streaming index)
 * to the correct pending ToolCall, rather than relying on sequential ordering.
 * This function still performs sequential merging as a fallback when the
 * pending part matches the incoming one.
 *
 * Returns `true` if the merge was performed, `false` otherwise.
 */
export function mergeInPlace(target: StreamedMessagePart, source: StreamedMessagePart): boolean {
  // TextPart + TextPart
  if (target.type === 'text' && source.type === 'text') {
    target.text += source.text;
    return true;
  }

  // ThinkPart + ThinkPart
  if (target.type === 'think' && source.type === 'think') {
    if (target.encrypted !== undefined) {
      return false;
    }
    target.think += source.think;
    if (source.encrypted !== undefined) {
      target.encrypted = source.encrypted;
    }
    return true;
  }

  // ToolCall + ToolCallPart
  if (target.type === 'function' && source.type === 'tool_call_part') {
    if (source.argumentsPart !== null) {
      target.function.arguments =
        target.function.arguments === null
          ? source.argumentsPart
          : target.function.arguments + source.argumentsPart;
    }
    return true;
  }

  return false;
}

// ── Helper Functions ───────────────────────────────────────────────────

/**
 * Extract the concatenated text from a message's content parts.
 *
 * @param message The message to extract text from.
 * @param sep Separator between text parts. Defaults to empty string.
 */
export function extractText(message: Message, sep: string = ''): string {
  return message.content
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => part.text)
    .join(sep);
}

/**
 * @deprecated Use `extractText` instead.
 */
export function getTextContent(message: Message): string {
  return extractText(message);
}

/** Create a simple user message with a single text part. */
export function createUserMessage(content: string): Message {
  return {
    role: 'user',
    content: [{ type: 'text', text: content }],
    toolCalls: [],
  };
}

/** Create an assistant message from content parts and optional tool calls. */
export function createAssistantMessage(content: ContentPart[], toolCalls?: ToolCall[]): Message {
  return {
    role: 'assistant',
    content,
    toolCalls: toolCalls ?? [],
  };
}

/** Create a tool result message. */
export function createToolMessage(toolCallId: string, output: string | ContentPart[]): Message {
  const content: ContentPart[] =
    typeof output === 'string' ? [{ type: 'text', text: output }] : output;
  return {
    role: 'tool',
    content,
    toolCalls: [],
    toolCallId,
  };
}
