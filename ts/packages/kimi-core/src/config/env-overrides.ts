/**
 * Apply environment variable overrides to a loaded KimiConfig.
 *
 * Port of Python kimi_cli/llm.py::augment_provider_with_env_vars(). Only the
 * provider + model resolved from `defaultModel` (or `defaultProvider`) receive
 * overrides — matching Python's per-call semantics. Overrides are transient:
 * the returned config is a new object; the input is untouched.
 *
 * Env vars:
 *   - kimi providers:
 *       KIMI_BASE_URL                -> provider.baseUrl
 *       KIMI_API_KEY                 -> provider.apiKey
 *       KIMI_MODEL_NAME              -> model.model
 *       KIMI_MODEL_MAX_CONTEXT_SIZE  -> model.maxContextSize (parseInt)
 *       KIMI_MODEL_CAPABILITIES      -> model.capabilities (comma-split, filtered)
 *   - openai / openai_responses providers:
 *       OPENAI_BASE_URL              -> provider.baseUrl
 *       OPENAI_API_KEY               -> provider.apiKey
 *
 * Other provider types have no env overrides (matches Python `case _: pass`).
 */

import type { KimiConfig, ModelAlias, ProviderConfig } from './schema.js';

const VALID_CAPABILITIES: ReadonlySet<string> = new Set([
  'image_in',
  'video_in',
  'thinking',
  'always_thinking',
]);

type Env = Record<string, string | undefined>;

function nonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Resolve the (provider, model) the env overrides should target.
 *
 * Slice 5.0.1 (M2 fix): callers must be able to override env vars for the
 * model that will actually be used (`--model X`), not just `defaultModel`.
 * `requestedModel` takes precedence; falls back to `defaultModel`, then
 * `defaultProvider`. Returns undefined if none can be resolved.
 */
function resolveSelectedProvider(
  config: KimiConfig,
  requestedModel: string | undefined,
): { providerName: string; modelKey: string | undefined } | undefined {
  const candidate = requestedModel ?? config.defaultModel;
  if (nonEmpty(candidate)) {
    const alias = config.models?.[candidate];
    if (alias !== undefined) {
      return { providerName: alias.provider, modelKey: candidate };
    }
    if (nonEmpty(config.defaultProvider)) {
      return { providerName: config.defaultProvider, modelKey: undefined };
    }
    return undefined;
  }
  if (nonEmpty(config.defaultProvider)) {
    return { providerName: config.defaultProvider, modelKey: undefined };
  }
  return undefined;
}

function kimiOverrides(
  provider: ProviderConfig,
  model: ModelAlias | undefined,
  env: Env,
): { provider?: ProviderConfig; model?: ModelAlias } {
  let nextProvider: ProviderConfig | undefined;
  let nextModel: ModelAlias | undefined;

  const baseUrl = env['KIMI_BASE_URL'];
  if (nonEmpty(baseUrl)) {
    nextProvider = { ...(nextProvider ?? provider), baseUrl };
  }
  const apiKey = env['KIMI_API_KEY'];
  if (nonEmpty(apiKey)) {
    nextProvider = { ...(nextProvider ?? provider), apiKey };
  }

  if (model !== undefined) {
    const modelName = env['KIMI_MODEL_NAME'];
    if (nonEmpty(modelName)) {
      nextModel = { ...(nextModel ?? model), model: modelName };
    }
    const maxCtx = env['KIMI_MODEL_MAX_CONTEXT_SIZE'];
    if (nonEmpty(maxCtx)) {
      const parsed = Number(maxCtx);
      if (Number.isFinite(parsed) && parsed > 0) {
        nextModel = { ...(nextModel ?? model), maxContextSize: parsed };
      }
    }
    const capsRaw = env['KIMI_MODEL_CAPABILITIES'];
    if (nonEmpty(capsRaw)) {
      const parsed = capsRaw
        .split(',')
        .map((c) => c.trim().toLowerCase())
        .filter((c) => c.length > 0 && VALID_CAPABILITIES.has(c));
      nextModel = { ...(nextModel ?? model), capabilities: parsed };
    }
  }

  return {
    ...(nextProvider !== undefined ? { provider: nextProvider } : {}),
    ...(nextModel !== undefined ? { model: nextModel } : {}),
  };
}

function openaiOverrides(
  provider: ProviderConfig,
  env: Env,
): ProviderConfig | undefined {
  let next: ProviderConfig | undefined;
  const baseUrl = env['OPENAI_BASE_URL'];
  if (nonEmpty(baseUrl)) {
    next = { ...(next ?? provider), baseUrl };
  }
  const apiKey = env['OPENAI_API_KEY'];
  if (nonEmpty(apiKey)) {
    next = { ...(next ?? provider), apiKey };
  }
  return next;
}

/**
 * Apply env-driven overrides to a KimiConfig.
 *
 * @param config - the loaded config to overlay overrides onto
 * @param env - process env replacement (test hook)
 * @param requestedModel - the model alias the caller will actually use;
 *   when provided, env overrides target THIS provider/model rather than
 *   the config's `defaultModel`. Pass `--model X` here.
 */
export function applyEnvOverrides(
  config: KimiConfig,
  env?: Env,
  requestedModel?: string,
): KimiConfig {
  const actualEnv: Env = env ?? (process.env as Env);
  const selected = resolveSelectedProvider(config, requestedModel);
  if (selected === undefined) {
    return config;
  }

  const provider = config.providers[selected.providerName];
  if (provider === undefined) {
    return config;
  }
  const model =
    selected.modelKey !== undefined
      ? config.models?.[selected.modelKey]
      : undefined;

  let nextProvider: ProviderConfig | undefined;
  let nextModel: ModelAlias | undefined;

  switch (provider.type) {
    case 'kimi': {
      const result = kimiOverrides(provider, model, actualEnv);
      nextProvider = result.provider;
      nextModel = result.model;
      break;
    }
    case 'openai':
    case 'openai_responses': {
      nextProvider = openaiOverrides(provider, actualEnv);
      break;
    }
    default:
      break;
  }

  if (nextProvider === undefined && nextModel === undefined) {
    return config;
  }

  const providers = { ...config.providers };
  if (nextProvider !== undefined) {
    providers[selected.providerName] = nextProvider;
  }
  const models = { ...config.models };
  if (nextModel !== undefined && selected.modelKey !== undefined) {
    models[selected.modelKey] = nextModel;
  }

  return {
    ...config,
    providers,
    ...(Object.keys(models).length > 0 ? { models } : {}),
  };
}
