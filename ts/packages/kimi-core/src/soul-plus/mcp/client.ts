/**
 * MCPClient abstraction + SDK-backed concrete implementations —
 * Slice 2.6.
 *
 * `MCPClient` is the minimum surface `MCPManager` / `tool-adapter.ts`
 * need to drive a server: `connect → listTools → callTool → close`.
 * It is transport-agnostic so test code can substitute an in-memory
 * fake without loading `@modelcontextprotocol/sdk`.
 *
 * Two concrete classes wrap the official SDK:
 *
 *   - {@link StdioMcpClient} — spawns a child process via
 *     `StdioClientTransport`. Forces `stderr: 'pipe'` (SDK default
 *     would inherit the parent TTY and flood the user's terminal with
 *     MCP debug noise, see P0-2 in the Slice spec) and pipes every
 *     line through the caller-supplied `onStderr` callback.
 *
 *   - {@link HttpMcpClient} — talks to a remote server via
 *     `StreamableHTTPClientTransport`. Extra `headers` from config are
 *     passed through `requestInit.headers`. OAuth is intentionally
 *     out of scope for Slice 2.6.
 *
 * Both classes defer connection to `connect()` so construction is
 * cheap and `MCPManager` can own the lifecycle.
 */

import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

import type { Client as SdkClient } from '@modelcontextprotocol/sdk/client/index.js';
import type { StdioClientTransport as SdkStdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { StreamableHTTPClientTransport as SdkStreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { HttpServerConfig, StdioServerConfig } from './config.js';
import type { McpContentBlock } from './output-budget.js';

/** MCP tool definition as returned by `tools/list`. */
export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Raw result from an MCP `tools/call`. Structural subset; the concrete
 * SDK shape is wider but the fields we care about are these.
 */
export interface MCPToolResult {
  content: McpContentBlock[];
  isError?: boolean | undefined;
}

/**
 * Optional per-call knobs for {@link MCPClient.callTool}. Currently
 * only `signal` is wired — forwarded into the SDK's `RequestOptions`
 * so aborting the caller's signal cancels the in-flight MCP request
 * instead of leaving it running until the server responds.
 */
export interface CallToolOptions {
  /**
   * Cancels the in-flight request. Implementations forward this into
   * `RequestOptions.signal` of the underlying SDK `Protocol.request`;
   * aborting cascades into the MCP transport so the downstream
   * server actually stops working.
   */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Minimum surface `MCPManager` drives. Kept small so fakes don't need
 * to reimplement the full SDK protocol stack.
 *
 * **stderr handling is not part of this interface.**
 * {@link StdioMcpClient} accepts an `onStderr` callback at
 * construction time and forwards each child-process stderr line to
 * the host; {@link HttpMcpClient} has no stderr stream at all. Code
 * holding an `MCPClient` reference therefore cannot assume the
 * server's diagnostic output is observable from here — plumb the
 * callback through at construction if you need it.
 */
export interface MCPClient {
  /** Open the transport + run the MCP `initialize` handshake. */
  connect(): Promise<void>;
  /** Discover available tools via `tools/list`. */
  listTools(): Promise<MCPToolDefinition[]>;
  /**
   * Invoke a tool by name with arbitrary JSON arguments.
   *
   * When `options.signal` aborts, implementations must cancel the
   * underlying SDK request — not merely reject their own promise —
   * so the transport stops waiting for a response the caller no
   * longer needs.
   */
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: CallToolOptions,
  ): Promise<MCPToolResult>;
  /** Dispose of the transport and the underlying subprocess / socket. */
  close(): Promise<void>;
}

/** Host-injected callback for MCP server stderr lines (stdio only). */
export type McpStderrCallback = (serverName: string, line: string) => void;

const CLIENT_NAME = 'kimi-core';
const CLIENT_VERSION = '0.1.0';

async function newSdkClient(): Promise<SdkClient> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  return new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
}

/**
 * Stdio-backed MCP client. Spawns a child process the first time
 * `connect()` is called and routes its stderr through
 * {@link McpStderrCallback}.
 */
export class StdioMcpClient implements MCPClient {
  private client: SdkClient | null = null;
  private transport: SdkStdioClientTransport | null = null;
  private stderrReader: ReadlineInterface | null = null;

  constructor(
    private readonly serverName: string,
    private readonly config: StdioServerConfig,
    private readonly onStderr?: McpStderrCallback | undefined,
  ) {}

  async connect(): Promise<void> {
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    // `stderr: 'pipe'` is the P0-2 requirement: the SDK's default is
    // `'inherit'` which flood-fills the parent TTY with MCP debug
    // output. Piping lets us forward each line through `onStderr` to
    // whatever sink the host chose.
    const transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args !== undefined ? [...this.config.args] : [],
      ...(this.config.env !== undefined ? { env: { ...this.config.env } } : {}),
      ...(this.config.cwd !== undefined ? { cwd: this.config.cwd } : {}),
      stderr: 'pipe',
    });
    this.transport = transport;

    this.client = await newSdkClient();
    await this.client.connect(transport);

    // SDK exposes the pipe stream via `transport.stderr` once `start`
    // has run (which `client.connect` does). Subscribe after connect
    // so we know the stream is attached. `readline` handles partial
    // line buffering for us. The SDK types `stderr` as the broad
    // `node:stream.Stream` base class; `readline` needs the narrower
    // `NodeJS.ReadableStream` — the concrete value is always a
    // `PassThrough` so the cast is safe.
    const stderrStream = transport.stderr;
    if (stderrStream !== null && this.onStderr !== undefined) {
      const cb = this.onStderr;
      const name = this.serverName;
      const rl = createInterface({
        input: stderrStream as unknown as NodeJS.ReadableStream,
      });
      this.stderrReader = rl;
      rl.on('line', (line) => {
        try {
          cb(name, line);
        } catch {
          // `onStderr` is host-supplied — never let it crash the
          // session. Intentional silent swallow.
        }
      });
    }
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    const client = this.requireClient();
    const result = await client.listTools();
    return result.tools.map(toToolDefinition);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: CallToolOptions,
  ): Promise<MCPToolResult> {
    const client = this.requireClient();
    // Forward the caller's AbortSignal into SDK RequestOptions.signal
    // (`shared/protocol.d.ts:61-71`) so aborting the turn actually
    // cancels the in-flight MCP request — without this the SDK
    // keeps waiting for a server response after we've already
    // returned a timeout/abort error to Soul.
    const sdkOptions = options?.signal !== undefined ? { signal: options.signal } : undefined;
    const result = await client.callTool({ name, arguments: args }, undefined, sdkOptions);
    return {
      content: (result.content as McpContentBlock[]) ?? [],
      isError: typeof result.isError === 'boolean' ? result.isError : false,
    };
  }

  async close(): Promise<void> {
    const client = this.client;
    const reader = this.stderrReader;
    this.client = null;
    this.transport = null;
    this.stderrReader = null;
    // Close the readline interface **before** closing the transport
    // so the `'line'` listener cannot fire on a server that is
    // already half gone — and so test mocks that reuse a fake stderr
    // stream don't leak a stale listener across close/reconnect
    // cycles (Mi1).
    if (reader !== null) {
      reader.close();
    }
    if (client !== null) {
      await client.close();
    }
  }

  private requireClient(): SdkClient {
    if (this.client === null) {
      throw new Error(
        `StdioMcpClient for "${this.serverName}" used before connect() or after close()`,
      );
    }
    return this.client;
  }
}

/**
 * Streamable-HTTP / SSE MCP client. Auth is limited to simple bearer
 * tokens / custom headers for Slice 2.6 (OAuth deferred).
 */
export class HttpMcpClient implements MCPClient {
  private client: SdkClient | null = null;
  private transport: SdkStreamableHTTPClientTransport | null = null;

  constructor(
    private readonly serverName: string,
    private readonly config: HttpServerConfig,
  ) {}

  async connect(): Promise<void> {
    const { StreamableHTTPClientTransport } =
      await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const url = new URL(this.config.url);
    const transport = new StreamableHTTPClientTransport(
      url,
      this.config.headers !== undefined
        ? { requestInit: { headers: { ...this.config.headers } } }
        : {},
    );
    this.transport = transport;

    this.client = await newSdkClient();
    // The SDK's `Transport` interface sets `sessionId?: string`, while
    // `StreamableHTTPClientTransport` declares `sessionId: string | undefined`.
    // Under `exactOptionalPropertyTypes: true` those aren't assignable
    // even though they are behaviourally identical — a known SDK typing
    // quirk. Cast through `unknown` keeps the rest of the signature
    // checked.
    await this.client.connect(transport as unknown as Parameters<SdkClient['connect']>[0]);
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    const client = this.requireClient();
    const result = await client.listTools();
    return result.tools.map(toToolDefinition);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: CallToolOptions,
  ): Promise<MCPToolResult> {
    const client = this.requireClient();
    // Forward the caller's AbortSignal into SDK RequestOptions.signal
    // (`shared/protocol.d.ts:61-71`) so aborting the turn actually
    // cancels the in-flight MCP request — without this the SDK
    // keeps waiting for a server response after we've already
    // returned a timeout/abort error to Soul.
    const sdkOptions = options?.signal !== undefined ? { signal: options.signal } : undefined;
    const result = await client.callTool({ name, arguments: args }, undefined, sdkOptions);
    return {
      content: (result.content as McpContentBlock[]) ?? [],
      isError: typeof result.isError === 'boolean' ? result.isError : false,
    };
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.transport = null;
    if (client !== null) {
      await client.close();
    }
  }

  private requireClient(): SdkClient {
    if (this.client === null) {
      throw new Error(
        `HttpMcpClient for "${this.serverName}" used before connect() or after close()`,
      );
    }
    return this.client;
  }
}

function toToolDefinition(raw: {
  name: string;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
}): MCPToolDefinition {
  return {
    name: raw.name,
    description: raw.description ?? '',
    inputSchema: raw.inputSchema,
  };
}
