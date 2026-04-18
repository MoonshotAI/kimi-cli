import { UNKNOWN_CAPABILITY, type ModelCapability } from './capability.js';
import type { Message, StreamedMessagePart } from './message.js';
import type {
  ChatProvider,
  FinishReason,
  GenerateOptions,
  StreamedMessage,
  ThinkingEffort,
} from './provider.js';
import type { Tool } from './tool.js';
import type { TokenUsage } from './usage.js';

/**
 * Constructor options accepted by {@link MockChatProvider}.
 *
 * `finishReason` and `rawFinishReason` default to `'completed'` / `'stop'`
 * respectively so existing test fixtures continue to satisfy the
 * {@link StreamedMessage} contract without explicitly opting in.
 */
export interface MockChatProviderOptions {
  id?: string;
  usage?: TokenUsage;
  modelName?: string;
  finishReason?: FinishReason | null;
  rawFinishReason?: string | null;
}

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
  private readonly _finishReason: FinishReason | null;
  private readonly _rawFinishReason: string | null;

  constructor(parts: StreamedMessagePart[], options?: MockChatProviderOptions) {
    this._parts = parts;
    this._id = options?.id ?? 'mock';
    this._usage = options?.usage ?? null;
    this.modelName = options?.modelName ?? 'mock';
    this._finishReason =
      options !== undefined && 'finishReason' in options
        ? (options.finishReason ?? null)
        : 'completed';
    this._rawFinishReason =
      options !== undefined && 'rawFinishReason' in options
        ? (options.rawFinishReason ?? null)
        : 'stop';
  }

  async generate(
    _systemPrompt: string,
    _tools: Tool[],
    _history: Message[],
    _options?: GenerateOptions,
  ): Promise<MockStreamedMessage> {
    return new MockStreamedMessage(
      this._parts,
      this._id,
      this._usage,
      this._finishReason,
      this._rawFinishReason,
    );
  }

  getCapability(_model?: string): ModelCapability {
    return UNKNOWN_CAPABILITY;
  }

  withThinking(_effort: ThinkingEffort): MockChatProvider {
    const opts: MockChatProviderOptions = {
      id: this._id,
      modelName: this.modelName,
      finishReason: this._finishReason,
      rawFinishReason: this._rawFinishReason,
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
  readonly finishReason: FinishReason | null;
  readonly rawFinishReason: string | null;

  private readonly _parts: StreamedMessagePart[];

  constructor(
    parts: StreamedMessagePart[],
    id: string,
    usage: TokenUsage | null,
    finishReason: FinishReason | null,
    rawFinishReason: string | null,
  ) {
    this._parts = parts;
    this.id = id;
    this.usage = usage;
    this.finishReason = finishReason;
    this.rawFinishReason = rawFinishReason;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
    for (const part of this._parts) {
      yield part;
    }
  }
}
