import type { Message, StreamedMessagePart } from './message.js';
import type { ChatProvider, GenerateOptions, StreamedMessage, ThinkingEffort } from './provider.js';
import type { Tool } from './tool.js';
import type { TokenUsage } from './usage.js';

/**
 * A mock chat provider for testing.
 * Always returns the predefined message parts.
 */
export class MockChatProvider implements ChatProvider {
  readonly name: string = 'mock';
  readonly modelName: string;
  readonly thinkingEffort: ThinkingEffort | null = null;

  private readonly _parts: StreamedMessagePart[];
  private readonly _id: string;
  private readonly _usage: TokenUsage | null;

  constructor(
    parts: StreamedMessagePart[],
    options?: {
      id?: string;
      usage?: TokenUsage;
      modelName?: string;
    },
  ) {
    this._parts = parts;
    this._id = options?.id ?? 'mock';
    this._usage = options?.usage ?? null;
    this.modelName = options?.modelName ?? 'mock';
  }

  async generate(
    _systemPrompt: string,
    _tools: Tool[],
    _history: Message[],
    _options?: GenerateOptions,
  ): Promise<MockStreamedMessage> {
    return new MockStreamedMessage(this._parts, this._id, this._usage);
  }

  withThinking(_effort: ThinkingEffort): MockChatProvider {
    const opts: { id: string; usage?: TokenUsage; modelName: string } = {
      id: this._id,
      modelName: this.modelName,
    };
    if (this._usage !== null) {
      opts.usage = this._usage;
    }
    return new MockChatProvider([...this._parts], opts);
  }
}

/**
 * Streamed message implementation for MockChatProvider.
 */
class MockStreamedMessage implements StreamedMessage {
  readonly id: string;
  readonly usage: TokenUsage | null;

  private readonly _parts: StreamedMessagePart[];

  constructor(parts: StreamedMessagePart[], id: string, usage: TokenUsage | null) {
    this._parts = parts;
    this.id = id;
    this.usage = usage;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
    for (const part of this._parts) {
      yield part;
    }
  }
}
