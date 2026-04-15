/**
 * MCP subsystem error classes — Slice 2.6.
 *
 * Mirror the Python `MCPConfigError` / `MCPRuntimeError` split so rule
 * libraries and log consumers can classify failures consistently across
 * both runtimes.
 */

/** Schema-level / config-parsing failure (user-fixable). */
export class MCPConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MCPConfigError';
  }
}

/**
 * Runtime failure class (spawn / handshake / RPC).
 *
 * **Not thrown from anywhere inside Slice 2.6** — the manager swallows
 * per-server failures for graceful degrade (`manager.ts:connectServer`
 * catches everything and records it as a `'failed'` state), and the
 * tool adapter returns `ToolError`-shaped results instead of throwing
 * from `execute`. The class is kept in the public surface so host
 * code and future slices can categorise caught errors consistently
 * with the Python side (`MCPRuntimeError` there) without kimi-core
 * needing to re-introduce a throw point.
 */
export class MCPRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MCPRuntimeError';
  }
}

/**
 * Dedicated timeout marker so `tool-adapter.ts` can distinguish hard
 * timeouts from generic runtime errors without string-matching. Python
 * had to do substring matching because `fastmcp` raises a bare
 * `RuntimeError`; the TS SDK does not give us a public timeout class
 * either, so we throw this ourselves from the `Promise.race` guard.
 */
export class MCPTimeoutError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly timeoutMs: number,
  ) {
    super(`MCP tool "${toolName}" timed out after ${timeoutMs}ms`);
    this.name = 'MCPTimeoutError';
  }
}
