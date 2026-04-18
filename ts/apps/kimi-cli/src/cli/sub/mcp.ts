/**
 * `kimi mcp` sub-commands — Phase 19 Slice D.
 *
 * Three command handlers (auth / test / reset-auth) are implemented
 * behind a dependency-injection seam so unit tests can drive the CLI
 * without touching the filesystem, the network, or a real browser:
 *
 *   - `loadConfig`         — resolve the `{mcpServers}` map.
 *   - `createProvider`     — build a persistence-backed OAuth provider.
 *   - `startCallbackServer`— run the local `/callback` listener.
 *   - `createClient`       — build an HTTP MCP client wired with the
 *                            `authProvider`; exposes `.transport` so
 *                            the CLI can call `finishAuth(code)`.
 *   - `exit` / `stdout` / `stderr` — capture side effects.
 *
 * Production construction reads `~/.kimi/config.toml`, uses
 * `McpOAuthProvider` / `startOAuthCallbackServer` from kimi-core, and
 * constructs a `HttpMcpClient` with the auth provider threaded in.
 *
 * `add` / `remove` / `list` keep their Phase 19 placeholder stubs —
 * those are scheduled for a later slice.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type {
  HttpServerConfig,
  McpConfig,
  McpServerConfig,
  OAuthCallbackServerHandle,
  OAuthClientProvider,
  StdioServerConfig,
} from '@moonshot-ai/core';
import {
  HttpMcpClient,
  McpOAuthProvider,
  StdioMcpClient,
  atomicWrite,
  parseMcpConfig,
  startOAuthCallbackServer,
} from '@moonshot-ai/core';
import type { Command } from 'commander';
import { parse as parseToml } from 'smol-toml';

import { getConfigPath, getDataDir, getMCPConfigPath } from '../../config/paths.js';

// ─── DI surface ───────────────────────────────────────────────────────

/**
 * Provider-side facet consumed by the CLI. The CLI only calls
 * `.clear()` directly — the remainder of the `OAuthClientProvider`
 * contract is driven by the MCP SDK via the injected `authProvider`
 * on the transport, so production deps MUST return a real
 * `McpOAuthProvider` (not a narrow `{clear}` shim — see Slice D
 * review B-1: a partial stub causes `TypeError: tokens is not a
 * function` once the SDK exchanges the code). Tests cast a narrow
 * fake through `as McpCommandDeps['createProvider']` because their
 * mock `createClient` never reaches the real SDK.
 */
export type McpAuthProviderHandle = OAuthClientProvider & {
  clear(): Promise<void>;
};

/**
 * Client-side facet consumed by the CLI. Keeps the surface narrow so
 * test doubles don't have to reimplement the SDK's full MCP client.
 * `transport` is optional because stdio servers don't have an OAuth
 * transport — only http servers expose `finishAuth(code)`.
 */
export interface McpCliClient {
  connect(): Promise<void>;
  listTools(): Promise<ReadonlyArray<{ name: string; description?: string | undefined }>>;
  close(): Promise<void>;
  readonly transport?: { finishAuth(code: string): Promise<void> };
}

export interface McpCommandDeps {
  readonly loadConfig: () => Promise<McpConfig>;
  /**
   * Persist the merged MCP config to disk. Called by `mcp add` and
   * `mcp remove` after they mutate the in-memory config. Tests supply a
   * spy; production writes `~/.kimi/mcp.json` atomically.
   */
  readonly saveConfig: (config: McpConfig) => Promise<void>;
  /**
   * Path shown to users in `mcp list` output so they know where the
   * config they are viewing actually lives.
   */
  readonly configPath: string;
  readonly createProvider: (
    serverId: string,
    redirectPort: number,
  ) => McpAuthProviderHandle;
  readonly startCallbackServer: () => Promise<OAuthCallbackServerHandle>;
  /**
   * Build an MCP client for any server shape. Production default
   * dispatches on `isHttpServerConfig(serverConfig)`: http → `HttpMcpClient`
   * wired with `authProvider`; stdio → `StdioMcpClient` (which simply
   * ignores any `authProvider` since stdio has no OAuth flow).
   */
  readonly createClient: (
    serverConfig: McpServerConfig,
    authProvider?: OAuthClientProvider,
  ) => McpCliClient;
  readonly exit: (code: number) => never;
  readonly stdout: { write(chunk: string | Uint8Array): boolean };
  readonly stderr: { write(chunk: string | Uint8Array): boolean };
}

// ─── Internal helpers ────────────────────────────────────────────────

const CALLBACK_TIMEOUT_MS = 300_000; // 5 min — matches McpOAuthProvider default

function isUnauthorizedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // Matches both the SDK's `UnauthorizedError` (name = "UnauthorizedError")
  // and any Error subclass that sets the same name — the test doubles
  // rely on this to simulate the SDK throw without importing the SDK.
  return error.name === 'UnauthorizedError';
}

function isHttpServerConfig(
  cfg: McpConfig['mcpServers'][string],
): cfg is HttpServerConfig {
  return 'url' in cfg;
}

function requireHttpTransport(client: McpCliClient): {
  finishAuth(code: string): Promise<void>;
} {
  const t = client.transport;
  if (t === undefined) {
    // Reached only if production deps built a stdio client but the CLI
    // tried to run the OAuth finish step. `handleAuth`/`handleTest`
    // already branch on `isHttpServerConfig` before calling this, so
    // this throw is a defensive invariant, not an expected path.
    throw new Error('Internal: OAuth transport unavailable for non-HTTP MCP client');
  }
  return t;
}

// ─── Command handlers ────────────────────────────────────────────────

async function handleAuth(deps: McpCommandDeps, name: string): Promise<void> {
  const config = await deps.loadConfig();
  const server = config.mcpServers[name];
  if (server === undefined) {
    deps.stderr.write(`MCP server '${name}' not found in config.\n`);
    deps.exit(1);
  }
  if (!isHttpServerConfig(server)) {
    deps.stderr.write(
      `MCP server '${name}' is stdio; only http servers support OAuth.\n`,
    );
    deps.exit(1);
  }

  const callbackServer = await deps.startCallbackServer();
  try {
    const provider = deps.createProvider(name, callbackServer.port);
    const client = deps.createClient(server, provider);
    try {
      await client.connect();
    } catch (error) {
      if (!isUnauthorizedError(error)) {
        throw error;
      }
      const { code } = await callbackServer.waitForCode({ timeoutMs: CALLBACK_TIMEOUT_MS });
      await requireHttpTransport(client).finishAuth(code);
      await client.connect();
    }
    deps.stdout.write(`Successfully authorized with '${name}'.\n`);
    await client.close();
  } finally {
    await callbackServer.close();
  }
}

async function handleTest(deps: McpCommandDeps, name: string): Promise<void> {
  const config = await deps.loadConfig();
  const server = config.mcpServers[name];
  if (server === undefined) {
    deps.stderr.write(`MCP server '${name}' not found in config.\n`);
    deps.exit(1);
  }

  if (!isHttpServerConfig(server)) {
    // Stdio path: no OAuth plumbing, just connect + listTools. The
    // union-typed `createClient` signature means no cast is needed —
    // production `defaultCreateClient` dispatches to `StdioMcpClient`.
    try {
      const stdioClient = deps.createClient(server);
      try {
        await stdioClient.connect();
        const tools = await stdioClient.listTools();
        writeToolListing(deps, name, tools);
      } finally {
        await stdioClient.close();
      }
    } catch (error) {
      deps.stderr.write(
        `Failed to connect to MCP server '${name}': ${describeError(error)}\n`,
      );
      deps.exit(1);
    }
    return;
  }

  // HTTP path: stand up the callback server + provider so a missing
  // token can kick off the PKCE flow transparently — the same shape as
  // `mcp auth` but with a `listTools` step at the end.
  const callbackServer = await deps.startCallbackServer();
  try {
    const provider = deps.createProvider(name, callbackServer.port);
    const client = deps.createClient(server, provider);
    try {
      try {
        await client.connect();
      } catch (error) {
        if (!isUnauthorizedError(error)) throw error;
        const { code } = await callbackServer.waitForCode({
          timeoutMs: CALLBACK_TIMEOUT_MS,
        });
        await requireHttpTransport(client).finishAuth(code);
        await client.connect();
      }
      const tools = await client.listTools();
      writeToolListing(deps, name, tools);
    } finally {
      await client.close();
    }
  } catch (error) {
    deps.stderr.write(
      `Failed to connect to MCP server '${name}': ${describeError(error)}\n`,
    );
    deps.exit(1);
  } finally {
    await callbackServer.close();
  }
}

async function handleResetAuth(deps: McpCommandDeps, name: string): Promise<void> {
  const config = await deps.loadConfig();
  const server = config.mcpServers[name];
  if (server === undefined) {
    deps.stderr.write(`MCP server '${name}' not found in config.\n`);
    deps.exit(1);
  }
  if (!isHttpServerConfig(server)) {
    deps.stderr.write(
      `MCP server '${name}' is stdio; only http servers support OAuth.\n`,
    );
    deps.exit(1);
  }

  // `redirectPort` is irrelevant for a clear() call — the provider
  // never serves an auth flow here. We pass `0` to make the intent
  // explicit; the persistence path is what matters.
  const provider = deps.createProvider(name, 0);
  await provider.clear();
  deps.stdout.write(`OAuth tokens cleared for '${name}'.\n`);
}

function writeToolListing(
  deps: McpCommandDeps,
  name: string,
  tools: ReadonlyArray<{ name: string; description?: string | undefined }>,
): void {
  const count = tools.length;
  deps.stdout.write(`${name}: ${count} tool${count === 1 ? '' : 's'}\n`);
  for (const tool of tools) {
    const desc = tool.description !== undefined && tool.description.length > 0
      ? `: ${tool.description}`
      : '';
    deps.stdout.write(`  - ${tool.name}${desc}\n`);
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ─── Default dep factory (production path) ───────────────────────────

/**
 * Load the CLI's view of the MCP config. Mirrors Python's `mcp.py`
 * global-config lookup: `~/.kimi/mcp.json` is the source of truth for
 * `mcp add`/`mcp remove`/`mcp list`. When the file is missing we fall
 * back to the `[mcp.servers]` / `[mcp.mcpServers]` table in
 * `config.toml` so setups that still carry only the legacy inline
 * config keep working — but `saveConfig` always writes to `mcp.json`.
 */
async function defaultLoadConfig(): Promise<McpConfig> {
  try {
    const raw = await readFile(getMCPConfigPath(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return parseMcpConfig(parsed);
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
  }
  return loadLegacyTomlMcpConfig();
}

async function loadLegacyTomlMcpConfig(): Promise<McpConfig> {
  let raw: string;
  try {
    raw = await readFile(getConfigPath(), 'utf8');
  } catch (error) {
    if (isFileNotFound(error)) return { mcpServers: {} };
    throw error;
  }
  const parsed = parseToml(raw) as Record<string, unknown>;
  const mcpSection = parsed['mcp'];
  if (mcpSection === undefined || mcpSection === null || typeof mcpSection !== 'object') {
    return { mcpServers: {} };
  }
  const mcpObj = mcpSection as Record<string, unknown>;
  const servers =
    (mcpObj['servers'] as Record<string, unknown> | undefined) ??
    (mcpObj['mcpServers'] as Record<string, unknown> | undefined);
  if (servers === undefined || Object.keys(servers).length === 0) {
    return { mcpServers: {} };
  }
  return parseMcpConfig({ mcpServers: servers });
}

async function defaultSaveConfig(config: McpConfig): Promise<void> {
  const path = getMCPConfigPath();
  await mkdir(dirname(path), { recursive: true });
  // Reject writing a malformed config — matches the validation Python
  // does before `_save_mcp_config` so a bad merge never lands on disk.
  parseMcpConfig(config);
  // Phase 21 review hotfix — atomicWrite so a partial write (disk full,
  // crash, killed process) cannot truncate the existing mcp.json and
  // strand the user's MCP fleet.
  await atomicWrite(path, JSON.stringify(config, null, 2) + '\n');
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

/**
 * Wrap a real `HttpMcpClient` so its SDK-typed `transport` getter
 * surfaces through the narrow `McpCliClient.transport` shape. We
 * intentionally call `finishAuth` through a lambda rather than
 * returning the SDK transport directly — this keeps the interface
 * decoupled from the SDK types and lets us guard the null window
 * (transport is `null` until `connect()` has at least started).
 */
function wrapHttpClient(
  serverConfig: HttpServerConfig,
  authProvider: OAuthClientProvider | undefined,
): McpCliClient {
  const real = new HttpMcpClient('cli', serverConfig, authProvider);
  return {
    connect: () => real.connect(),
    listTools: () => real.listTools(),
    close: () => real.close(),
    transport: {
      async finishAuth(code: string) {
        const t = real.transport;
        if (t === null) {
          throw new Error('HTTP MCP transport unavailable — connect() must run first');
        }
        await t.finishAuth(code);
      },
    },
  };
}

function wrapStdioClient(serverConfig: McpServerConfig): McpCliClient {
  // Narrowed at the call site via `isHttpServerConfig`, but we accept
  // the union here so the default factory can dispatch in one place.
  if (isHttpServerConfig(serverConfig)) {
    // Should not happen — kept as a defensive guard.
    throw new Error('wrapStdioClient received an HTTP server config');
  }
  const real = new StdioMcpClient('cli', serverConfig);
  return {
    connect: () => real.connect(),
    listTools: () => real.listTools(),
    close: () => real.close(),
    // No `transport`: stdio servers have no OAuth flow.
  };
}

function buildDefaultDeps(): McpCommandDeps {
  return {
    loadConfig: defaultLoadConfig,
    saveConfig: defaultSaveConfig,
    configPath: getMCPConfigPath(),
    // Synchronously construct the real `McpOAuthProvider` — it fully
    // implements `OAuthClientProvider` so the SDK can drive
    // `tokens()`, `saveTokens()`, `saveCodeVerifier()` etc. during
    // the PKCE exchange. A narrow `{clear}` shim here would cause
    // `TypeError: X is not a function` inside the SDK.
    createProvider: (serverId, redirectPort) =>
      new McpOAuthProvider({ serverId, kimiHome: getDataDir(), redirectPort }),
    startCallbackServer: () => startOAuthCallbackServer(),
    createClient: (serverConfig, authProvider) =>
      isHttpServerConfig(serverConfig)
        ? wrapHttpClient(serverConfig, authProvider)
        : wrapStdioClient(serverConfig),
    exit: (code: number): never => {
      process.exit(code);
    },
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

// ─── add / remove / list handlers ────────────────────────────────────

export interface McpAddOptions {
  readonly transport: 'stdio' | 'http';
  readonly env?: string[] | undefined;
  readonly header?: string[] | undefined;
  readonly auth?: string | undefined;
  readonly force?: boolean | undefined;
}

async function handleAdd(
  deps: McpCommandDeps,
  name: string,
  target: readonly string[],
  opts: McpAddOptions,
): Promise<void> {
  if (name.length === 0) {
    deps.stderr.write('Error: server name is required.\n');
    deps.exit(1);
  }

  const transport = opts.transport;
  if (transport !== 'stdio' && transport !== 'http') {
    deps.stderr.write(`Unsupported transport: ${String(transport)}.\n`);
    deps.exit(1);
  }

  if (target.length === 0) {
    deps.stderr.write(
      transport === 'stdio'
        ? 'For stdio transport, provide the command after `--`.\n'
        : 'URL is required for http transport.\n',
    );
    deps.exit(1);
  }

  let serverConfig: McpServerConfig;
  if (transport === 'stdio') {
    if (opts.header !== undefined && opts.header.length > 0) {
      deps.stderr.write('--header is only valid for http transport.\n');
      deps.exit(1);
    }
    if (opts.auth !== undefined && opts.auth.length > 0) {
      deps.stderr.write('--auth is only valid for http transport.\n');
      deps.exit(1);
    }
    const [command, ...args] = target;
    if (command === undefined) {
      deps.stderr.write('For stdio transport, provide the command after `--`.\n');
      deps.exit(1);
    }
    const stdio: StdioServerConfig = {
      command,
      ...(args.length > 0 ? { args } : {}),
      ...(opts.env !== undefined && opts.env.length > 0
        ? { env: parseKeyValuePairs(deps, opts.env, 'env', '=') }
        : {}),
    };
    serverConfig = stdio;
  } else {
    if (opts.env !== undefined && opts.env.length > 0) {
      deps.stderr.write('--env is only supported for stdio transport.\n');
      deps.exit(1);
    }
    if (target.length > 1) {
      deps.stderr.write(
        'Multiple targets provided. Supply a single URL for http transport.\n',
      );
      deps.exit(1);
    }
    const [url] = target;
    if (url === undefined) {
      deps.stderr.write('URL is required for http transport.\n');
      deps.exit(1);
    }
    const http: HttpServerConfig = {
      url,
      transport: 'http',
      ...(opts.header !== undefined && opts.header.length > 0
        ? { headers: parseKeyValuePairs(deps, opts.header, 'header', ':', true) }
        : {}),
      ...(opts.auth === 'oauth' ? { auth: 'oauth' as const } : {}),
    };
    if (opts.auth !== undefined && opts.auth.length > 0 && opts.auth !== 'oauth') {
      deps.stderr.write(`Unsupported --auth value: ${opts.auth} (expected 'oauth').\n`);
      deps.exit(1);
    }
    serverConfig = http;
  }

  const existing = await deps.loadConfig();
  if (existing.mcpServers[name] !== undefined && opts.force !== true) {
    deps.stderr.write(
      `MCP server '${name}' already exists. Use --force to overwrite or run \`kimi mcp remove ${name}\` first.\n`,
    );
    deps.exit(1);
  }

  const merged: McpConfig = {
    mcpServers: { ...existing.mcpServers, [name]: serverConfig },
  };
  await deps.saveConfig(merged);
  deps.stdout.write(`Added MCP server '${name}' to ${deps.configPath}.\n`);
}

async function handleRemove(deps: McpCommandDeps, name: string): Promise<void> {
  const existing = await deps.loadConfig();
  if (existing.mcpServers[name] === undefined) {
    deps.stderr.write(`MCP server '${name}' not found.\n`);
    deps.exit(1);
  }
  const rest: Record<string, McpServerConfig> = { ...existing.mcpServers };
  delete rest[name];
  await deps.saveConfig({ mcpServers: rest });
  deps.stdout.write(`Removed MCP server '${name}' from ${deps.configPath}.\n`);
}

async function handleList(deps: McpCommandDeps): Promise<void> {
  const config = await deps.loadConfig();
  const entries = Object.entries(config.mcpServers);
  deps.stdout.write(`MCP config file: ${deps.configPath}\n`);
  if (entries.length === 0) {
    deps.stdout.write('No MCP servers configured.\n');
    return;
  }
  for (const [name, server] of entries) {
    deps.stdout.write(`  ${formatServerLine(name, server)}\n`);
  }
}

function formatServerLine(name: string, server: McpServerConfig): string {
  if (isHttpServerConfig(server)) {
    const transport = server.transport === 'sse' ? 'sse' : 'http';
    let line = `${name} (${transport}): ${server.url}`;
    if (server.auth === 'oauth') {
      line += ` [oauth — run 'kimi mcp auth ${name}' to authorize]`;
    }
    return line;
  }
  const args = server.args ?? [];
  const cmd = `${server.command}${args.length > 0 ? ' ' + args.join(' ') : ''}`;
  return `${name} (stdio): ${cmd}`.trimEnd();
}

function collectRepeatable(value: string, previous: readonly string[]): string[] {
  return [...previous, value];
}

function parseKeyValuePairs(
  deps: McpCommandDeps,
  items: readonly string[],
  optionName: string,
  separator: string,
  stripWhitespace: boolean = false,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of items) {
    const idx = item.indexOf(separator);
    if (idx === -1) {
      deps.stderr.write(
        `Invalid ${optionName} format: ${item} (expected KEY${separator}VALUE).\n`,
      );
      deps.exit(1);
    }
    let key = item.slice(0, idx);
    let value = item.slice(idx + separator.length);
    if (stripWhitespace) {
      key = key.trim();
      value = value.trim();
    }
    if (key.length === 0) {
      deps.stderr.write(`Invalid ${optionName} format: ${item} (empty key).\n`);
      deps.exit(1);
    }
    out[key] = value;
  }
  return out;
}

// ─── Registration entry point ────────────────────────────────────────

export function registerMcpCommand(parent: Command, deps?: McpCommandDeps): void {
  const resolvedDeps = deps ?? buildDefaultDeps();

  const mcp = parent
    .command('mcp')
    .description('Manage MCP servers.');

  mcp
    .command('add')
    .description('Add an MCP server.')
    .argument('<name>', 'Name of the MCP server to add.')
    .argument(
      '[target...]',
      'For http: server URL. For stdio: command and arguments (after `--`).',
    )
    .option('-t, --transport <transport>', 'Transport type: stdio | http.', 'stdio')
    .option(
      '-e, --env <key=value>',
      'Environment variable (stdio only). Repeatable.',
      collectRepeatable,
      [] as string[],
    )
    .option(
      '-H, --header <key:value>',
      'HTTP header (http only). Repeatable.',
      collectRepeatable,
      [] as string[],
    )
    .option('-a, --auth <type>', 'Authorization type (e.g., oauth).')
    .option('--force', 'Overwrite an existing server with the same name.', false)
    .action(
      async (
        name: string,
        target: string[],
        opts: {
          transport?: 'stdio' | 'http';
          env?: string[];
          header?: string[];
          auth?: string;
          force?: boolean;
        },
      ) => {
        await handleAdd(resolvedDeps, name, target, {
          transport: (opts.transport ?? 'stdio') as 'stdio' | 'http',
          env: opts.env,
          header: opts.header,
          ...(opts.auth !== undefined ? { auth: opts.auth } : {}),
          force: opts.force === true,
        });
      },
    );

  mcp
    .command('remove')
    .description('Remove an MCP server.')
    .argument('<name>', 'Server name to remove.')
    .action(async (name: string) => {
      await handleRemove(resolvedDeps, name);
    });

  mcp
    .command('list')
    .description('List all MCP servers.')
    .action(async () => {
      await handleList(resolvedDeps);
    });

  mcp
    .command('auth')
    .description('OAuth authenticate an MCP server.')
    .argument('<name>', 'Server name to authenticate.')
    .action(async (name: string) => {
      await handleAuth(resolvedDeps, name);
    });

  mcp
    .command('reset-auth')
    .description('Reset OAuth authentication for an MCP server.')
    .argument('<name>', 'Server name to reset.')
    .action(async (name: string) => {
      await handleResetAuth(resolvedDeps, name);
    });

  mcp
    .command('test')
    .description('Test MCP server connection.')
    .argument('<name>', 'Server name to test.')
    .action(async (name: string) => {
      await handleTest(resolvedDeps, name);
    });
}
