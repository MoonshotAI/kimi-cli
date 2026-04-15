/**
 * Config module — unified entry point.
 */

// Schema types
export type {
  KimiConfig,
  ModelAlias,
  ProviderConfig,
  ProviderType,
  ThinkingConfig,
} from './schema.js';
export {
  KimiConfigSchema,
  ProviderConfigSchema,
  ModelAliasSchema,
  getDefaultConfig,
} from './schema.js';

// Loader
export { loadConfig, parseConfigString, ConfigError } from './loader.js';
export type { LoadConfigOptions } from './loader.js';

// Provider factory
export {
  createProvider,
  createProviderFromConfig,
  resolveModelAlias,
  ProviderFactoryError,
} from './provider-factory.js';
export type { ResolvedModel } from './provider-factory.js';
