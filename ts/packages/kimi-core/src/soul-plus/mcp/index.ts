/**
 * MCP subsystem barrel — Slice 2.6 (v2 §11).
 *
 * Re-exported from `src/soul-plus/index.ts` so external callers see a
 * flat `MCPManager` / `parseMcpConfig` / ... API without reaching
 * into the subdirectory.
 */

export { MCPConfigError, MCPRuntimeError, MCPTimeoutError } from './errors.js';

export type { HttpServerConfig, McpConfig, McpServerConfig, StdioServerConfig } from './config.js';
export {
  HttpServerConfigSchema,
  McpConfigSchema,
  McpServerConfigSchema,
  StdioServerConfigSchema,
  isHttpServer,
  isStdioServer,
  parseMcpConfig,
} from './config.js';

export type {
  CallToolOptions,
  MCPClient,
  MCPToolDefinition,
  MCPToolResult,
  McpStderrCallback,
} from './client.js';
export { HttpMcpClient, StdioMcpClient } from './client.js';

export type { McpToolAdapterOptions } from './tool-adapter.js';
export {
  DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS,
  MCP_TOOL_NAME_PREFIX,
  mcpToolName,
  mcpToolToKimiTool,
  parseMcpToolName,
} from './tool-adapter.js';

export type {
  McpClientFactory,
  McpLoadNotification,
  McpNotifyCallback,
  MCPManagerOptions,
  MCPServerStatus,
} from './manager.js';
export { MCPManager } from './manager.js';

export type { McpOAuthProviderOptions } from './oauth.js';
export { McpOAuthProvider } from './oauth.js';

// Re-export the SDK's OAuth provider interface so downstream packages
// (e.g. `apps/kimi-cli`) can type-hint callers without taking a direct
// dependency on `@modelcontextprotocol/sdk`.
export type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';

export type {
  OAuthCallbackPayload,
  OAuthCallbackServerHandle,
  StartOAuthCallbackServerOptions,
} from './oauth-callback-server.js';
export { startOAuthCallbackServer } from './oauth-callback-server.js';

export type { McpContentBlock, McpToolResultInput } from './output-budget.js';
export { MCP_MAX_OUTPUT_CHARS, convertBlock, convertMcpToolResult } from './output-budget.js';
