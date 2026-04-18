import { UNKNOWN_CAPABILITY, type ModelCapability } from '../capability.js';
import { APIStatusError } from '../errors.js';
import type { Message, StreamedMessagePart, ToolCall, ToolCallPart } from '../message.js';
import type {
  ChatProvider,
  FinishReason,
  GenerateOptions,
  RetryableChatProvider,
  StreamedMessage,
  ThinkingEffort,
} from '../provider.js';
import type { Tool } from '../tool.js';
import type { TokenUsage } from '../usage.js';

// ── Deterministic PRNG (mulberry32) ──────────────────────────────────

interface PRNG {
  next(): number;
}

// mulberry32 relies on bit-twiddling (`| 0`, `>>> 0`) for 32-bit integer
// semantics — `Math.trunc()` does not preserve the same behavior.
/* eslint-disable unicorn/prefer-math-trunc */
function createPRNG(seed: number | undefined): PRNG {
  if (seed === undefined) {
    return { next: () => Math.random() };
  }
  let s = seed | 0;
  return {
    next(): number {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}
/* eslint-enable unicorn/prefer-math-trunc */

// ── ChaosConfig ──────────────────────────────────────────────────────

/**
 * Configuration for {@link ChaosChatProvider}.
 *
 * All probabilities are in the `[0, 1]` range.
 */
export interface ChaosConfig {
  /** Probability of throwing an {@link APIStatusError} before the stream starts. */
  errorProbability: number;
  /** HTTP status codes randomly chosen when an error is injected. Defaults to `[429, 500, 502, 503]`. */
  errorTypes?: number[];
  /**
   * Probability of corrupting a tool call's `arguments` string by dropping the
   * trailing `}` character. Allows exercising downstream JSON-parse error paths.
   */
  corruptToolCallProbability?: number;
  /** Probability of throwing mid-stream after at least one part has been yielded. */
  streamErrorProbability?: number;
  /**
   * Deterministic seed for the internal PRNG. When set, two providers created
   * with the same seed and identical configuration produce identical chaos
   * decisions — required for reproducible tests.
   */
  seed?: number;
}

// ── ChaosChatProvider ───────────────────────────────────────────────

/**
 * A test utility chat provider that wraps a real provider and randomly
 * injects API errors, mid-stream failures, and corrupt tool call arguments.
 *
 * When {@link ChaosConfig.seed} is set, all chaos decisions are deterministic
 * so tests can reliably reproduce failure sequences.
 */
export class ChaosChatProvider implements ChatProvider, RetryableChatProvider {
  readonly name: string;
  private readonly _inner: ChatProvider;
  private readonly _config: ChaosConfig;
  private readonly _errorTypes: number[];
  private readonly _rng: PRNG;

  constructor(inner: ChatProvider, config: ChaosConfig | number) {
    this._inner = inner;
    this._config = typeof config === 'number' ? { errorProbability: config } : { ...config };
    this._errorTypes = this._config.errorTypes ?? [429, 500, 502, 503];
    this._rng = createPRNG(this._config.seed);
    this.name = inner.name;
  }

  get modelName(): string {
    return this._inner.modelName;
  }

  get thinkingEffort(): ThinkingEffort | null {
    return this._inner.thinkingEffort;
  }

  async generate(
    systemPrompt: string,
    tools: Tool[],
    history: Message[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage> {
    if (this._rng.next() < this._config.errorProbability) {
      const statusCode =
        this._errorTypes[Math.floor(this._rng.next() * this._errorTypes.length)] ?? 500;
      throw new APIStatusError(statusCode, `Chaos injected error ${statusCode}`);
    }
    const base = await this._inner.generate(systemPrompt, tools, history, options);
    const streamErrorProbability = this._config.streamErrorProbability ?? 0;
    const corruptToolCallProbability = this._config.corruptToolCallProbability ?? 0;
    if (streamErrorProbability === 0 && corruptToolCallProbability === 0) {
      return base;
    }
    return new ChaosStreamedMessage(
      base,
      this._rng,
      streamErrorProbability,
      corruptToolCallProbability,
      this._errorTypes,
    );
  }

  withThinking(effort: ThinkingEffort): ChaosChatProvider {
    return new ChaosChatProvider(this._inner.withThinking(effort), this._config);
  }

  getCapability(_model?: string): ModelCapability {
    // Chaos is intentionally capability-blind: tests that exercise chaos
    // should not also be entangled with capability-gating branches. The
    // inner provider's catalogue is deliberately not consulted here.
    return UNKNOWN_CAPABILITY;
  }

  onRetryableError(error: Error): boolean {
    const retryable = this._inner as Partial<RetryableChatProvider>;
    if (typeof retryable.onRetryableError !== 'function') {
      return false;
    }
    return retryable.onRetryableError(error);
  }
}

// ── ChaosStreamedMessage ────────────────────────────────────────────

/**
 * Streamed message wrapper that forwards parts from an inner stream while
 * randomly corrupting tool call arguments and injecting mid-stream errors.
 */
class ChaosStreamedMessage implements StreamedMessage {
  private readonly _wrapped: StreamedMessage;
  private readonly _rng: PRNG;
  private readonly _streamErrorProbability: number;
  private readonly _corruptToolCallProbability: number;
  private readonly _errorTypes: number[];

  constructor(
    wrapped: StreamedMessage,
    rng: PRNG,
    streamErrorProbability: number,
    corruptToolCallProbability: number,
    errorTypes: number[],
  ) {
    this._wrapped = wrapped;
    this._rng = rng;
    this._streamErrorProbability = streamErrorProbability;
    this._corruptToolCallProbability = corruptToolCallProbability;
    this._errorTypes = errorTypes;
  }

  get id(): string | null {
    return this._wrapped.id;
  }

  get usage(): TokenUsage | null {
    return this._wrapped.usage;
  }

  get finishReason(): FinishReason | null {
    return this._wrapped.finishReason;
  }

  get rawFinishReason(): string | null {
    return this._wrapped.rawFinishReason;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
    for await (const part of this._wrapped) {
      if (this._streamErrorProbability > 0 && this._rng.next() < this._streamErrorProbability) {
        const statusCode =
          this._errorTypes[Math.floor(this._rng.next() * this._errorTypes.length)] ?? 500;
        throw new APIStatusError(statusCode, `Chaos injected mid-stream error ${statusCode}`);
      }
      yield this._maybeCorruptToolCall(part);
    }
  }

  private _maybeCorruptToolCall(part: StreamedMessagePart): StreamedMessagePart {
    if (this._corruptToolCallProbability <= 0) {
      return part;
    }
    if (this._rng.next() >= this._corruptToolCallProbability) {
      return part;
    }
    if (part.type === 'function') {
      return this._corruptToolCall(part);
    }
    if (part.type === 'tool_call_part') {
      return this._corruptToolCallPart(part);
    }
    return part;
  }

  private _corruptToolCall(toolCall: ToolCall): StreamedMessagePart {
    const args = toolCall.function.arguments;
    if (args === null || args.length === 0) {
      return toolCall;
    }
    return {
      ...toolCall,
      function: { ...toolCall.function, arguments: args.slice(0, -1) },
    };
  }

  private _corruptToolCallPart(part: ToolCallPart): StreamedMessagePart {
    const args = part.argumentsPart;
    if (args === null || args.length === 0) {
      return part;
    }
    return { ...part, argumentsPart: args.slice(0, -1) };
  }
}
