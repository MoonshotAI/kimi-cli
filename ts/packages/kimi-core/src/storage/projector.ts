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
    ephemeralInjections?: readonly EphemeralInjection[] | ProjectionOptions,
    options?: ProjectionOptions,
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
 * NOT responsible for system prompt injection — system prompt is forwarded
 * as a dedicated `ChatParams.systemPrompt` field to the provider (方案 B,
 * aligned with Python). This avoids double-injection: the provider receives
 * `systemPrompt` via its generate() first arg, so the history MUST NOT
 * contain a synthetic system message.
 *
 * Not responsible for:
 *   - dangling tool call repair (belongs to Replay / Recovery)
 *   - provider-specific adaptation (belongs to Kosong)
 *   - any persistence side-effect (projector is pure read)
 */
export class DefaultConversationProjector implements ConversationProjector {
  project(
    snapshot: ContextSnapshot,
    ephemeralInjectionsOrOptions?: readonly EphemeralInjection[] | ProjectionOptions,
    options?: ProjectionOptions,
  ): Message[] {
    // Phase 1 backward-compat: support both 2-arg and 3-arg signatures.
    // When called with 2 args as project(snapshot, options), the second
    // parameter is a plain object (not an array). Detect and route.
    const ephemeralInjections: readonly EphemeralInjection[] = Array.isArray(
      ephemeralInjectionsOrOptions,
    )
      ? ephemeralInjectionsOrOptions
      : [];
    void options;

    // Phase 25 K1 (slice 25c-4a) — defensive guard against any live
    // path that accidentally pushes a `partial: true` Message into
    // history. The replay-projector drops partial steps at the source
    // (C6 / H3) but this filter is the second line of defence so
    // partial messages never reach the LLM messages[] passed to the
    // provider.
    const nonPartial = snapshot.history.filter((m) => m.partial !== true);
    const merged = mergeAdjacentUserMessages(nonPartial);

    const injectionMessages =
      ephemeralInjections.length === 0
        ? []
        : ephemeralInjections.map((injection) => renderInjection(injection));

    // Ephemeral injections sit before the first history message
    // (before_user) so things like system_reminder land right before the
    // user turn they contextualise.
    return [...injectionMessages, ...merged];
  }
}

/**
 * Render an EphemeralInjection into a synthetic user message. Slice 2.4:
 *
 * Both `system_reminder` and `pending_notification` now render as
 * XML-wrapped payloads rather than bracket-prefixed free text. The
 * wrapper gives the LLM an unambiguous signal that the "user" message
 * it's reading is a system-injected annotation, not a genuine user
 * turn, and exposes the notification's metadata (id / category / type
 * / source) so the model can reason about it. The format is ported
 * from Python `kimi_cli/notifications/llm.py:21-29` +
 * `kimi_cli/soul/message.py:23-25`.
 *
 * `memory_recall` keeps its previous free-text rendering — there is no
 * Python precedent and the Slice 2.4 decision (Phase 2 MemoryRuntime is
 * deferred to D14) is to leave it unchanged.
 *
 * The merge-guard logic downstream (`mergeAdjacentUserMessages`) uses
 * the `<notification ` / `<system-reminder>` opening tag to detect
 * these messages, so the exact tag names are load-bearing for
 * projector correctness — do not rename without also updating
 * `isInjectionUserMessage` below.
 */
function renderInjection(injection: EphemeralInjection): Message {
  const text = renderInjectionText(injection);
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
  };
}

function renderInjectionText(injection: EphemeralInjection): string {
  const { kind, content } = injection;
  if (kind === 'pending_notification') {
    // `content` is expected to be the full NotificationData shape; we
    // accept a plain string as a degenerate fallback so tests that
    // pre-date Slice 2.4 (passing a bare string) still produce a
    // valid XML tag rather than crashing. Production callers always
    // pass the NotificationData object.
    if (typeof content === 'string') {
      return `<notification>\n${content}\n</notification>`;
    }
    return renderNotificationXml(content);
  }
  if (kind === 'system_reminder') {
    const body = typeof content === 'string' ? content : JSON.stringify(content);
    return `<system-reminder>\n${body}\n</system-reminder>`;
  }
  // memory_recall — free text, Slice 2.4 leaves unchanged
  const body = typeof content === 'string' ? content : JSON.stringify(content);
  return body;
}

function renderNotificationXml(data: Record<string, unknown>): string {
  // Pull the well-known attributes for the opening tag. Unknown /
  // extra fields stay in the body (Title / Severity / body text) so
  // downstream schema evolution is forward-compatible.
  const id = stringAttr(data['id'], 'unknown');
  const category = stringAttr(data['category'], 'unknown');
  const type = stringAttr(data['type'], 'unknown');
  const sourceKind = stringAttr(data['source_kind'], 'unknown');
  const sourceId = stringAttr(data['source_id'], 'unknown');
  const title = typeof data['title'] === 'string' ? data['title'] : '';
  const severity = typeof data['severity'] === 'string' ? data['severity'] : '';
  const body = typeof data['body'] === 'string' ? data['body'] : '';

  const lines: string[] = [
    `<notification id="${id}" category="${category}" type="${type}" source_kind="${sourceKind}" source_id="${sourceId}">`,
  ];
  if (title.length > 0) lines.push(`Title: ${title}`);
  if (severity.length > 0) lines.push(`Severity: ${severity}`);
  if (body.length > 0) lines.push(body);

  // Slice 6.1 — append <task-notification> block with truncated tail
  // output when the notification originates from a background task.
  if (data['source_kind'] === 'background_task') {
    const tailRaw = typeof data['tail_output'] === 'string' ? data['tail_output'] : '';
    if (tailRaw.length > 0) {
      const truncated = truncateTailOutput(tailRaw, 20, 3000);
      lines.push('<task-notification>');
      lines.push(truncated);
      lines.push('</task-notification>');
    }
    // When tail is empty, skip the block entirely (no empty tags)
  }

  lines.push('</notification>');
  return lines.join('\n');
}

/**
 * Slice 6.1 — truncate tail output to at most `maxLines` lines and
 * `maxChars` characters. Takes the *last* N lines (tail), then trims
 * from the front if the character budget is exceeded.
 */
function truncateTailOutput(raw: string, maxLines: number, maxChars: number): string {
  const allLines = raw.split('\n');
  const tailLines = allLines.length > maxLines ? allLines.slice(-maxLines) : allLines;
  let result = tailLines.join('\n');
  if (result.length > maxChars) {
    result = result.slice(-maxChars);
  }
  return result;
}

function stringAttr(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  // Minimal attribute escaping — the notification tag never carries
  // HTML/XML-sensitive payload in practice (ids are hex, categories
  // are enums), but we still neutralise the double-quote and
  // ampersand boundaries just in case a downstream source_kind feeds
  // free text through.
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

/**
 * Detect whether a user message was produced by the ephemeral injection
 * pipeline (system_reminder or notification XML tag). Such messages
 * must never be merged with an adjacent real user turn — doing so would
 * smear the injection's XML wrapper into the user's actual prompt and
 * confuse the LLM about where the system annotation ends.
 *
 * Ported from Python `soul/dynamic_injection.py:54-66` (`is_notification_message` /
 * `is_system_reminder_message`).
 */
function isInjectionUserMessage(message: Message): boolean {
  if (message.role !== 'user') return false;
  const text = extractTextOnly(message);
  // Cheap leading-fragment check — injections always have the opening
  // tag at the start. We use `trimStart()` so leading whitespace
  // doesn't defeat the check, and require `'<notification '` (with
  // trailing space) so user text like `<notificationally` or the
  // bare `<notification>` tag (no attributes) is not misidentified.
  // Ported from Python `notifications/llm.py:73-77` which uses
  // `lstrip().startswith("<notification ")`.
  const trimmed = text.trimStart();
  if (trimmed.startsWith('<notification ')) return true;
  if (trimmed.startsWith('<system-reminder>')) return true;
  return false;
}

function mergeAdjacentUserMessages(history: readonly Message[]): Message[] {
  const out: Message[] = [];
  for (const message of history) {
    const previous = out.at(-1);
    if (
      message.role === 'user' &&
      previous !== undefined &&
      previous.role === 'user' &&
      !isInjectionUserMessage(message) &&
      !isInjectionUserMessage(previous)
    ) {
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
