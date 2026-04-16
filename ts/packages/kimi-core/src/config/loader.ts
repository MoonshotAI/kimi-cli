/**
 * Config loader — TOML-based configuration with three-layer merging.
 *
 * Layer priority (later wins):
 *   1. Global config  — `~/.kimi/config.toml`  (PathConfig.home)
 *   2. Project config — `$workspaceDir/.kimi/config.toml`
 *   3. CLI overrides  — passed programmatically via `LoadConfigOptions.overrides`
 *
 * Environment variables are injected after merging when the corresponding
 * provider is declared but has no explicit `apiKey`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseToml } from 'smol-toml';

import { PathConfig } from '../session/path-config.js';
import { type KimiConfig, KimiConfigSchema, getDefaultConfig } from './schema.js';

// ── snake_case → camelCase transform ───────────────────────────────────

export function snakeToCamel(key: string): string {
  return key.replaceAll(/_([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function transformFieldKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = snakeToCamel(key);
    if (isPlainObject(value)) {
      result[camelKey] = transformFieldKeys(value);
    } else {
      result[camelKey] = value;
    }
  }
  return result;
}

/**
 * Transform TOML-parsed data from snake_case to camelCase.
 * Record keys (provider names, model names) are preserved as-is.
 */
export function transformTomlData(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const camelKey = snakeToCamel(key);
    if ((camelKey === 'providers' || camelKey === 'models') && isPlainObject(value)) {
      const record: Record<string, unknown> = {};
      for (const [entryName, entryConfig] of Object.entries(value)) {
        record[entryName] = isPlainObject(entryConfig)
          ? transformFieldKeys(entryConfig)
          : entryConfig;
      }
      result[camelKey] = record;
    } else if (isPlainObject(value)) {
      result[camelKey] = transformFieldKeys(value);
    } else {
      result[camelKey] = value;
    }
  }
  return result;
}

// ── Types ───────────────────────────────────────────────────────────────

export interface LoadConfigOptions {
  /** Override for PathConfig (controls ~/.kimi location). */
  pathConfig?: PathConfig | undefined;
  /** Workspace directory for project-level config. */
  workspaceDir?: string | undefined;
  /** Programmatic overrides (e.g. CLI flags). */
  overrides?: Partial<KimiConfig> | undefined;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

// ── TOML file reading ───────────────────────────────────────────────────

function readTomlFile(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const text = readFileSync(filePath, 'utf-8');
    if (text.trim().length === 0) {
      return {};
    }
    return parseToml(text) as Record<string, unknown>;
  } catch (error) {
    throw new ConfigError(
      `Invalid TOML in ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ── Deep merge ──────────────────────────────────────────────────────────

/**
 * Deep-merge `source` into `target`. Scalars and arrays in `source`
 * overwrite those in `target`; nested objects are recursively merged.
 * `undefined` values in `source` are skipped (do not erase `target` keys).
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    if (sourceVal === undefined) continue;
    const targetVal = result[key];
    if (isPlainObject(targetVal) && isPlainObject(sourceVal)) {
      result[key] = deepMerge(targetVal, sourceVal);
    } else {
      result[key] = sourceVal;
    }
  }
  return result;
}

// ── Environment variable injection ──────────────────────────────────────

/**
 * Provider-type → environment variable name mapping for API keys.
 */
const ENV_API_KEY_MAP: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openai_responses: 'OPENAI_API_KEY',
  kimi: 'KIMI_API_KEY',
  'google-genai': 'GOOGLE_AI_API_KEY',
  vertexai: 'GOOGLE_AI_API_KEY',
};

function injectEnvVars(config: KimiConfig): KimiConfig {
  const providers = { ...config.providers };
  let changed = false;

  for (const [name, provider] of Object.entries(providers)) {
    // Inject API key from env if not explicitly set
    if (provider.apiKey === undefined || provider.apiKey === '') {
      const envVar = ENV_API_KEY_MAP[provider.type];
      const envVal = envVar !== undefined ? process.env[envVar] : undefined;
      if (envVal !== undefined && envVal !== '') {
        providers[name] = { ...provider, apiKey: envVal };
        changed = true;
      }
    }
  }

  // KIMI_DEFAULT_MODEL → defaultModel
  let defaultModel = config.defaultModel;
  if (defaultModel === undefined || defaultModel === '') {
    const envModel = process.env['KIMI_DEFAULT_MODEL'];
    if (envModel !== undefined && envModel !== '') {
      defaultModel = envModel;
      changed = true;
    }
  }

  // KIMI_YOLO → yolo: true
  let yolo = config.yolo;
  const envYolo = process.env['KIMI_YOLO'];
  if (envYolo !== undefined && envYolo !== '' && envYolo !== '0' && envYolo !== 'false') {
    yolo = true;
    changed = true;
  }

  if (!changed) return config;
  return { ...config, providers, defaultModel, yolo };
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Load and merge configuration from global, project, and override layers.
 *
 * Returns a validated {@link KimiConfig}. If no config files exist,
 * returns the default (empty) configuration.
 */
export function loadConfig(options?: LoadConfigOptions): KimiConfig {
  const pathConfig = options?.pathConfig ?? new PathConfig();

  // Layer 1: global config
  const globalPath = join(pathConfig.home, 'config.toml');
  const globalData = readTomlFile(globalPath) ?? {};

  // Layer 2: project config
  let projectData: Record<string, unknown> = {};
  if (options?.workspaceDir) {
    const projectPath = join(options.workspaceDir, '.kimi', 'config.toml');
    projectData = readTomlFile(projectPath) ?? {};
  }

  // Layer 3: CLI overrides (strip undefined values before merge)
  const overrides = options?.overrides ?? {};
  const overrideData: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) {
      overrideData[k] = v;
    }
  }

  // Merge: global → project (file layers only — overrides are programmatic)
  const fileMerged = deepMerge(globalData, projectData);

  // Store raw from file layers only (before programmatic overrides pollute it)
  const raw = JSON.parse(JSON.stringify(fileMerged)) as Record<string, unknown>;

  // Apply programmatic overrides on top
  const merged = deepMerge(fileMerged, overrideData);

  // snake_case → camelCase
  const transformed = transformTomlData(merged);
  transformed['raw'] = raw;

  // Validate with zod
  let config: KimiConfig;
  try {
    config = KimiConfigSchema.parse(transformed);
  } catch (error) {
    throw new ConfigError(
      `Invalid configuration: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Inject env vars
  config = injectEnvVars(config);

  return config;
}

/**
 * Parse a raw TOML string into a validated {@link KimiConfig}.
 */
export function parseConfigString(tomlText: string): KimiConfig {
  if (tomlText.trim().length === 0) {
    return getDefaultConfig();
  }
  let data: Record<string, unknown>;
  try {
    data = parseToml(tomlText) as Record<string, unknown>;
  } catch (error) {
    throw new ConfigError(
      `Invalid TOML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const raw = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
  const transformed = transformTomlData(data);
  transformed['raw'] = raw;

  try {
    return KimiConfigSchema.parse(transformed);
  } catch (error) {
    throw new ConfigError(
      `Invalid configuration: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
