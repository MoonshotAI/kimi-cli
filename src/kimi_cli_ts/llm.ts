/**
 * LLM abstraction layer — corresponds to Python's llm.py
 * Provides a unified interface for multiple LLM providers.
 */

import type { Message, ModelCapability, TokenUsage } from "./types";

// ── Provider Types ─────────────────────────────────────────

export type ProviderType =
  | "kimi"
  | "openai_legacy"
  | "openai_responses"
  | "anthropic"
  | "google_genai"
  | "gemini"
  | "vertexai"
  | "_echo"
  | "_scripted_echo"
  | "_chaos";

// ── Stream Chunk Types ─────────────────────────────────────

export interface TextChunk {
  type: "text";
  text: string;
}

export interface ThinkChunk {
  type: "think";
  text: string;
}

export interface ToolCallChunk {
  type: "tool_call";
  id: string;
  name: string;
  arguments: string;
}

export interface UsageChunk {
  type: "usage";
  usage: TokenUsage;
}

export interface DoneChunk {
  type: "done";
  messageId?: string;
}

export type StreamChunk =
  | TextChunk
  | ThinkChunk
  | ToolCallChunk
  | UsageChunk
  | DoneChunk;

// ── LLM Provider Interface ────────────────────────────────

export interface LLMProviderConfig {
  type: ProviderType;
  baseUrl: string;
  apiKey: string;
  customHeaders?: Record<string, string>;
  env?: Record<string, string>;
  oauth?: string | null;
}

export interface LLMModelConfig {
  model: string;
  provider: string;
  maxContextSize: number;
  capabilities?: ModelCapability[];
}

export interface ChatOptions {
  /** System prompt */
  system?: string;
  /** Generation temperature */
  temperature?: number;
  /** Top-p nucleus sampling */
  topP?: number;
  /** Maximum output tokens */
  maxTokens?: number;
  /** Enable/disable thinking */
  thinking?: "high" | "low" | "off";
  /** Tool definitions for the model */
  tools?: ToolDefinition[];
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Abstract interface for LLM providers.
 * Each provider (Anthropic, OpenAI, Kimi, etc.) implements this.
 */
export interface LLMProvider {
  readonly modelName: string;

  /**
   * Send a chat completion request and return a stream of chunks.
   */
  chat(
    messages: Message[],
    options?: ChatOptions
  ): AsyncIterable<StreamChunk>;
}

// ── LLM Class ──────────────────────────────────────────────

/**
 * Wraps an LLM provider with model capabilities and context limits.
 */
export class LLM {
  readonly provider: LLMProvider;
  readonly maxContextSize: number;
  readonly capabilities: Set<ModelCapability>;
  readonly modelConfig: LLMModelConfig | null;
  readonly providerConfig: LLMProviderConfig | null;

  constructor(opts: {
    provider: LLMProvider;
    maxContextSize: number;
    capabilities: Set<ModelCapability>;
    modelConfig?: LLMModelConfig | null;
    providerConfig?: LLMProviderConfig | null;
  }) {
    this.provider = opts.provider;
    this.maxContextSize = opts.maxContextSize;
    this.capabilities = opts.capabilities;
    this.modelConfig = opts.modelConfig ?? null;
    this.providerConfig = opts.providerConfig ?? null;
  }

  get modelName(): string {
    return this.provider.modelName;
  }

  /**
   * Check if the model has a specific capability.
   */
  hasCapability(cap: ModelCapability): boolean {
    return this.capabilities.has(cap);
  }

  /**
   * Stream a chat completion.
   */
  chat(
    messages: Message[],
    options?: ChatOptions
  ): AsyncIterable<StreamChunk> {
    return this.provider.chat(messages, options);
  }
}

// ── Model Display Name ─────────────────────────────────────

export function modelDisplayName(modelName: string | null): string {
  if (!modelName) return "";
  if (modelName === "kimi-for-coding" || modelName === "kimi-code") {
    return `${modelName} (powered by kimi-k2.5)`;
  }
  return modelName;
}

// ── Capability Detection ───────────────────────────────────

const ALL_MODEL_CAPABILITIES: Set<ModelCapability> = new Set([
  "image_in",
  "video_in",
  "thinking",
  "always_thinking",
]);

/**
 * Derive model capabilities from model config.
 */
export function deriveModelCapabilities(
  model: LLMModelConfig
): Set<ModelCapability> {
  const capabilities = new Set<ModelCapability>(model.capabilities ?? []);
  const lowerName = model.model.toLowerCase();

  if (lowerName.includes("thinking") || lowerName.includes("reason")) {
    capabilities.add("thinking");
    capabilities.add("always_thinking");
  } else if (
    model.model === "kimi-for-coding" ||
    model.model === "kimi-code"
  ) {
    capabilities.add("thinking");
    capabilities.add("image_in");
    capabilities.add("video_in");
  }

  return capabilities;
}

// ── Environment Variable Overrides ─────────────────────────

/**
 * Override provider/model settings from environment variables.
 * Returns a mapping of env vars that were applied.
 */
export function augmentProviderWithEnvVars(
  provider: LLMProviderConfig,
  model: LLMModelConfig
): Record<string, string> {
  const applied: Record<string, string> = {};

  switch (provider.type) {
    case "kimi": {
      const baseUrl = Bun.env.KIMI_BASE_URL;
      if (baseUrl) {
        provider.baseUrl = baseUrl;
        applied["KIMI_BASE_URL"] = baseUrl;
      }
      const apiKey = Bun.env.KIMI_API_KEY;
      if (apiKey) {
        provider.apiKey = apiKey;
        applied["KIMI_API_KEY"] = "******";
      }
      const modelName = Bun.env.KIMI_MODEL_NAME;
      if (modelName) {
        model.model = modelName;
        applied["KIMI_MODEL_NAME"] = modelName;
      }
      const maxCtx = Bun.env.KIMI_MODEL_MAX_CONTEXT_SIZE;
      if (maxCtx) {
        model.maxContextSize = parseInt(maxCtx, 10);
        applied["KIMI_MODEL_MAX_CONTEXT_SIZE"] = maxCtx;
      }
      const caps = Bun.env.KIMI_MODEL_CAPABILITIES;
      if (caps) {
        const parsed = caps
          .split(",")
          .map((c) => c.trim().toLowerCase())
          .filter((c): c is ModelCapability => ALL_MODEL_CAPABILITIES.has(c as ModelCapability));
        model.capabilities = parsed;
        applied["KIMI_MODEL_CAPABILITIES"] = caps;
      }
      break;
    }
    case "openai_legacy":
    case "openai_responses": {
      const baseUrl = Bun.env.OPENAI_BASE_URL;
      if (baseUrl) provider.baseUrl = baseUrl;
      const apiKey = Bun.env.OPENAI_API_KEY;
      if (apiKey) provider.apiKey = apiKey;
      break;
    }
    default:
      break;
  }

  return applied;
}

// ── Token Estimation ───────────────────────────────────────

/**
 * Simple token count estimation (~4 chars per token).
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimate tokens for an array of messages.
 */
export function estimateMessagesTokenCount(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      total += estimateTokenCount(msg.content);
    } else {
      for (const part of msg.content) {
        if ("text" in part) {
          total += estimateTokenCount((part as { text: string }).text);
        }
      }
    }
    // Overhead per message (role, separators)
    total += 4;
  }
  return total;
}

// ── Factory (placeholder providers) ────────────────────────

/**
 * Clone an LLM with a different model alias from the config.
 * Returns the original LLM if modelAlias is null/undefined, or creates a new
 * LLM with the aliased model/provider settings.
 *
 * Corresponds to Python clone_llm_with_model_alias().
 */
export function cloneLlmWithModelAlias(
  llm: LLM | null,
  config: {
    models: Record<string, { provider: string; model: string; max_context_size: number; capabilities?: string[] }>;
    providers: Record<string, { type: string; base_url: string; api_key: string; custom_headers?: Record<string, string>; env?: Record<string, string> }>;
  },
  modelAlias: string | null | undefined,
  opts?: { sessionId?: string },
): LLM | null {
  if (modelAlias == null) return llm;

  const mc = config.models[modelAlias];
  if (!mc) {
    throw new Error(`Unknown model alias: ${modelAlias}`);
  }
  const pc = config.providers[mc.provider];
  if (!pc) {
    throw new Error(`Unknown provider: ${mc.provider} for model alias: ${modelAlias}`);
  }

  // Convert snake_case config to camelCase LLM interface
  const providerConfig: LLMProviderConfig = {
    type: pc.type as ProviderType,
    baseUrl: pc.base_url,
    apiKey: pc.api_key,
    customHeaders: pc.custom_headers,
    env: pc.env,
  };
  const modelConfig: LLMModelConfig = {
    model: mc.model,
    provider: mc.provider,
    maxContextSize: mc.max_context_size,
    capabilities: mc.capabilities as ModelCapability[] | undefined,
  };

  // Inherit thinking setting from the parent LLM if available
  let thinking: boolean | null = null;
  if (llm != null) {
    if (llm.capabilities.has("thinking") || llm.capabilities.has("always_thinking")) {
      thinking = true;
    }
  }

  return createLLM(providerConfig, modelConfig, { thinking, sessionId: opts?.sessionId });
}

/**
 * Create an LLM instance from provider and model config.
 */
export function createLLM(
  provider: LLMProviderConfig,
  model: LLMModelConfig,
  options?: {
    thinking?: boolean | null;
    sessionId?: string | null;
  }
): LLM | null {
  if (
    provider.type !== "_echo" &&
    provider.type !== "_scripted_echo" &&
    (!provider.baseUrl || !model.model)
  ) {
    return null;
  }

  const capabilities = deriveModelCapabilities(model);

  // Determine thinking mode
  let thinkingMode: "high" | "off" | undefined;
  if (
    capabilities.has("always_thinking") ||
    (options?.thinking === true && capabilities.has("thinking"))
  ) {
    thinkingMode = "high";
  } else if (options?.thinking === false) {
    thinkingMode = "off";
  }

  // Create real provider based on type
  let llmProvider: LLMProvider;

  switch (provider.type) {
    case "kimi":
    case "openai_legacy":
    case "openai_responses":
      llmProvider = new OpenAICompatibleProvider({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        modelName: model.model,
        customHeaders: provider.customHeaders,
        thinkingMode,
      });
      break;

    case "_echo":
      llmProvider = {
        modelName: model.model,
        async *chat(messages: Message[]) {
          const lastMsg = messages[messages.length - 1];
          const text = lastMsg
            ? typeof lastMsg.content === "string"
              ? lastMsg.content
              : "[echo]"
            : "[empty]";
          yield { type: "text" as const, text };
          yield {
            type: "usage" as const,
            usage: { inputTokens: 10, outputTokens: text.length },
          };
          yield { type: "done" as const };
        },
      };
      break;

    default:
      llmProvider = {
        modelName: model.model,
        async *chat() {
          throw new Error(
            `LLM provider "${provider.type}" is not yet implemented. Model: ${model.model}`
          );
        },
      };
      break;
  }

  return new LLM({
    provider: llmProvider,
    maxContextSize: model.maxContextSize,
    capabilities,
    modelConfig: model,
    providerConfig: provider,
  });
}

// ── OpenAI-Compatible Provider ──────────────────────────────
// Works with Kimi API, OpenAI API, and any OpenAI-compatible endpoint.

interface OpenAICompatibleProviderConfig {
  baseUrl: string;
  apiKey: string;
  modelName: string;
  customHeaders?: Record<string, string>;
  thinkingMode?: "high" | "low" | "off";
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | OpenAIContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

class OpenAICompatibleProvider implements LLMProvider {
  readonly modelName: string;
  private baseUrl: string;
  private apiKey: string;
  private customHeaders: Record<string, string>;
  private thinkingMode?: "high" | "low" | "off";

  constructor(config: OpenAICompatibleProviderConfig) {
    this.modelName = config.modelName;
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.customHeaders = config.customHeaders ?? {};
    this.thinkingMode = config.thinkingMode;
  }

  async *chat(
    messages: Message[],
    options?: ChatOptions,
  ): AsyncIterable<StreamChunk> {
    // Convert messages to OpenAI format
    const openaiMessages = this.convertMessages(messages, options?.system);

    // Build request body
    const body: Record<string, unknown> = {
      model: this.modelName,
      messages: openaiMessages,
      stream: true,
      stream_options: { include_usage: true },
    };

    // Default max_tokens if not provided (Python Kimi provider defaults to 32000)
    body.max_tokens = options?.maxTokens ?? 32000;
    if (options?.temperature != null) body.temperature = options.temperature;
    if (options?.topP != null) body.top_p = options.topP;

    // Thinking mode configuration (Kimi-specific)
    const thinking = options?.thinking ?? this.thinkingMode;
    if (thinking && thinking !== "off") {
      body.reasoning_effort = thinking; // "high" | "low"
      body.thinking = { type: "enabled" };
    } else if (thinking === "off") {
      body.thinking = { type: "disabled" };
    }

    // Tools
    if (options?.tools && options.tools.length > 0) {
      body.tools = options.tools.map(
        (t): OpenAITool => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        }),
      );
    }

    // Fetch streaming response
    const url = `${this.baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      ...this.customHeaders,
    };

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `LLM API error ${response.status}: ${text.slice(0, 500)}`,
      );
    }

    if (!response.body) {
      throw new Error("LLM API returned no body");
    }

    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let cacheReadTokens = 0;
    const pendingToolCalls = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === "data: [DONE]" || trimmed === "data:[DONE]") continue;
          // Support both "data: {...}" and "data:{...}" (Kimi API omits the space)
          if (!trimmed.startsWith("data:")) continue;
          const jsonStr = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed.slice(5);
          let data: any;
          try {
            data = JSON.parse(jsonStr);
          } catch {
            continue;
          }

          // Extract usage if present (handle both standard and Kimi-specific formats)
          if (data.usage) {
            const u = data.usage;
            totalInputTokens = u.prompt_tokens ?? u.input_tokens ?? 0;
            totalOutputTokens = u.completion_tokens ?? u.output_tokens ?? 0;
            // Kimi-specific: cached_tokens at root level
            cacheReadTokens = u.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
          }
          // Kimi may also embed usage in choice
          if (data.choices?.[0]?.usage) {
            const cu = data.choices[0].usage;
            totalInputTokens = cu.prompt_tokens ?? totalInputTokens;
            totalOutputTokens = cu.completion_tokens ?? totalOutputTokens;
            cacheReadTokens = cu.cached_tokens ?? cacheReadTokens;
          }

          const choices = data.choices;
          if (!choices || choices.length === 0) continue;

          const delta = choices[0].delta;
          if (!delta) continue;

          // Text content
          if (delta.content) {
            yield { type: "text", text: delta.content };
          }

          // Reasoning/thinking content (Kimi k2.5 specific)
          if (delta.reasoning_content) {
            yield { type: "think", text: delta.reasoning_content };
          }

          // Tool calls
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (tc.id) {
                // New tool call
                pendingToolCalls.set(idx, {
                  id: tc.id,
                  name: tc.function?.name ?? "",
                  arguments: tc.function?.arguments ?? "",
                });
              } else if (pendingToolCalls.has(idx)) {
                // Append to existing
                const existing = pendingToolCalls.get(idx)!;
                if (tc.function?.name) existing.name += tc.function.name;
                if (tc.function?.arguments)
                  existing.arguments += tc.function.arguments;
              }
            }
          }

          // Check for finish reason
          if (choices[0].finish_reason) {
            // Emit any pending tool calls
            for (const [, tc] of pendingToolCalls) {
              yield {
                type: "tool_call",
                id: tc.id,
                name: tc.name,
                arguments: tc.arguments,
              };
            }
            pendingToolCalls.clear();
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Emit usage
    if (totalInputTokens > 0 || totalOutputTokens > 0) {
      yield {
        type: "usage",
        usage: {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
        },
      };
    }

    yield { type: "done" };
  }

  private convertMessages(
    messages: Message[],
    system?: string,
  ): OpenAIMessage[] {
    const result: OpenAIMessage[] = [];

    // System prompt
    if (system) {
      result.push({ role: "system", content: system });
    }

    for (const msg of messages) {
      if (typeof msg.content === "string") {
        result.push({
          role: msg.role as "user" | "assistant" | "system",
          content: msg.content,
        });
      } else {
        // Complex content with parts
        const textParts: string[] = [];
        const toolUseParts: OpenAIToolCall[] = [];
        const toolResultParts: { toolCallId: string; content: string }[] = [];

        for (const part of msg.content) {
          switch (part.type) {
            case "text":
              textParts.push(part.text);
              break;
            case "tool_use":
              toolUseParts.push({
                id: part.id,
                type: "function",
                function: {
                  name: part.name,
                  arguments: JSON.stringify(part.input),
                },
              });
              break;
            case "tool_result":
              toolResultParts.push({
                toolCallId: part.toolUseId,
                content: part.content,
              });
              break;
            case "image":
              // Skip images for now
              break;
          }
        }

        if (msg.role === "assistant" && toolUseParts.length > 0) {
          const assistantMsg: OpenAIMessage = {
            role: "assistant",
            content: textParts.join("\n") || null,
            tool_calls: toolUseParts,
          };
          // Preserve reasoning_content for multi-turn thinking
          if ((msg as any).reasoning_content) {
            (assistantMsg as any).reasoning_content = (msg as any).reasoning_content;
          }
          result.push(assistantMsg);
        } else if (msg.role === "assistant") {
          const assistantMsg: OpenAIMessage = {
            role: "assistant",
            content: textParts.join("\n") || null,
          };
          // Preserve reasoning_content for multi-turn thinking
          if ((msg as any).reasoning_content) {
            (assistantMsg as any).reasoning_content = (msg as any).reasoning_content;
          }
          result.push(assistantMsg);
        } else if (toolResultParts.length > 0) {
          // Tool results become individual tool messages
          for (const tr of toolResultParts) {
            result.push({
              role: "tool",
              tool_call_id: tr.toolCallId,
              content: tr.content,
            });
          }
        } else {
          result.push({
            role: msg.role as "user" | "assistant" | "system",
            content: textParts.join("\n"),
          });
        }
      }
    }

    return result;
  }
}
