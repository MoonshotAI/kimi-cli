import type { ContentPart, Message, TextPart } from '@moonshot-ai/kosong';

import type { SummaryMessage } from './context-state.js';

export interface ContextSnapshot {
  readonly history: readonly Message[];
  readonly systemPrompt: string;
  readonly model: string;
  readonly activeTools: ReadonlySet<string>;
  readonly summary?: SummaryMessage;
}

export interface EphemeralInjection {
  kind: 'memory_recall' | 'system_reminder' | 'pending_notification';
  content: string | Record<string, unknown>;
  position?: 'before_user' | 'after_system';
}

export interface ProjectionOptions {
  model?: string;
  maxTokens?: number;
}

export interface ConversationProjector {
  project(
    snapshot: ContextSnapshot,
    ephemeralInjections: readonly EphemeralInjection[],
    options: ProjectionOptions,
  ): Message[];
}

/**
 * Phase 1 projector (§4.5.7). Responsibilities:
 *   - pass through persisted history
 *   - merge adjacent user messages with `\n\n` (Q6 decision)
 *   - inject ephemeralInjections as synthetic user messages so the LLM sees
 *     them without them ever touching the durable transcript
 *   - produce provider-neutral Message[]
 *
 * Not responsible for:
 *   - dangling tool call repair (belongs to Replay / Recovery)
 *   - provider-specific adaptation (belongs to Kosong)
 *   - any persistence side-effect (projector is pure read)
 */
export class DefaultConversationProjector implements ConversationProjector {
  project(
    snapshot: ContextSnapshot,
    ephemeralInjections: readonly EphemeralInjection[],
    _options: ProjectionOptions,
  ): Message[] {
    void _options;

    const merged = mergeAdjacentUserMessages(snapshot.history);

    if (ephemeralInjections.length === 0) {
      return merged;
    }

    const injectionMessages = ephemeralInjections.map((injection) => renderInjection(injection));
    // Default to prepending before the first user message (before_user), so
    // injections like system_reminder land at the top of the LLM input
    // without mutating the durable transcript.
    return [...injectionMessages, ...merged];
  }
}

function renderInjection(injection: EphemeralInjection): Message {
  const body =
    typeof injection.content === 'string' ? injection.content : JSON.stringify(injection.content);
  const prefix = injection.kind === 'system_reminder' ? '[system-reminder]\n' : '';
  const text =
    injection.kind === 'pending_notification' ? `[notification]\n${body}` : `${prefix}${body}`;
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
  };
}

function mergeAdjacentUserMessages(history: readonly Message[]): Message[] {
  const out: Message[] = [];
  for (const message of history) {
    const previous = out.at(-1);
    if (message.role === 'user' && previous !== undefined && previous.role === 'user') {
      out[out.length - 1] = mergeTwoUserMessages(previous, message);
      continue;
    }
    // Clone into a fresh Message so we never mutate input arrays.
    out.push(cloneMessage(message));
  }
  return out;
}

function mergeTwoUserMessages(a: Message, b: Message): Message {
  const aText = extractTextOnly(a);
  const bText = extractTextOnly(b);
  const nonTextParts = [
    ...a.content.filter((p) => p.type !== 'text'),
    ...b.content.filter((p) => p.type !== 'text'),
  ];
  const mergedText: TextPart = { type: 'text', text: `${aText}\n\n${bText}` };
  const content: ContentPart[] = [mergedText, ...nonTextParts];
  return {
    role: 'user',
    content,
    toolCalls: [],
  };
}

function extractTextOnly(message: Message): string {
  return message.content
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

function cloneMessage(message: Message): Message {
  return {
    role: message.role,
    ...(message.name !== undefined ? { name: message.name } : {}),
    content: message.content.map((p) => ({ ...p })) as ContentPart[],
    toolCalls: message.toolCalls.map((tc) => ({ ...tc })),
    ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
    ...(message.partial !== undefined ? { partial: message.partial } : {}),
  };
}
