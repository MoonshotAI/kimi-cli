import type { WireEvent } from './events.js';

export const WIRE_PROTOCOL_VERSION: string = '2.1';

export interface WireMessageEnvelope {
  id: string;
  time: number;
  sessionId: string;
  type: 'request' | 'response' | 'event';
  from: string;
  to: string;
  method?: string;
  requestId?: string;
  data?: unknown;
  error?: { code: number; message: string; details?: unknown };
  turnId?: number;
  agentType?: 'main' | 'sub' | 'independent';
  seq?: number;
}

let seqCounter = 0;

export function createEventEnvelope(
  sessionId: string,
  event: WireEvent,
  turnId?: number,
): WireMessageEnvelope {
  const envelope: WireMessageEnvelope = {
    id: `evt_${(++seqCounter).toString(36)}`,
    time: Date.now(),
    sessionId,
    type: 'event',
    from: 'core',
    to: 'client',
    method: event.type,
    data: event,
    seq: seqCounter,
  };
  if (turnId !== undefined) {
    envelope.turnId = turnId;
  }
  return envelope;
}
