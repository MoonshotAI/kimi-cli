/**
 * WireMessage factory — convenience builders for request / response / event.
 *
 * Generates UUIDs with appropriate prefixes (req_ / res_ / evt_) and fills
 * the envelope boilerplate (time, from, to, session_id).
 */

import { randomUUID } from 'node:crypto';

import type { WireEvent, WireRequest, WireResponse } from './types.js';

export interface CreateRequestOptions {
  method: string;
  sessionId: string;
  data?: unknown;
  from?: string | undefined;
  to?: string | undefined;
}

export interface CreateResponseOptions {
  /**
   * Phase 17 §A.4 — undefined when the error response is for a frame
   * we could not decode (JSON-RPC parse error / invalid request). The
   * envelope schema rule 2 permits this shape when `error` is set.
   */
  requestId: string | undefined;
  sessionId: string;
  data?: unknown;
  error?: { code: number; message: string; details?: unknown } | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

export interface CreateEventOptions {
  method: string;
  sessionId: string;
  seq: number;
  data?: unknown;
  turnId?: string | undefined;
  agentType?: 'main' | 'sub' | 'independent' | undefined;
  from?: string | undefined;
  to?: string | undefined;
  /**
   * Phase 17 §A.5 — optional correlation to a request id, used by
   * the `session.replay.chunk` / `session.replay.end` streams so
   * clients can key chunks back to the originating replay request.
   * Absent for normal fan-out events (turn.begin etc).
   */
  requestId?: string | undefined;
}

function generateId(prefix: string): string {
  return `${prefix}${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

export function createWireRequest(options: CreateRequestOptions): WireRequest {
  return {
    id: generateId('req_'),
    time: Date.now(),
    session_id: options.sessionId,
    type: 'request',
    from: options.from ?? 'client',
    to: options.to ?? 'core',
    method: options.method,
    ...(options.data !== undefined ? { data: options.data } : {}),
  };
}

export function createWireResponse(options: CreateResponseOptions): WireResponse {
  return {
    id: generateId('res_'),
    time: Date.now(),
    session_id: options.sessionId,
    type: 'response',
    from: options.from ?? 'core',
    to: options.to ?? 'client',
    ...(options.requestId !== undefined && options.requestId !== ''
      ? { request_id: options.requestId }
      : {}),
    ...(options.data !== undefined ? { data: options.data } : {}),
    ...(options.error !== undefined ? { error: options.error } : {}),
  } as WireResponse;
}

export function createWireEvent(options: CreateEventOptions): WireEvent {
  return {
    id: generateId('evt_'),
    time: Date.now(),
    session_id: options.sessionId,
    type: 'event',
    from: options.from ?? 'core',
    to: options.to ?? 'client',
    method: options.method,
    seq: options.seq,
    ...(options.requestId !== undefined && options.requestId !== ''
      ? { request_id: options.requestId }
      : {}),
    ...(options.turnId !== undefined ? { turn_id: options.turnId } : {}),
    ...(options.agentType !== undefined ? { agent_type: options.agentType } : {}),
    ...(options.data !== undefined ? { data: options.data } : {}),
  };
}
