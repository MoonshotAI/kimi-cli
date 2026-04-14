/**
 * Configuration loader for kimi-cli.
 *
 * Loads, validates, and merges configuration from multiple sources following
 * the priority chain:
 *
 *   1. `--config` CLI flag  (inline TOML/JSON string)
 *   2. `--config-file` CLI flag  (path to a TOML file)
 *   3. Default path `<dataDir>/config.toml`
 *
 * When no config file exists at the default path the loader creates one with
 * default values so the user has a starting point to customise.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { parse as parseTOML, stringify as stringifyTOML } from 'smol-toml';
import type { ZodError } from 'zod';

import { getConfigPath } from './paths.js';
import { ConfigSchema } from './schema.js';
import type { Config } from './schema.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LoadConfigOptions {
  /** Inline TOML/JSON config string (`--config`). */
  config?: string | undefined;
  /** Path to a config file (`--config-file`). */
  configFile?: string | undefined;
}

export interface LoadConfigResult {
  config: Config;
  /** Where the config was loaded from (for diagnostics). */
  source: 'inline' | 'file' | 'default';
  /** The resolved file path when source is `'file'` or `'default'`. */
  filePath?: string | undefined;
  /** Non-fatal warnings collected during loading. */
  warnings: string[];
}

/**
 * Load and validate the kimi-cli configuration.
 *
 * @param opts - optional CLI overrides (`--config` / `--config-file`).
 * @returns The validated config together with metadata about where it came from.
 */
export function loadConfig(opts: LoadConfigOptions = {}): LoadConfigResult {
  const warnings: string[] = [];

  // -- Priority 1: inline config string --------------------------------------
  if (opts.config !== undefined) {
    const trimmed = opts.config.trim();
    if (trimmed.length === 0) {
      throw new ConfigLoadError('--config value cannot be empty.');
    }
    const data = parseConfigString(trimmed);
    const config = validateConfig(data, '--config value');
    return { config, source: 'inline', warnings };
  }

  // -- Priority 2: explicit config file path ---------------------------------
  if (opts.configFile !== undefined) {
    if (!existsSync(opts.configFile)) {
      throw new ConfigLoadError(
        `Config file not found: ${opts.configFile}`,
      );
    }
    const raw = readFileSync(opts.configFile, 'utf-8');
    const data = parseConfigText(raw, opts.configFile);
    const config = validateConfig(data, opts.configFile);
    return { config, source: 'file', filePath: opts.configFile, warnings };
  }

  // -- Priority 3: default path ----------------------------------------------
  const defaultPath = getConfigPath();

  if (!existsSync(defaultPath)) {
    // Create the default config file so the user has a starting point.
    const config = getDefaultConfig();
    ensureWriteConfig(config, defaultPath);
    warnings.push(`Created default config at ${defaultPath}`);
    return { config, source: 'default', filePath: defaultPath, warnings };
  }

  const raw = readFileSync(defaultPath, 'utf-8');
  const data = parseConfigText(raw, defaultPath);
  const config = validateConfigSafe(data, defaultPath, warnings);
  return { config, source: 'default', filePath: defaultPath, warnings };
}

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

/**
 * Return a `Config` object with all default values applied.
 */
export function getDefaultConfig(): Config {
  return ConfigSchema.parse({});
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class ConfigLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigLoadError';
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Try to parse a string as JSON first, then TOML.  This mirrors the Python
 * `load_config_from_string` behaviour so that `--config '{"theme":"light"}'`
 * works alongside `--config 'theme = "light"'`.
 */
function parseConfigString(text: string): unknown {
  // Try JSON first (fast fail).
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Not JSON -- fall through to TOML.
  }

  try {
    return parseTOML(text);
  } catch (tomlErr) {
    throw new ConfigLoadError(
      `Invalid config string (not valid JSON or TOML): ${String(tomlErr)}`,
    );
  }
}

/**
 * Parse a config file's text content.  The file extension determines the
 * format: `.json` for JSON, everything else for TOML.
 */
function parseConfigText(text: string, filePath: string): unknown {
  if (filePath.endsWith('.json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch (err) {
      throw new ConfigLoadError(
        `Invalid JSON in ${filePath}: ${String(err)}`,
      );
    }
  }

  try {
    return parseTOML(text);
  } catch (err) {
    throw new ConfigLoadError(
      `Invalid TOML in ${filePath}: ${String(err)}`,
    );
  }
}

/**
 * Validate raw data against the ConfigSchema.  Throws on failure.
 */
function validateConfig(data: unknown, label: string): Config {
  const result = ConfigSchema.safeParse(data);
  if (!result.success) {
    throw new ConfigLoadError(
      `Invalid configuration (${label}):\n${formatZodError(result.error)}`,
    );
  }
  return result.data;
}

/**
 * Validate raw data, but on failure fall back to defaults and push a warning
 * instead of throwing.  Used for the default config path so that a broken
 * config file does not block the CLI entirely.
 */
function validateConfigSafe(
  data: unknown,
  label: string,
  warnings: string[],
): Config {
  const result = ConfigSchema.safeParse(data);
  if (!result.success) {
    warnings.push(
      `Invalid configuration in ${label}, using defaults:\n${formatZodError(result.error)}`,
    );
    return getDefaultConfig();
  }
  return result.data;
}

/**
 * Write the config to disk, creating parent directories as needed.
 */
function ensureWriteConfig(config: Config, filePath: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  // Serialise only non-default top-level fields so the generated file is
  // minimal and easy to read.  For the initial creation we write an empty
  // TOML object so the file exists and is valid.
  const toml = stringifyTOML(configToSerializable(config));
  writeFileSync(filePath, toml, 'utf-8');
}

/**
 * Convert Config to a plain object suitable for TOML serialisation.
 *
 * smol-toml's `stringify` does not handle `undefined` values, so we strip
 * them and also remove empty sub-objects to keep the file clean.
 */
function configToSerializable(config: Config): Record<string, unknown> {
  // For default config, produce a minimal file with just a comment-like
  // structure.  We include the top-level scalar defaults so the user sees
  // what can be customised.
  return JSON.parse(JSON.stringify({
    default_model: config.default_model,
    default_thinking: config.default_thinking,
    default_yolo: config.default_yolo,
    default_plan_mode: config.default_plan_mode,
    default_editor: config.default_editor,
    theme: config.theme,
    merge_all_available_skills: config.merge_all_available_skills,
  })) as Record<string, unknown>;
}

/**
 * Format a ZodError into a human-readable string.
 */
function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `  - ${path}: ${issue.message}`;
    })
    .join('\n');
}
