/**
 * Phase 18 wire-protocol extensions — harness-side handler glue.
 *
 * The production `runWire` binary is still a stub (see Slice 18-1
 * PROGRESS.md). Until it lands, the in-memory wire harness is the
 * only place we exercise the Phase 18 Section A wire methods
 * (session.setModel / setPlanMode / setYolo / setThinking /
 * addSystemReminder, dynamic tool management, subscribe/unsubscribe,
 * hook.request / tool.call reverse-RPC) + the -32001/-32002/-32003
 * business error codes.
 *
 * These helpers live in the test harness intentionally — they
 * translate wire envelopes into SoulPlus/SessionControl calls without
 * introducing a new production-side abstraction. Phase 11's real
 * --wire runner can consume the same patterns (Section A handlers +
 * reverse-RPC senders) when it is implemented.
 */

import type { HookEngine } from '../../../src/hooks/engine.js';
import { WireHookExecutor, type WireHookSender } from '../../../src/hooks/wire-executor.js';
import type {
  HookEventType,
  WireHookConfig,
} from '../../../src/hooks/types.js';
import type { ManagedSession } from '../../../src/session/index.js';
import type { SessionEventBus } from '../../../src/soul-plus/session-event-bus.js';
import type { Tool } from '../../../src/soul/types.js';
import {
  WireCodec,
} from '../../../src/wire-protocol/index.js';
import {
  createWireEvent,
} from '../../../src/wire-protocol/message-factory.js';
import type {
  WireEventMethod,
} from '../../../src/wire-protocol/types.js';
import type { MemoryTransport } from '../../../src/transport/memory-transport.js';
import {
  classifyBusinessError as classifyBusinessErrorFromSrc,
} from '../../../src/soul-plus/errors.js';
// Phase 21 §A — reverse-RPC primitives moved to src/wire-protocol/reverse-rpc.ts.
// In-file usage (PerSessionWireState in the event bridge,
// ReverseRpcClient + createWireHookSender in registerWireHooks).
import {
  createWireHookSender,
  type PerSessionWireState,
  type ReverseRpcClient,
} from '../../../src/wire-protocol/reverse-rpc.js';
// Re-export the rest of the surface so harness callers keep importing
// from phase18-extensions without churn.
export {
  buildExternalToolProxy,
  createReverseRpcClient,
  createWireHookSender,
  getOrInitSessionState,
  type ExternalToolState,
  type PerSessionStateMap,
  type PerSessionWireState,
  type ReverseRpcClient,
  type ReverseRpcMethod,
} from '../../../src/wire-protocol/reverse-rpc.js';
// Phase 19 Slice B — capability check moved to src/. Re-export so harness
// callers keep importing it from `phase18-extensions.js` without churn.
// TODO(phase-19-cleanup): inline callers should import directly from
// `@moonshot-ai/core` / the soul-plus barrel and this shim removed.
export {
  checkLLMCapabilities,
  type LLMCapabilityCheckOptions,
} from '../../../src/soul-plus/capability-check.js';

// ── A.1 external_tools conflict detection ───────────────────────────────

export interface ExternalToolsResolution {
  accepted: string[];
  rejected: Array<{ name: string; reason: string }>;
}

/**
 * Canonical TS builtin tool names. Used by `resolveExternalTools` so
 * the conflict check works even when the harness `tools` array is
 * empty (test harnesses rarely wire the full builtin registry). The
 * list mirrors `packages/kimi-core/src/tools/` — keep in sync when
 * adding new builtins.
 */
const BUILTIN_TOOL_NAMES = new Set<string>([
  'Bash',
  'Write',
  'Edit',
  'Read',
  'Glob',
  'Grep',
  'AskUser',
  'FetchUrl',
  'EnterPlanMode',
  'ExitPlanMode',
  'SetTodoList',
  'Agent',
  'Skill',
]);

/**
 * Cross-check a client-supplied `external_tools` list against the
 * builtin registry. Names that match a builtin are rejected with a
 * "conflicts with built-in" reason (Python parity
 * `wire/server.py:407-421`); the rest are accepted.
 */
export function resolveExternalTools(
  externalTools: readonly { name: string; description?: string; parameters?: unknown; input_schema?: unknown }[],
  builtinTools: readonly Tool[],
): {
  resolution: ExternalToolsResolution;
  accepted: Array<{ name: string; description: string; input_schema: unknown }>;
} {
  const builtinNames = new Set<string>([
    ...builtinTools.map((t) => t.name),
    ...BUILTIN_TOOL_NAMES,
  ]);
  const resolution: ExternalToolsResolution = { accepted: [], rejected: [] };
  const accepted: Array<{ name: string; description: string; input_schema: unknown }> = [];
  for (const ext of externalTools) {
    if (builtinNames.has(ext.name)) {
      resolution.rejected.push({
        name: ext.name,
        reason: `conflicts with built-in tool "${ext.name}"`,
      });
      continue;
    }
    resolution.accepted.push(ext.name);
    accepted.push({
      name: ext.name,
      description: ext.description ?? '',
      input_schema: ext.input_schema ?? ext.parameters ?? {},
    });
  }
  return { resolution, accepted };
}

// ── Wire event bridge (adapted from test/e2e/helpers/wire-event-bridge) ─

/**
 * Install an event-to-wire bridge on a single session. Forwards Soul
 * events (via SessionEventBus) and turn-lifecycle events (via
 * TurnLifecycleTracker) as `turn.begin` / `turn.end` / `step.*` /
 * `content.delta` / `tool.call` / `tool.result` / `status.update` /
 * `model.changed` / `thinking.changed` wire events on the server
 * transport. Honors `state.eventFilter` so `session.subscribe` can
 * narrow the fan-out.
 *
 * Returns a disposer that unsubscribes both channels.
 */
export function installHarnessWireEventBridge(opts: {
  readonly server: MemoryTransport;
  readonly managed: ManagedSession;
  readonly eventBus: SessionEventBus;
  readonly state: PerSessionWireState;
}): () => void {
  const codec = new WireCodec();
  let seq = 0;
  let currentTurnId: string | undefined;

  const sendWire = (method: WireEventMethod, data: unknown, turnId?: string): void => {
    const filter = opts.state.eventFilter;
    if (filter !== undefined && !filter.has(method)) return;
    const frame = codec.encode(
      createWireEvent({
        method,
        sessionId: opts.managed.sessionId,
        seq: seq++,
        ...(turnId !== undefined ? { turnId } : {}),
        agentType: 'main',
        data,
      }),
    );
    void opts.server.send(frame).catch(() => {
      /* transport may have closed */
    });
  };

  const soulListener = (rawEvent: unknown): void => {
    const event = rawEvent as { type: string; [key: string]: unknown };
    switch (event.type) {
      case 'step.begin': {
        sendWire('step.begin', { step: event['step'] as number }, currentTurnId);
        return;
      }
      case 'step.end': {
        sendWire('step.end', { step: event['step'] as number }, currentTurnId);
        return;
      }
      case 'step.interrupted': {
        sendWire(
          'step.interrupted',
          { step: event['step'] as number, reason: event['reason'] as string },
          currentTurnId,
        );
        return;
      }
      case 'content.delta': {
        sendWire(
          'content.delta',
          { type: 'text', text: event['delta'] as string },
          currentTurnId,
        );
        return;
      }
      case 'thinking.delta': {
        sendWire(
          'content.delta',
          { type: 'thinking', thinking: event['delta'] as string },
          currentTurnId,
        );
        return;
      }
      case 'tool.call': {
        sendWire(
          'tool.call',
          {
            id: event['toolCallId'] as string,
            name: event['name'] as string,
            args: event['args'] as Record<string, unknown>,
          },
          currentTurnId,
        );
        return;
      }
      case 'tool.progress': {
        sendWire(
          'tool.progress',
          { id: event['toolCallId'] as string, update: event['update'] },
          currentTurnId,
        );
        return;
      }
      case 'tool.result': {
        const isError = event['isError'] as boolean | undefined;
        sendWire(
          'tool.result',
          {
            tool_call_id: event['toolCallId'] as string,
            output: event['output'] as string,
            ...(isError !== undefined ? { is_error: isError } : {}),
          },
          currentTurnId,
        );
        return;
      }
      case 'compaction.begin': {
        sendWire('compaction.begin', {}, currentTurnId);
        return;
      }
      case 'compaction.end': {
        const tokensBefore = event['tokensBefore'] as number | undefined;
        const tokensAfter = event['tokensAfter'] as number | undefined;
        sendWire(
          'compaction.end',
          {
            ...(tokensBefore !== undefined ? { tokens_before: tokensBefore } : {}),
            ...(tokensAfter !== undefined ? { tokens_after: tokensAfter } : {}),
          },
          currentTurnId,
        );
        return;
      }
      case 'status.update': {
        sendWire('status.update', event['data'], currentTurnId);
        return;
      }
      case 'model.changed': {
        const data = event['data'] as { new_model: string };
        sendWire('model.changed', { new_model: data.new_model }, currentTurnId);
        return;
      }
      case 'thinking.changed': {
        sendWire('thinking.changed', { level: event['level'] as string }, currentTurnId);
        return;
      }
      default: {
        // session.error is emitted from TurnManager with `as never`
        // escape — we swallow anything we do not recognise.
      }
    }
  };

  const turnListener = (rawEvent: unknown): void => {
    const event = rawEvent as {
      kind: 'begin' | 'end';
      turnId: string;
      [key: string]: unknown;
    };
    if (event.kind === 'begin') {
      currentTurnId = event.turnId;
      sendWire(
        'turn.begin',
        {
          turn_id: event.turnId,
          user_input:
            (event['userInputParts'] as readonly unknown[] | undefined) ??
            (event['userInput'] as string),
          input_kind: event['inputKind'] as 'user' | 'system_trigger',
        },
        event.turnId,
      );
      return;
    }
    const usage = event['usage'] as
      | { input: number; output: number; cache_read?: number; cache_write?: number }
      | undefined;
    sendWire(
      'turn.end',
      {
        turn_id: event.turnId,
        reason: event['reason'] as 'done' | 'cancelled' | 'error',
        success: event['success'] as boolean,
        ...(usage !== undefined
          ? {
              usage: {
                input_tokens: usage.input,
                output_tokens: usage.output,
                ...(usage.cache_read !== undefined
                  ? { cache_read_tokens: usage.cache_read }
                  : {}),
                ...(usage.cache_write !== undefined
                  ? { cache_write_tokens: usage.cache_write }
                  : {}),
              },
            }
          : {}),
      },
      event.turnId,
    );
    if (currentTurnId === event.turnId) currentTurnId = undefined;
  };

  const unsubTurn = opts.managed.soulPlus
    .getTurnManager()
    .addTurnLifecycleListener(turnListener as never);
  const busListener = (event: unknown): void => {
    soulListener(event as { type: string });
  };
  opts.eventBus.on(busListener as never);

  return (): void => {
    opts.eventBus.off(busListener as never);
    unsubTurn();
  };
}

// ── A.11 / A.12 / A.13 — business error code mapping ────────────────────
//
// The canonical mapper lives in `src/soul-plus/errors.ts`. This thin
// re-export keeps the test-harness call sites stable and normalises the
// `null` return to `undefined` to match the previous harness API.

export function classifyBusinessError(error: unknown): {
  code: number;
  message: string;
} | undefined {
  const mapped = classifyBusinessErrorFromSrc(error);
  return mapped === null ? undefined : mapped;
}

// ── Helper: wire a WireHookExecutor into a HookEngine per initialize.hooks ──

export function registerWireHooks(opts: {
  readonly hookEngine: HookEngine;
  readonly hooks: ReadonlyArray<{ event: string; matcher?: unknown; id?: string }>;
  readonly reverse: ReverseRpcClient;
  readonly sessionIdResolver: () => string;
  readonly hookTimeoutMs?: number;
}): void {
  // One executor per engine is enough; subscription ids differentiate
  // configs at send-time.
  const sender: WireHookSender = {
    async send(message) {
      const sessionId = opts.sessionIdResolver();
      const inner = createWireHookSender({
        reverse: opts.reverse,
        sessionId,
        hookTimeoutMs: opts.hookTimeoutMs ?? 30_000,
      });
      return inner.send(message);
    },
  };
  const executor = new WireHookExecutor(sender);
  // L2-4 — use the public `registerExecutor` API instead of poking at
  // the engine's internal deps.
  opts.hookEngine.registerExecutor('wire', executor);

  for (const entry of opts.hooks) {
    const cfg: WireHookConfig = {
      type: 'wire',
      event: entry.event as HookEventType,
      ...(typeof entry.matcher === 'string' ? { matcher: entry.matcher } : {}),
      subscriptionId: entry.id ?? `hk_${entry.event}_${Math.random().toString(36).slice(2, 8)}`,
    };
    opts.hookEngine.register(cfg);
  }
}
