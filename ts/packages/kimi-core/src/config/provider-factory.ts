/**
 * Provider factory — create kosong ChatProvider instances from config.
 *
 * Public entry point is `createProviderFromConfig` which:
 *  1. Applies env_overrides (`KIMI_BASE_URL`, `OPENAI_BASE_URL`, etc.)
 *  2. Resolves model alias → providerConfig + modelOverride
 *  3. If provider has `oauth`, resolves an access token via the injected
 *     OAuthResolver (caller-managed OAuthManager); uses it as `apiKey`.
 *  4. Delegates to `createProvider()` which constructs the kosong class.
 *
 * `createProvider()` is the low-level synchronous builder used by callers
 * that already resolved the apiKey themselves (e.g. tests).
 */

import type { ChatProvider } from '@moonshot-ai/kosong';
import { AnthropicChatProvider } from '@moonshot-ai/kosong/providers/anthropic';
import { GoogleGenAIChatProvider } from '@moonshot-ai/kosong/providers/google-genai';
import { KimiChatProvider } from '@moonshot-ai/kosong/providers/kimi';
import { OpenAILegacyChatProvider } from '@moonshot-ai/kosong/providers/openai-legacy';
import { OpenAIResponsesChatProvider } from '@moonshot-ai/kosong/providers/openai-responses';

import { applyEnvOverrides } from './env-overrides.js';
import type { KimiConfig, ProviderConfig } from './schema.js';

// ── Error ───────────────────────────────────────────────────────────────

export class ProviderFactoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderFactoryError';
  }
}

// ── Low-level synchronous factory ──────────────────────────────────────

/**
 * Create a kosong {@link ChatProvider} from a resolved provider config.
 *
 * @param name - Logical provider name (error messages only).
 * @param config - Provider configuration block.
 * @param modelOverride - When given, overrides `config.defaultModel`.
 */
export function createProvider(
  name: string,
  config: ProviderConfig,
  modelOverride?: string,
  defaultHeaders?: Record<string, string>,
): ChatProvider {
  if (config.oauth && (!config.apiKey || config.apiKey === '')) {
    throw new ProviderFactoryError(
      `Provider "${name}" requires OAuth authentication. ` +
        'Use createProviderFromConfig() with an OAuth resolver, or run /login first.',
    );
  }

  const model = modelOverride ?? config.defaultModel;

  switch (config.type) {
    case 'anthropic': {
      if (!model) {
        throw new ProviderFactoryError(
          `Provider "${name}" (anthropic): no model specified.`,
        );
      }
      return new AnthropicChatProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model,
      });
    }

    case 'openai': {
      if (!model) {
        throw new ProviderFactoryError(
          `Provider "${name}" (openai): no model specified.`,
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
          `Provider "${name}" (kimi): no model specified.`,
        );
      }
      return new KimiChatProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model,
        defaultHeaders,
      });
    }

    case 'google-genai': {
      if (!model) {
        throw new ProviderFactoryError(
          `Provider "${name}" (google-genai): no model specified.`,
        );
      }
      return new GoogleGenAIChatProvider({
        apiKey: config.apiKey,
        model,
      });
    }

    case 'openai_responses': {
      if (!model) {
        throw new ProviderFactoryError(
          `Provider "${name}" (openai_responses): no model specified.`,
        );
      }
      return new OpenAIResponsesChatProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model,
      });
    }

    case 'vertexai': {
      if (!model) {
        throw new ProviderFactoryError(
          `Provider "${name}" (vertexai): no model specified.`,
        );
      }
      return new GoogleGenAIChatProvider({
        apiKey: config.apiKey,
        model,
        vertexai: true,
      });
    }

    default: {
      const exhaustive: never = config.type;
      throw new ProviderFactoryError(`Unknown provider type: ${String(exhaustive)}`);
    }
  }
}

// ── Model alias resolution ─────────────────────────────────────────────

export interface ResolvedModel {
  providerName: string;
  modelName: string;
}

/**
 * Resolve a model alias strictly: returns `ResolvedModel` only when the
 * input matches an entry in `config.models`. Unknown names → `undefined`.
 *
 * The former behavior silently fell through to `defaultProvider` with the
 * input treated as a raw model name, which swallowed typos (`--model
 * k25-pro` → success on a non-existent model). The raw-model escape is
 * now opt-in at the `createProviderFromConfig` layer via
 * `ProviderFactoryDeps.allowRawModel`.
 */
export function resolveModelAlias(
  config: KimiConfig,
  nameOrAlias: string,
): ResolvedModel | undefined {
  const alias = config.models?.[nameOrAlias];
  if (alias !== undefined) {
    return { providerName: alias.provider, modelName: alias.model };
  }
  return undefined;
}

// ── High-level async factory ────────────────────────────────────────────

/**
 * Resolver that, given a provider name, returns a fresh OAuth access token.
 * Host (kimi-cli) constructs an OAuthManager per OAuth-backed provider and
 * wires it through this callback.
 */
export type OAuthResolver = (providerName: string) => Promise<string>;

export interface ProviderFactoryDeps {
  readonly oauthResolver?: OAuthResolver | undefined;
  /** Override for `process.env` (test hook). */
  readonly env?: Record<string, string | undefined> | undefined;
  /** Default HTTP headers injected into provider constructors (e.g. User-Agent). */
  readonly defaultHeaders?: Record<string, string> | undefined;
  /**
   * When `true`, an unknown `modelNameOrAlias` is treated as a raw model
   * name and passed to `defaultProvider`. When `false` / unset, unknown
   * aliases throw `ProviderFactoryError` with the list of configured
   * aliases so typos surface immediately instead of silently hitting a
   * non-existent endpoint. Wired through `--raw-model` on the CLI.
   */
  readonly allowRawModel?: boolean | undefined;
}

/**
 * Resolve a model alias → provider + model and return a kosong provider.
 *
 * Async because OAuth-backed providers await `oauthResolver(name)` for the
 * current access token before constructing.
 */
export async function createProviderFromConfig(
  config: KimiConfig,
  modelNameOrAlias?: string,
  deps?: ProviderFactoryDeps,
): Promise<ChatProvider> {
  // Slice 5.0.1 (M2): apply env overrides AFTER resolving the requested
  // model. Otherwise `--model X` would silently inherit the env
  // overrides intended for `defaultModel`.
  const requestedModel = modelNameOrAlias ?? config.defaultModel;
  const effectiveConfig = applyEnvOverrides(config, deps?.env, requestedModel);

  let providerName: string;
  let modelName: string | undefined;

  if (requestedModel !== undefined) {
    const resolved = resolveModelAlias(effectiveConfig, requestedModel);
    const aliases = Object.keys(effectiveConfig.models ?? {});
    const hasAliases = aliases.length > 0;
    if (resolved !== undefined) {
      providerName = resolved.providerName;
      modelName = resolved.modelName;
    } else if (hasAliases && deps?.allowRawModel !== true) {
      // Strict: aliases are configured but the requested one isn't
      // among them. Surface typos instead of silently hitting a
      // non-existent endpoint. Fires whether or not `defaultProvider`
      // is set — a malformed alias is a user-input bug, not a routing
      // gap.
      throw new ProviderFactoryError(
        `Unknown model alias "${requestedModel}". Available: ${aliases.join(', ')}. ` +
          `Pass --raw-model to forward "${requestedModel}" as a raw model name to the default provider.`,
      );
    } else if (effectiveConfig.defaultProvider !== undefined) {
      // Raw-model fallback: either the caller opted in (--raw-model),
      // OR the config has no aliases at all (so "unknown alias"
      // doesn't make sense as a diagnostic).
      providerName = effectiveConfig.defaultProvider;
      modelName = requestedModel;
    } else {
      throw new ProviderFactoryError(
        'No provider could be determined. Set defaultProvider or use a model alias.',
      );
    }
  } else if (effectiveConfig.defaultProvider !== undefined) {
    providerName = effectiveConfig.defaultProvider;
    modelName = undefined;
  } else {
    throw new ProviderFactoryError(
      'No provider could be determined. Set defaultProvider or pass a model alias.',
    );
  }

  const providerConfig = effectiveConfig.providers[providerName];
  if (providerConfig === undefined) {
    throw new ProviderFactoryError(
      `Provider "${providerName}" is not configured in providers.`,
    );
  }

  // OAuth-backed provider: resolve access token via the caller-managed
  // OAuthManager and splice it into providerConfig as apiKey.
  let effectiveProviderConfig = providerConfig;
  if (
    providerConfig.oauth !== undefined &&
    (providerConfig.apiKey === undefined || providerConfig.apiKey === '')
  ) {
    if (deps?.oauthResolver === undefined) {
      throw new ProviderFactoryError(
        `Provider "${providerName}" requires OAuth authentication. ` +
          'Pass an oauthResolver in ProviderFactoryDeps.',
      );
    }
    const accessToken = await deps.oauthResolver(providerName);
    effectiveProviderConfig = { ...providerConfig, apiKey: accessToken };
  }

  return createProvider(providerName, effectiveProviderConfig, modelName, deps?.defaultHeaders);
}
