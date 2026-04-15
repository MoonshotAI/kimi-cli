/**
 * MCP server config — Slice 2.6.
 *
 * Claude Desktop–compatible schema (`{"mcpServers": {name: serverConfig}}`)
 * so users can copy an existing `mcp.json` verbatim. Two transport
 * families:
 *
 *   - **stdio** — `{command, args?, env?}` spawns a child process the
 *     way Python does via `fastmcp`.
 *   - **http** (Streamable HTTP / SSE) — `{url, transport, headers?}`.
 *     OAuth is deliberately NOT modelled here; the `auth` field from
 *     Python is deferred to a future slice (coordinator Q1).
 *
 * Parsing goes through {@link parseMcpConfig} which upgrades zod
 * failures into {@link MCPConfigError} for a consistent error surface
 * with the Python runtime.
 *
 * The zod schemas are declared as non-exported `_raw...Schema`
 * constants and re-exported as `z.ZodType<TsInterface>` values. This
 * is the same idiom `storage/wire-record.ts` uses to keep
 * `isolatedDeclarations` happy — without it every exported schema
 * would need a gigantic generated zod type annotation.
 */

import { z } from 'zod';

import { MCPConfigError } from './errors.js';

export interface StdioServerConfig {
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly cwd?: string | undefined;
}

const _rawStdioServerConfigSchema = z
  .object({
    command: z.string().min(1, 'stdio server "command" must be a non-empty string'),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
  })
  .strict();

export const StdioServerConfigSchema: z.ZodType<StdioServerConfig> = _rawStdioServerConfigSchema;

export interface HttpServerConfig {
  readonly url: string;
  /**
   * `http` = Streamable HTTP (the canonical new transport).
   * `sse` is accepted as an alias — some deployments still advertise
   * the legacy SSE endpoint name. Both route through the SDK's
   * `StreamableHTTPClientTransport`.
   */
  readonly transport: 'http' | 'sse';
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

const _rawHttpServerConfigSchema = z
  .object({
    url: z.string().url('http server "url" must be a valid URL'),
    transport: z.union([z.literal('http'), z.literal('sse')]),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const HttpServerConfigSchema: z.ZodType<HttpServerConfig> = _rawHttpServerConfigSchema;

export type McpServerConfig = StdioServerConfig | HttpServerConfig;

const _rawMcpServerConfigSchema = z.union([
  _rawStdioServerConfigSchema,
  _rawHttpServerConfigSchema,
]);

export const McpServerConfigSchema: z.ZodType<McpServerConfig> = _rawMcpServerConfigSchema;

export interface McpConfig {
  readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
}

const _rawMcpConfigSchema = z
  .object({
    mcpServers: z.record(z.string().min(1), _rawMcpServerConfigSchema),
  })
  .strict();

export const McpConfigSchema: z.ZodType<McpConfig> = _rawMcpConfigSchema;

/**
 * Parse and validate a Claude Desktop-format MCP config object.
 * Throws {@link MCPConfigError} with a human-readable message when
 * validation fails — callers surface that to the user untouched.
 */
export function parseMcpConfig(raw: unknown): McpConfig {
  const parsed = McpConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new MCPConfigError(
      `Invalid MCP config: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

/** True when the config is a stdio server. Narrows for TS consumers. */
export function isStdioServer(cfg: McpServerConfig): cfg is StdioServerConfig {
  return 'command' in cfg;
}

/** True when the config is a remote HTTP server. */
export function isHttpServer(cfg: McpServerConfig): cfg is HttpServerConfig {
  return 'url' in cfg;
}
