/**
 * Transport layer errors (Slice 5 scope).
 */

export class TransportClosedError extends Error {
  constructor(message?: string) {
    super(message ?? 'Transport is closed');
    this.name = 'TransportClosedError';
  }
}

export class TransportNotConnectedError extends Error {
  constructor(message?: string) {
    super(message ?? 'Transport is not connected');
    this.name = 'TransportNotConnectedError';
  }
}
