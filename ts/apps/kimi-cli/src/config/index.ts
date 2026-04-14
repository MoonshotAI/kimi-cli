/**
 * Configuration system public API.
 *
 * Re-exports schema types, loader, and path helpers.
 */

export { ConfigSchema, type Config } from './schema.js';
export type {
  BackgroundConfig,
  HookDef,
  HookEventType,
  LLMModel,
  LLMProvider,
  LoopControl,
  MCPClientConfig,
  MCPConfig,
  ModelCapability,
  NotificationConfig,
  OAuthRef,
  ProviderType,
  Services,
  Theme,
} from './schema.js';

export {
  loadConfig,
  getDefaultConfig,
  ConfigLoadError,
} from './loader.js';
export type { LoadConfigOptions, LoadConfigResult } from './loader.js';

export {
  getDataDir,
  getSessionsDir,
  getConfigPath,
  getMCPConfigPath,
  getLogDir,
} from './paths.js';
