import type { WireMessage } from '../wire/wire-message.js';
import type {
  ContentDeltaData,
  NotificationData,
  PlanDisplayData,
  SessionErrorData,
  ToolCallData,
  ToolCallDeltaData,
  ToolResultData,
} from '../wire/events.js';

// ── Exit codes ─────────────────────────────────────────────────────

export const ExitCode = {
  SUCCESS: 0,
  FAILURE: 1,
  RETRYABLE: 75,
} as const;

const RETRYABLE_ERROR_TYPES = new Set(['rate_limit']);

export function classifySessionError(data: SessionErrorData): number {
  if (data.error_type !== undefined && RETRYABLE_ERROR_TYPES.has(data.error_type)) {
    return ExitCode.RETRYABLE;
  }
  if (data.error_type === 'api_error') {
    return ExitCode.RETRYABLE;
  }
  return ExitCode.FAILURE;
}

// ── Printer interface ──────────────────────────────────────────────

export interface Printer {
  feed(msg: WireMessage): void;
  flush(): void;
}

// ── Helpers ────────────────────────────────────────────────────────

function writeJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// ── TextPrinter ────────────────────────────────────────────────────

export class TextPrinter implements Printer {
  private hasOutput = false;

  feed(msg: WireMessage): void {
    if (msg.method !== 'content.delta') return;
    const data = msg.data as ContentDeltaData;
    if (data.type !== 'text' || data.text === undefined) return;
    process.stdout.write(data.text);
    this.hasOutput = true;
  }

  flush(): void {
    if (this.hasOutput) {
      process.stdout.write('\n');
    }
  }
}

// ── JsonPrinter ────────────────────────────────────────────────────

interface ContentItem {
  type: string;
  text?: string;
  think?: string;
}

interface ToolCallItem {
  id: string;
  name: string;
  args: Record<string, unknown>;
  argsJson?: string;
}

export class JsonPrinter implements Printer {
  private contentBuffer: ContentItem[] = [];
  private toolCallBuffer: ToolCallItem[] = [];
  private pendingNotifications: NotificationData[] = [];
  private lastToolCall: ToolCallItem | null = null;

  feed(msg: WireMessage): void {
    switch (msg.method) {
      case 'step.begin':
      case 'step.interrupted':
        this.flushAssistantMessage();
        this.flushNotifications();
        break;

      case 'notification': {
        const notif = msg.data as NotificationData;
        if (this.contentBuffer.length > 0 || this.toolCallBuffer.length > 0) {
          this.pendingNotifications.push(notif);
        } else {
          this.flushAssistantMessage();
          this.flushNotifications();
          this.emitNotification(notif);
        }
        break;
      }

      case 'content.delta': {
        const delta = msg.data as ContentDeltaData;
        this.mergeContent(delta);
        break;
      }

      case 'tool.call': {
        const call = msg.data as ToolCallData;
        const item: ToolCallItem = { id: call.id, name: call.name, args: call.args };
        this.toolCallBuffer.push(item);
        this.lastToolCall = item;
        break;
      }

      case 'tool.call.delta': {
        if (this.lastToolCall === null) break;
        const part = msg.data as ToolCallDeltaData;
        this.lastToolCall.argsJson = (this.lastToolCall.argsJson ?? '') + part.args_part;
        break;
      }

      case 'tool.result': {
        this.flushAssistantMessage();
        this.flushNotifications();
        const result = msg.data as ToolResultData;
        writeJson({
          role: 'tool',
          tool_call_id: result.tool_call_id,
          content: result.output,
          ...(result.is_error ? { is_error: true } : {}),
        });
        break;
      }

      case 'plan.display': {
        this.flushAssistantMessage();
        this.flushNotifications();
        const plan = msg.data as PlanDisplayData;
        writeJson({ type: 'plan_display', content: plan.content, file_path: plan.file_path });
        break;
      }

      default:
        break;
    }
  }

  flush(): void {
    this.flushAssistantMessage();
    this.flushNotifications();
  }

  private mergeContent(delta: ContentDeltaData): void {
    if (delta.type === 'text' && delta.text !== undefined) {
      const last = this.contentBuffer[this.contentBuffer.length - 1];
      if (last !== undefined && last.type === 'text') {
        last.text = (last.text ?? '') + delta.text;
      } else {
        this.contentBuffer.push({ type: 'text', text: delta.text });
      }
    } else if (delta.type === 'think' && delta.think !== undefined) {
      const last = this.contentBuffer[this.contentBuffer.length - 1];
      if (last !== undefined && last.type === 'think') {
        last.think = (last.think ?? '') + delta.think;
      } else {
        this.contentBuffer.push({ type: 'think', think: delta.think });
      }
    }
  }

  private flushAssistantMessage(): void {
    if (this.contentBuffer.length === 0 && this.toolCallBuffer.length === 0) return;

    const content = this.contentBuffer.map((item) => {
      if (item.type === 'text') return { type: 'text', text: item.text };
      if (item.type === 'think') return { type: 'think', think: item.think };
      return item;
    });

    const toolCalls =
      this.toolCallBuffer.length > 0
        ? this.toolCallBuffer.map((tc) => {
            let args = tc.args;
            if (tc.argsJson !== undefined) {
              try {
                args = JSON.parse(tc.argsJson) as Record<string, unknown>;
              } catch {
                // keep original args
              }
            }
            return { id: tc.id, name: tc.name, args };
          })
        : undefined;

    writeJson({
      role: 'assistant',
      content,
      ...(toolCalls !== undefined ? { tool_calls: toolCalls } : {}),
    });

    this.contentBuffer = [];
    this.toolCallBuffer = [];
    this.lastToolCall = null;
  }

  private emitNotification(notif: NotificationData): void {
    writeJson(notif);
  }

  private flushNotifications(): void {
    for (const notif of this.pendingNotifications) {
      this.emitNotification(notif);
    }
    this.pendingNotifications = [];
  }
}

// ── FinalOnlyTextPrinter ───────────────────────────────────────────

export class FinalOnlyTextPrinter implements Printer {
  private textBuffer = '';

  feed(msg: WireMessage): void {
    switch (msg.method) {
      case 'step.begin':
      case 'step.interrupted':
        this.textBuffer = '';
        break;
      case 'content.delta': {
        const delta = msg.data as ContentDeltaData;
        if (delta.type === 'text' && delta.text !== undefined) {
          this.textBuffer += delta.text;
        }
        break;
      }
      default:
        break;
    }
  }

  flush(): void {
    if (this.textBuffer) {
      process.stdout.write(this.textBuffer + '\n');
      this.textBuffer = '';
    }
  }
}

// ── FinalOnlyJsonPrinter ───────────────────────────────────────────

export class FinalOnlyJsonPrinter implements Printer {
  private textBuffer = '';

  feed(msg: WireMessage): void {
    switch (msg.method) {
      case 'step.begin':
      case 'step.interrupted':
        this.textBuffer = '';
        break;
      case 'content.delta': {
        const delta = msg.data as ContentDeltaData;
        if (delta.type === 'text' && delta.text !== undefined) {
          this.textBuffer += delta.text;
        }
        break;
      }
      default:
        break;
    }
  }

  flush(): void {
    if (this.textBuffer) {
      writeJson({ role: 'assistant', content: this.textBuffer });
      this.textBuffer = '';
    }
  }
}

// ── Factory ────────────────────────────────────────────────────────

export type OutputFormat = 'text' | 'stream-json';

export function createPrinter(outputFormat: OutputFormat, finalOnly: boolean): Printer {
  if (finalOnly) {
    return outputFormat === 'text' ? new FinalOnlyTextPrinter() : new FinalOnlyJsonPrinter();
  }
  return outputFormat === 'text' ? new TextPrinter() : new JsonPrinter();
}
