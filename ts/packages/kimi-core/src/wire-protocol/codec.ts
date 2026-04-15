/**
 * WireCodec — serialization/deserialization layer (§9-D.3).
 *
 * Sits between Transport (string frames) and Router (typed WireMessage).
 * Responsibilities:
 *   - `encode(msg: WireMessage): string`  — JSON.stringify (no trailing newline)
 *   - `decode(frame: string): WireMessage` — JSON.parse + zod validation
 */

import { InvalidWireEnvelopeError, MalformedWireFrameError } from './errors.js';
import type { WireMessage } from './types.js';
import { WireMessageSchema } from './types.js';

export class WireCodec {
  encode(msg: WireMessage): string {
    return JSON.stringify(msg);
  }

  decode(frame: string): WireMessage {
    let raw: unknown;
    try {
      raw = JSON.parse(frame);
    } catch (error) {
      throw new MalformedWireFrameError(
        `WireCodec.decode: malformed JSON — ${(error as Error).message}`,
        { cause: error },
      );
    }
    const result = WireMessageSchema.safeParse(raw);
    if (!result.success) {
      throw new InvalidWireEnvelopeError(
        `WireCodec.decode: invalid envelope — ${result.error.message}`,
      );
    }
    return result.data;
  }
}
