/**
 * Wire protocol errors (Slice 5 scope).
 *
 * Custom error classes used by WireCodec/Schema validation so that transport
 * and router layers can distinguish malformed envelopes from JSON parse errors
 * or unknown-method routing errors.
 */

export class InvalidWireEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWireEnvelopeError';
  }
}

export class MalformedWireFrameError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MalformedWireFrameError';
  }
}
