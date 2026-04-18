/**
 * Reverse-RPC primitives shared by the production `--wire` runner and
 * the in-memory wire harness (Phase 21 §A).
 *
 * The wire protocol is bidirectional: clients send requests to the core,
 * but the core also issues `tool.call` / `hook.request` / `approval.request`
 * frames back to the client and waits for matching responses. The
 * primitives here implement that "core-as-client" path without depending
 * on a particular transport implementation:
 *
 *   - `ReverseRpcClient` — promise-based send-and-wait keyed by request id
 *   - `createReverseRpcClient` — wires a transport + router into a sender
 *   - `buildExternalToolProxy` — wraps a `tool.call` reverse-RPC as a Tool
 *   - `createWireHookSender` — adapts `hook.request` reverse-RPC for the
 *     `WireHookSender` interface consumed by `WireHookExecutor`
 *
 * Originally lived in `test/helpers/wire/phase18-extensions.ts`. Moved
 * to `src/` so the production wire handlers can register the matching
 * 8 Section-A methods without depending on test code. The test helper
 * re-exports these symbols verbatim to avoid churning callers.
 */

import { z } from 'zod';

import type { WireHookSender } from '../hooks/wire-executor.js';
import type { HookInput } from '../hooks/types.js';
import type { RequestRouter } from '../router/request-router.js';
import type { Tool, ToolCall, ToolResult } from '../soul/types.js';
import type { Transport } from '../transport/types.js';
import { WireCodec } from './codec.js';
import { createWireRequest } from './message-factory.js';
import type { WireMessage } from './types.js';

// ── Per-session reverse-RPC state ─────────────────────────────────────

/**
 * Reverse-RPC state held per session id by the wire layer. External tool
 * registrations (`session.registerTool`), the active-tool narrowing list
 * (`session.setActiveTools`), and event-fan-out filters
 * (`session.subscribe` / `session.unsubscribe`) all live here.
 */
export interface PerSessionWireState {
  readonly externalTools: Map<string, ExternalToolState>;
  activeToolNames: string[] | undefined;
  eventFilter: Set<string> | undefined;
  bridgeDispose?: (() => void) | undefined;
}

export interface ExternalToolState {
  description: string;
  input_schema?: unknown;
}

export type PerSessionStateMap = Map<string, PerSessionWireState>;

export function getOrInitSessionState(
  map: PerSessionStateMap,
  sessionId: string,
): PerSessionWireState {
  let state = map.get(sessionId);
  if (state === undefined) {
    state = {
      externalTools: new Map(),
      activeToolNames: undefined,
      eventFilter: undefined,
    };
    map.set(sessionId, state);
  }
  return state;
}

// ── Reverse-RPC client ────────────────────────────────────────────────

export type ReverseRpcMethod =
  | 'tool.call'
  | 'hook.request'
  | 'approval.request'
  | 'question.ask';

export interface ReverseRpcClient {
  sendRequest(
    method: ReverseRpcMethod,
    sessionId: string,
    data: unknown,
    options?: { timeoutMs?: number; signal?: AbortSignal | undefined },
  ): Promise<WireMessage>;
}

export interface CreateReverseRpcClientOptions {
  /**
   * Server-side transport used to issue the outgoing request frame.
   * `Transport` is the lowest-common-denominator interface so the same
   * helper works for `MemoryTransport` (in-memory harness) and
   * `StdioTransport` (production `--wire`).
   */
  readonly server: Transport;
  /** Router whose pending-request map captures the matching response. */
  readonly router: RequestRouter;
  readonly codec?: WireCodec;
}

export function createReverseRpcClient(opts: CreateReverseRpcClientOptions): ReverseRpcClient {
  const codec = opts.codec ?? new WireCodec();
  return {
    async sendRequest(method, sessionId, data, options): Promise<WireMessage> {
      const req = createWireRequest({
        method,
        sessionId,
        data,
        from: 'core',
        to: 'client',
      });
      const timeoutMs = options?.timeoutMs;
      return new Promise<WireMessage>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let abortListener: (() => void) | undefined;
        let settled = false;
        const cleanup = (): void => {
          if (timer !== undefined) clearTimeout(timer);
          if (abortListener !== undefined && options?.signal !== undefined) {
            options.signal.removeEventListener('abort', abortListener);
          }
        };
        // Phase 21 §A — wire both resolve and reject into the router so
        // `router.rejectAllPending` / `router.cancelPendingRequest` can
        // tear this entry down on transport close without leaking a stale
        // map entry. The `settled` guard prevents a stray rejection from
        // surfacing after the local promise has already fulfilled.
        opts.router.registerPendingRequest(
          req.id,
          (reply) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(reply);
          },
          (reason) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(reason instanceof Error ? reason : new Error(String(reason)));
          },
        );
        // Local failure paths (timeout / abort / send error) unregister the
        // entry via `cancelPendingRequest` so the router's map stays in
        // lockstep with this promise's lifetime.
        const failLocal = (err: Error): void => {
          if (settled) return;
          settled = true;
          cleanup();
          opts.router.cancelPendingRequest(req.id, err);
          reject(err);
        };
        if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0) {
          timer = setTimeout(() => {
            failLocal(new Error(`reverse RPC ${method} timed out after ${String(timeoutMs)}ms`));
          }, timeoutMs);
        }
        if (options?.signal !== undefined) {
          if (options.signal.aborted) {
            failLocal(new Error(`reverse RPC ${method} aborted`));
            return;
          }
          abortListener = (): void => {
            failLocal(new Error(`reverse RPC ${method} aborted`));
          };
          options.signal.addEventListener('abort', abortListener, { once: true });
        }
        void opts.server.send(codec.encode(req)).catch((error: unknown) => {
          failLocal(error instanceof Error ? error : new Error(String(error)));
        });
      });
    },
  };
}

// ── External tool proxy (`tool.call` reverse-RPC) ─────────────────────

export interface BuildExternalToolProxyOptions {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: unknown;
  /**
   * Client-side dispatcher invoked when the LLM calls this tool. The
   * implementation issues a `tool.call` reverse-RPC and returns the
   * client's response.
   */
  readonly sendToolCall: (
    call: ToolCall,
    signal: AbortSignal,
  ) => Promise<{ output: string; is_error?: boolean }>;
}

/**
 * Build a Soul-visible Tool that, when executed, issues a `tool.call`
 * reverse-RPC frame to the client and awaits the response. Timeout /
 * disconnect translate into an `isError: true` ToolResult so Soul can
 * surface a sensible error without bricking the turn.
 */
export function buildExternalToolProxy(options: BuildExternalToolProxyOptions): Tool {
  // External tools come with JSON-schema-ish input but Soul's `Tool` wants
  // a ZodType. Fall back to `z.unknown()` — input validation is the
  // client's responsibility for external tools.
  const inputSchema = z.unknown();
  const tool: Tool<unknown> = {
    name: options.name,
    description: options.description,
    inputSchema,
    // Phase 21 §A — `'external'` is now a first-class ToolMetadata.source
    // value, so the cast hack is gone. See ToolMetadata in src/soul/types.ts.
    metadata: {
      source: 'external',
      originalName: options.name,
    },
    async execute(toolCallId, args, signal): Promise<ToolResult> {
      try {
        const response = await options.sendToolCall(
          { id: toolCallId, name: options.name, args: (args as Record<string, unknown>) ?? {} },
          signal,
        );
        return {
          content: response.output,
          output: response.output,
          ...(response.is_error === true ? { isError: true } : {}),
        };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : `external tool "${options.name}" failed: unknown error`;
        return {
          content: message,
          output: message,
          isError: true,
        };
      }
    },
  };
  return tool;
}

// ── Wire hook sender (`hook.request` reverse-RPC) ─────────────────────

export interface CreateWireHookSenderOptions {
  readonly reverse: ReverseRpcClient;
  readonly sessionId: string;
  readonly hookTimeoutMs: number;
}

export function createWireHookSender(opts: CreateWireHookSenderOptions): WireHookSender {
  return {
    async send(message) {
      const response = await opts.reverse.sendRequest(
        'hook.request',
        opts.sessionId,
        buildHookRequestData(message.subscriptionId, message.input),
        { timeoutMs: opts.hookTimeoutMs },
      );
      const data = (response.data ?? {}) as {
        ok?: boolean;
        blockAction?: boolean;
        block_action?: boolean;
        reason?: string;
        additional_context?: string;
        additionalContext?: string;
      };
      const blockAction = data.blockAction ?? data.block_action;
      const additionalContext = data.additionalContext ?? data.additional_context;
      return {
        requestId: message.requestId,
        result: {
          ok: data.ok ?? true,
          ...(blockAction !== undefined ? { blockAction } : {}),
          ...(data.reason !== undefined ? { reason: data.reason } : {}),
          ...(additionalContext !== undefined ? { additionalContext } : {}),
        },
      };
    },
  };
}

function buildHookRequestData(
  subscriptionId: string,
  input: HookInput,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    subscription_id: subscriptionId,
    event: input.event,
    session_id: input.sessionId,
    turn_id: input.turnId,
    agent_id: input.agentId,
  };
  if (
    input.event === 'PreToolUse' ||
    input.event === 'PostToolUse' ||
    input.event === 'OnToolFailure'
  ) {
    base['tool_name'] = input.toolCall.name;
    base['tool_call_id'] = input.toolCall.id;
    base['args'] = input.toolCall.args;
  }
  return base;
}
