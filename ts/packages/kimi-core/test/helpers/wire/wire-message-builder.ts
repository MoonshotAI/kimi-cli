/**
 * Wire message construction helpers — Phase 9 §4.
 *
 * Thin convenience layer on top of `createWireRequest/Response/Event`.
 * Mirrors Python `tests_e2e/wire_helpers.py:342-373` (reverse-RPC
 * responses) plus builders for the common outbound request shapes.
 */

import {
  createWireRequest,
  createWireResponse,
} from '../../../src/wire-protocol/message-factory.js';
import {
  PROCESS_SESSION_ID,
  WIRE_PROTOCOL_VERSION,
  type InitializeRequestData,
  type SessionCancelRequestData,
  type SessionCreateRequestData,
  type SessionPromptRequestData,
  type SessionSteerRequestData,
  type WireMessage,
} from '../../../src/wire-protocol/types.js';
import type { LLMToolDefinition } from '../../../src/soul/runtime.js';

type ToolDef = LLMToolDefinition;

export interface BuildInitializeOptions {
  readonly protocolVersion?: string;
  readonly externalTools?: readonly ToolDef[];
  readonly capabilities?: InitializeRequestData['capabilities'];
  readonly sessionId?: string;
}

export function buildInitializeRequest(opts?: BuildInitializeOptions): WireMessage {
  const data: InitializeRequestData = {
    protocol_version: opts?.protocolVersion ?? WIRE_PROTOCOL_VERSION,
    ...(opts?.capabilities !== undefined ? { capabilities: opts.capabilities } : {}),
    ...(opts?.externalTools !== undefined
      ? { client_capabilities: { external_tools: opts.externalTools } }
      : {}),
  };
  return createWireRequest({
    method: 'initialize',
    sessionId: opts?.sessionId ?? PROCESS_SESSION_ID,
    data,
  });
}

export interface BuildPromptOptions {
  readonly sessionId: string;
  readonly text: string;
  readonly inputKind?: 'user' | 'system_trigger';
  readonly triggerSource?: string;
}

export function buildPromptRequest(opts: BuildPromptOptions): WireMessage {
  const data: SessionPromptRequestData = {
    input: opts.text,
    ...(opts.inputKind !== undefined ? { input_kind: opts.inputKind } : {}),
    ...(opts.triggerSource !== undefined ? { trigger_source: opts.triggerSource } : {}),
  };
  return createWireRequest({
    method: 'session.prompt',
    sessionId: opts.sessionId,
    data,
  });
}

export function buildSteerRequest(sessionId: string, text: string): WireMessage {
  const data: SessionSteerRequestData = { input: text };
  return createWireRequest({
    method: 'session.steer',
    sessionId,
    data,
  });
}

export function buildCancelRequest(sessionId: string, turnId?: string): WireMessage {
  const data: SessionCancelRequestData = turnId !== undefined ? { turn_id: turnId } : {};
  return createWireRequest({
    method: 'session.cancel',
    sessionId,
    data,
  });
}

export interface BuildSessionCreateOptions {
  readonly sessionId?: string;
  readonly model?: string;
  readonly systemPrompt?: string;
}

export function buildSessionCreateRequest(
  opts?: BuildSessionCreateOptions,
): WireMessage {
  const data: SessionCreateRequestData = {
    ...(opts?.sessionId !== undefined ? { session_id: opts.sessionId } : {}),
    ...(opts?.model !== undefined ? { model: opts.model } : {}),
    ...(opts?.systemPrompt !== undefined ? { system_prompt: opts.systemPrompt } : {}),
  };
  return createWireRequest({
    method: 'session.create',
    sessionId: PROCESS_SESSION_ID,
    data,
  });
}

// ── Reverse-RPC responses ──────────────────────────────────────────────

export type ApprovalWireResponse = 'approved' | 'rejected' | 'cancelled';

export function buildApprovalResponse(
  request: WireMessage,
  response: ApprovalWireResponse,
  feedback?: string,
): WireMessage {
  if (request.type !== 'request') {
    throw new Error('buildApprovalResponse: input must be a request message');
  }
  return createWireResponse({
    requestId: request.id,
    sessionId: request.session_id,
    data: {
      response,
      ...(feedback !== undefined ? { feedback } : {}),
    },
  });
}

export function buildQuestionResponse(
  request: WireMessage,
  answers: Record<string, string>,
): WireMessage {
  if (request.type !== 'request') {
    throw new Error('buildQuestionResponse: input must be a request message');
  }
  return createWireResponse({
    requestId: request.id,
    sessionId: request.session_id,
    data: { answer: JSON.stringify({ answers }) },
  });
}

export interface BuildToolResultOptions {
  readonly output: string;
  readonly isError?: boolean;
}

export function buildToolResultResponse(
  request: WireMessage,
  opts: BuildToolResultOptions,
): WireMessage {
  if (request.type !== 'request') {
    throw new Error('buildToolResultResponse: input must be a request message');
  }
  return createWireResponse({
    requestId: request.id,
    sessionId: request.session_id,
    data: {
      output: opts.output,
      ...(opts.isError !== undefined ? { is_error: opts.isError } : {}),
    },
  });
}

export function buildErrorResponse(
  request: WireMessage,
  error: { code: number; message: string; details?: unknown },
): WireMessage {
  if (request.type !== 'request') {
    throw new Error('buildErrorResponse: input must be a request message');
  }
  return createWireResponse({
    requestId: request.id,
    sessionId: request.session_id,
    error,
  });
}

// ── ScriptedTurn tool-call helpers (Phase 12) ──────────────────────────
//
// Phase 12 wire E2E tests feed `FakeKosongAdapter.script({toolCalls: [...]})`
// to drive a tool-use turn. The helpers below are thin constructors that
// mint a `ScriptedToolCall`-shaped object for each builtin tool's TS
// argument schema so test bodies stay readable. Names match the TS tool
// registry (`src/tools/index.ts`): Bash / Write / Edit / SetTodoList /
// Agent. Python's `Shell` / `WriteFile` / `StrReplaceFile` names are
// **not** re-used here — v2 tool registry is the source of truth.

/** Shape of a scripted tool-call entry — mirrors FakeKosongAdapter's
 *  `ScriptedToolCall`. We redefine it structurally so callers don't have
 *  to pull in the Fake adapter types for one helper. */
export interface ScriptedToolCallBuilder {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export function buildShellToolCall(
  id: string,
  command: string,
  extras?: { description?: string; timeoutMs?: number },
): ScriptedToolCallBuilder {
  return {
    id,
    name: 'Bash',
    arguments: {
      command,
      ...(extras?.description !== undefined ? { description: extras.description } : {}),
      ...(extras?.timeoutMs !== undefined ? { timeout_ms: extras.timeoutMs } : {}),
    },
  };
}

export function buildWriteFileCall(
  id: string,
  path: string,
  content: string,
): ScriptedToolCallBuilder {
  // TS WriteTool uses `path` (see src/tools/types.ts:WriteInput); Python
  // used `file_path`. Schema rename — v2 registry is source of truth.
  return {
    id,
    name: 'Write',
    arguments: { path, content },
  };
}

export function buildStrReplaceFileCall(
  id: string,
  path: string,
  oldText: string,
  newText: string,
): ScriptedToolCallBuilder {
  // TS Edit tool is the rename of Python `StrReplaceFile`. v2 uses
  // `path` + `old_string` + `new_string` (see src/tools/types.ts:EditInput).
  return {
    id,
    name: 'Edit',
    arguments: { path, old_string: oldText, new_string: newText },
  };
}

export function buildSetTodoCall(
  id: string,
  items: ReadonlyArray<{ id?: string; content: string; status?: string }>,
): ScriptedToolCallBuilder {
  return {
    id,
    name: 'SetTodoList',
    arguments: {
      items: items.map((it, idx) => ({
        id: it.id ?? `t${idx + 1}`,
        content: it.content,
        status: it.status ?? 'pending',
      })),
    },
  };
}

export function buildAgentToolCall(
  id: string,
  opts: {
    prompt: string;
    description: string;
    agentName?: string;
    runInBackground?: boolean;
    model?: string;
  },
): ScriptedToolCallBuilder {
  return {
    id,
    name: 'Agent',
    arguments: {
      prompt: opts.prompt,
      description: opts.description,
      ...(opts.agentName !== undefined ? { agentName: opts.agentName } : {}),
      ...(opts.runInBackground !== undefined ? { runInBackground: opts.runInBackground } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
    },
  };
}

// ── Hook subscription builders (Phase 12.4) ────────────────────────────
//
// `initialize.params.hooks` is a structured list (v2 §3.5). Each entry
// describes a wire-channel hook the client wants the core to fire when
// the named event triggers. `matcher` is optional regex-like string
// (core matches against the tool/prompt body per event semantics).
//
// NOTE (lift-time src gap): `InitializeRequestData.hooks` in
// `src/wire-protocol/types.ts` currently has element shape
// `{event, matcher?}` without an `id` field, while v2 §3.5 prescribes
// `{id, event, matcher?}`. When Phase 12.4 tests are lifted, the src
// schema must be widened to accept `id` and key `configured` counts by
// it. Tracked as **R12.4-hook-wire-bridge** in migration-report §12.4.

export interface HookSubscription {
  readonly id: string;
  readonly event: string;
  readonly matcher?: string;
}

// Monotonic counter for deterministic default ids — avoids Math.random
// flake if a future lift asserts on subscription id equality. Tests that
// need explicit ids should pass `id` directly.
let hookSubCounter = 0;

export function buildHookSubscription(
  event: string,
  id?: string,
  matcher?: string,
): HookSubscription {
  return {
    id: id ?? `hk_${event}_${++hookSubCounter}`,
    event,
    ...(matcher !== undefined ? { matcher } : {}),
  };
}
