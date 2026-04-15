/**
 * Provider factory — create kosong ChatProvider instances from config.
 *
 * Each provider type maps to its concrete kosong class, imported from
 * the subpath exports to avoid polluting downstream type bundles.
 */

import type { ChatProvider } from '@moonshot-ai/kosong';
import { AnthropicChatProvider } from '@moonshot-ai/kosong/providers/anthropic';
import { GoogleGenAIChatProvider } from '@moonshot-ai/kosong/providers/google-genai';
import { KimiChatProvider } from '@moonshot-ai/kosong/providers/kimi';
import { OpenAILegacyChatProvider } from '@moonshot-ai/kosong/providers/openai-legacy';

import type { KimiConfig, ProviderConfig } from './schema.js';

// ── Error ───────────────────────────────────────────────────────────────

export class ProviderFactoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderFactoryError';
  }
}

// ── Factory ─────────────────────────────────────────────────────────────

/**
 * Create a kosong {@link ChatProvider} from a single provider config entry.
 *
 * @param name - Logical provider name (for error messages).
 * @param config - The provider configuration block.
 * @param modelOverride - If given, overrides `config.defaultModel`.
 */
export function createProvider(
  name: string,
  config: ProviderConfig,
  modelOverride?: string,
): ChatProvider {
  const model = modelOverride ?? config.defaultModel;

  switch (config.type) {
    case 'anthropic': {
      if (!model) {
        throw new ProviderFactoryError(
          `Provider "${name}" (anthropic): no model specified. Set defaultModel in the provider config or pass a model name.`,
        );
      }
      return new AnthropicChatProvider({
        apiKey: config.apiKey,
        model,
      });
    }

    case 'openai': {
      if (!model) {
        throw new ProviderFactoryError(
          `Provider "${name}" (openai): no model specified. Set defaultModel in the provider config or pass a model name.`,
        );
      }
      return new OpenAILegacyChatProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model,
      });
    }

    case 'kimi': {
      if (!model) {
        throw new ProviderFactoryError(
          `Provider "${name}" (kimi): no model specified. Set defaultModel in the provider config or pass a model name.`,
        );
      }
      return new KimiChatProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model,
      });
    }

    case 'google-genai': {
      if (!model) {
        throw new ProviderFactoryError(
          `Provider "${name}" (google-genai): no model specified. Set defaultModel in the provider config or pass a model name.`,
        );
      }
      return new GoogleGenAIChatProvider({
        apiKey: config.apiKey,
        model,
      });
    }

    default: {
      const exhaustive: never = config.type;
      throw new ProviderFactoryError(`Unknown provider type: ${String(exhaustive)}`);
    }
  }
}

// ── Model alias resolution ──────────────────────────────────────────────

export interface ResolvedModel {
  providerName: string;
  modelName: string;
}

/**
 * Resolve a model name or alias to the concrete provider + model.
 *
 * Resolution order:
 *   1. Exact match in `config.models` (alias map).
 *   2. Treat as a raw model name on `config.defaultProvider`.
 *
 * Returns `undefined` if the alias cannot be resolved.
 */
export function resolveModelAlias(
  config: KimiConfig,
  nameOrAlias: string,
): ResolvedModel | undefined {
  // Check alias map
  const alias = config.models?.[nameOrAlias];
  if (alias !== undefined) {
    return { providerName: alias.provider, modelName: alias.model };
  }

  // Fallback: use as raw model name on defaultProvider
  if (config.defaultProvider !== undefined) {
    return { providerName: config.defaultProvider, modelName: nameOrAlias };
  }

  return undefined;
}

// ── High-level: config → provider ───────────────────────────────────────

/**
 * Create a {@link ChatProvider} from a full config, resolving model aliases
 * and defaulting to the config-level `defaultProvider`/`defaultModel`.
 *
 * @param config - Full KimiConfig.
 * @param modelNameOrAlias - Optional model name or alias. When omitted,
 *   uses `config.defaultModel`.
 */
export function createProviderFromConfig(
  config: KimiConfig,
  modelNameOrAlias?: string,
): ChatProvider {
  const requestedModel = modelNameOrAlias ?? config.defaultModel;

  if (requestedModel !== undefined) {
    // Try to resolve as alias first
    const resolved = resolveModelAlias(config, requestedModel);
    if (resolved !== undefined) {
      const providerConfig = config.providers[resolved.providerName];
      if (providerConfig === undefined) {
        throw new ProviderFactoryError(
          `Model alias "${requestedModel}" references provider "${resolved.providerName}" which is not configured.`,
        );
      }
      return createProvider(resolved.providerName, providerConfig, resolved.modelName);
    }
  }

  // No alias match — use defaultProvider with the given model (or its own defaultModel)
  const providerName = config.defaultProvider;
  if (providerName === undefined) {
    throw new ProviderFactoryError(
      'No provider could be determined. Set defaultProvider in config or use a model alias.',
    );
  }

  const providerConfig = config.providers[providerName];
  if (providerConfig === undefined) {
    throw new ProviderFactoryError(
      `Default provider "${providerName}" is not configured in providers.`,
    );
  }

  return createProvider(providerName, providerConfig, requestedModel);
}
