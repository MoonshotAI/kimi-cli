import * as node_fs from 'node:fs';
import * as node_readline from 'node:readline';

import { getLogger } from './logger.js';
import type { ContentPart, Message, ToolCall } from './message.js';

// ── Storage Interface ─────────────────────────────────────────────────

/** Result of {@link LinearStorage.restore}. */
export interface LinearRestoreResult {
  messages: Message[];
  /** Token count last recorded via {@link LinearStorage.markTokenCount}, or `0`. */
  tokenCount: number;
}

export interface LinearStorage {
  append(message: Message): Promise<void>;
  /**
   * Restore all messages and any persisted token-count marker from storage.
   * Legacy storages that never persisted a token count return `tokenCount: 0`.
   */
  restore(): Promise<LinearRestoreResult>;
  clear(): Promise<void>;
  /** Persist a token-count marker (see {@link LinearContext.markTokenCount}). */
  markTokenCount(count: number): Promise<void>;
}

// ── MemoryLinearStorage ───────────────────────────────────────────────

export class MemoryLinearStorage implements LinearStorage {
  private _messages: Message[] = [];
  private _tokenCount = 0;

  async append(message: Message): Promise<void> {
    this._messages.push(message);
  }

  async restore(): Promise<LinearRestoreResult> {
    return { messages: [...this._messages], tokenCount: this._tokenCount };
  }

  async clear(): Promise<void> {
    this._messages = [];
    this._tokenCount = 0;
  }

  async markTokenCount(count: number): Promise<void> {
    this._tokenCount = count;
  }
}

// ── JsonlLinearStorage ────────────────────────────────────────────────

interface UsageRow {
  role: '_usage';
  token_count: number;
}

function isUsageRow(value: unknown): value is UsageRow {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return obj['role'] === '_usage' && typeof obj['token_count'] === 'number';
}

/**
 * Convert a raw parsed JSONL row into a TS {@link Message}. Accepts both the
 * TypeScript-native camelCase shape and the Python kosong snake_case shape
 * (including `tool_calls: null`, plain-string `content`, and `tool_call_id`).
 *
 * Writer output is always camelCase; this is a read-side compatibility layer
 * so TS can restore sessions written by the Python kosong library. See
 * decision D1 in docs/round-12-action-plan.md.
 */
function normalizeMessage(raw: unknown): Message {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Message row is not an object');
  }
  const obj = { ...(raw as Record<string, unknown>) };

  const role = obj['role'];
  if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') {
    throw new Error('Message row has an invalid role');
  }

  // content: string (Python single-TextPart shortcut) → [{type:'text', text}]
  const rawContent = obj['content'];
  let content: ContentPart[];
  if (typeof rawContent === 'string') {
    content = [{ type: 'text', text: rawContent }];
  } else if (rawContent === null || rawContent === undefined) {
    content = [];
  } else if (Array.isArray(rawContent)) {
    content = rawContent.map(normalizeContentPart);
  } else {
    throw new TypeError('Message row has an invalid content shape');
  }

  // tool_calls (snake_case) → toolCalls, preferring camelCase if both present.
  let toolCalls: ToolCall[];
  if (Array.isArray(obj['toolCalls'])) {
    toolCalls = obj['toolCalls'].map(normalizeToolCall);
  } else if (Array.isArray(obj['tool_calls'])) {
    toolCalls = obj['tool_calls'].map(normalizeToolCall);
  } else {
    if (
      obj['toolCalls'] !== undefined &&
      obj['toolCalls'] !== null &&
      !Array.isArray(obj['toolCalls'])
    ) {
      throw new Error('Message row has an invalid toolCalls shape');
    }
    if (
      obj['tool_calls'] !== undefined &&
      obj['tool_calls'] !== null &&
      !Array.isArray(obj['tool_calls'])
    ) {
      throw new Error('Message row has an invalid tool_calls shape');
    }
    toolCalls = [];
  }

  // tool_call_id (snake_case) → toolCallId
  let toolCallId: unknown;
  if (typeof obj['toolCallId'] === 'string') {
    toolCallId = obj['toolCallId'];
  } else if (typeof obj['tool_call_id'] === 'string') {
    toolCallId = obj['tool_call_id'];
  }

  delete obj['tool_calls'];
  delete obj['tool_call_id'];

  const normalized: Record<string, unknown> = {
    role,
    content,
    toolCalls,
  };
  if (typeof obj['name'] === 'string') {
    normalized['name'] = obj['name'];
  } else if (obj['name'] !== undefined && obj['name'] !== null) {
    throw new Error('Message row has an invalid name');
  }
  if (toolCallId !== undefined) {
    normalized['toolCallId'] = toolCallId;
  }
  if (typeof obj['partial'] === 'boolean') {
    normalized['partial'] = obj['partial'];
  } else if (obj['partial'] !== undefined && obj['partial'] !== null) {
    throw new Error('Message row has an invalid partial flag');
  }
  return normalized as unknown as Message;
}

function normalizeToolCall(raw: unknown): ToolCall {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Tool call is not an object');
  }
  const obj = raw as Record<string, unknown>;
  if (obj['type'] !== 'function') {
    throw new Error('Tool call has an invalid type');
  }
  if (typeof obj['id'] !== 'string') {
    throw new TypeError('Tool call is missing an id');
  }

  const fn = obj['function'];
  if (typeof fn !== 'object' || fn === null) {
    throw new Error('Tool call is missing a function payload');
  }
  const fnObj = fn as Record<string, unknown>;
  if (typeof fnObj['name'] !== 'string') {
    throw new TypeError('Tool call function is missing a name');
  }
  if (
    fnObj['arguments'] !== undefined &&
    fnObj['arguments'] !== null &&
    typeof fnObj['arguments'] !== 'string'
  ) {
    throw new Error('Tool call function arguments must be a string or null');
  }

  const normalized: ToolCall = {
    type: 'function',
    id: obj['id'],
    function: {
      name: fnObj['name'],
      arguments: typeof fnObj['arguments'] === 'string' ? fnObj['arguments'] : null,
    },
  };

  const extras = obj['extras'];
  if (extras !== undefined && extras !== null) {
    if (typeof extras !== 'object' || Array.isArray(extras)) {
      throw new TypeError('Tool call extras must be an object');
    }
    normalized.extras = extras as Record<string, unknown>;
  }
  return normalized;
}

function normalizeMediaPayload(
  raw: unknown,
  kind: 'image_url' | 'audio_url' | 'video_url',
): { url: string; id?: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${kind} payload must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj['url'] !== 'string') {
    throw new TypeError(`${kind} payload is missing a url`);
  }
  const normalized: { url: string; id?: string } = { url: obj['url'] };
  if (typeof obj['id'] === 'string') {
    normalized.id = obj['id'];
  } else if (obj['id'] !== undefined && obj['id'] !== null) {
    throw new Error(`${kind} payload has an invalid id`);
  }
  return normalized;
}

function normalizeContentPart(raw: unknown): ContentPart {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Content part is not an object');
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj['type'] !== 'string') {
    throw new TypeError('Content part is missing a type');
  }

  switch (obj['type']) {
    case 'text':
      if (typeof obj['text'] !== 'string') {
        throw new TypeError('Text part is missing text');
      }
      return { type: 'text', text: obj['text'] };

    case 'think': {
      if (typeof obj['think'] !== 'string') {
        throw new TypeError('Think part is missing think text');
      }
      const normalized: Extract<ContentPart, { type: 'think' }> = {
        type: 'think',
        think: obj['think'],
      };
      if (typeof obj['encrypted'] === 'string') {
        normalized.encrypted = obj['encrypted'];
      } else if (obj['encrypted'] !== undefined && obj['encrypted'] !== null) {
        throw new Error('Think part has an invalid encrypted payload');
      }
      return normalized;
    }

    case 'image_url':
      return {
        type: 'image_url',
        imageUrl: normalizeMediaPayload(obj['imageUrl'] ?? obj['image_url'], 'image_url'),
      };

    case 'audio_url':
      return {
        type: 'audio_url',
        audioUrl: normalizeMediaPayload(obj['audioUrl'] ?? obj['audio_url'], 'audio_url'),
      };

    case 'video_url':
      return {
        type: 'video_url',
        videoUrl: normalizeMediaPayload(obj['videoUrl'] ?? obj['video_url'], 'video_url'),
      };

    default:
      throw new Error(`Unknown content part type: ${obj['type']}`);
  }
}

export class JsonlLinearStorage implements LinearStorage {
  private readonly _filePath: string;

  constructor(filePath: string) {
    this._filePath = filePath;
  }

  async append(message: Message): Promise<void> {
    const line = JSON.stringify(message) + '\n';
    await node_fs.promises.appendFile(this._filePath, line, 'utf-8');
  }

  async markTokenCount(count: number): Promise<void> {
    const line = JSON.stringify({ role: '_usage', token_count: count }) + '\n';
    await node_fs.promises.appendFile(this._filePath, line, 'utf-8');
  }

  async restore(): Promise<LinearRestoreResult> {
    const messages: Message[] = [];
    let tokenCount = 0;
    let fileHandle: node_fs.promises.FileHandle | undefined;
    try {
      fileHandle = await node_fs.promises.open(this._filePath, 'r');
    } catch {
      return { messages, tokenCount };
    }
    try {
      const rl = node_readline.createInterface({
        input: fileHandle.createReadStream({ encoding: 'utf-8' }),
        crlfDelay: Infinity,
      });
      let lineNumber = 0;
      for await (const line of rl) {
        lineNumber += 1;
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch (error) {
          // A single corrupted line (e.g. truncated by a crashed writer)
          // must not destroy the whole session — skip and continue, but
          // surface the incident via the kosong logger so callers can
          // notice silent data loss.
          getLogger().warn(`Failed to parse JSONL line ${lineNumber} in ${this._filePath}`, {
            file: this._filePath,
            line: lineNumber,
            error: (error as Error).message,
          });
          continue;
        }
        if (isUsageRow(parsed)) {
          tokenCount = parsed.token_count;
          continue;
        }
        let msg: Message;
        try {
          msg = normalizeMessage(parsed);
        } catch (error) {
          getLogger().warn(`Failed to normalize JSONL line ${lineNumber} in ${this._filePath}`, {
            file: this._filePath,
            line: lineNumber,
            error: (error as Error).message,
          });
          continue;
        }
        messages.push(msg);
      }
    } finally {
      await fileHandle.close();
    }
    return { messages, tokenCount };
  }

  async clear(): Promise<void> {
    try {
      await node_fs.promises.unlink(this._filePath);
    } catch {
      // File may not exist — ignore.
    }
  }
}

// ── LinearContext ─────────────────────────────────────────────────────

export class LinearContext {
  private readonly _storage: LinearStorage;
  private _history: Message[] = [];
  private _tokenCount = 0;

  constructor(storage: LinearStorage) {
    this._storage = storage;
  }

  /**
   * Returns a defensive snapshot of the current history. Mutating the returned
   * array does NOT affect the internal state — callers must use
   * {@link addMessage} / {@link clear} / {@link restore} / {@link refreshHistory}
   * to change history.
   */
  get history(): Message[] {
    return [...this._history];
  }

  /** Last-known token count for this conversation (persisted via {@link markTokenCount}). */
  get tokenCount(): number {
    return this._tokenCount;
  }

  async addMessage(message: Message): Promise<void> {
    this._history.push(message);
    await this._storage.append(message);
  }

  /**
   * Record a token count for the current conversation state.
   *
   * The precision of the value is the caller's responsibility — kosong simply
   * persists whatever is passed in and exposes it via {@link tokenCount} after
   * the next {@link restore}.
   */
  async markTokenCount(count: number): Promise<void> {
    this._tokenCount = count;
    await this._storage.markTokenCount(count);
  }

  /** Restore history from storage. Returns `true` if any messages were restored. */
  async restore(): Promise<boolean> {
    const { messages, tokenCount } = await this._storage.restore();
    this._history = messages;
    this._tokenCount = tokenCount;
    return messages.length > 0;
  }

  /**
   * Reload the in-memory history from the backing storage.
   *
   * Useful when another LinearContext (or external process) has appended
   * messages to the same underlying storage: since {@link history} is a
   * local snapshot, mutations made elsewhere are not observed automatically.
   * Calling `refreshHistory` re-reads the storage and replaces the local
   * snapshot and token count.
   */
  async refreshHistory(): Promise<void> {
    const { messages, tokenCount } = await this._storage.restore();
    this._history = messages;
    this._tokenCount = tokenCount;
  }

  async clear(): Promise<void> {
    this._history = [];
    this._tokenCount = 0;
    await this._storage.clear();
  }
}
