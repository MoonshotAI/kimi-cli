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
