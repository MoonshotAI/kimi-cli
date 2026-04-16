/**
 * Config module — unified entry point.
 */

// Schema types
export type {
  KimiConfig,
  ModelAlias,
  OAuthRef,
  ProviderConfig,
  ProviderType,
  ThinkingConfig,
} from './schema.js';
export {
  KimiConfigSchema,
  OAuthRefSchema,
  ProviderConfigSchema,
  ModelAliasSchema,
  getDefaultConfig,
} from './schema.js';

// Loader
export {
  loadConfig,
  parseConfigString,
  ConfigError,
  snakeToCamel,
  transformTomlData,
} from './loader.js';
export type { LoadConfigOptions } from './loader.js';

// Provider factory
export {
  createProvider,
  createProviderFromConfig,
  resolveModelAlias,
  ProviderFactoryError,
} from './provider-factory.js';
export type { ResolvedModel } from './provider-factory.js';
