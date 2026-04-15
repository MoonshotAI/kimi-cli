/**
 * StdioTransport — stdin/stdout NDJSON transport (§9-D.2).
 *
 * Used for CLI subprocess communication. Reads newline-delimited JSON from
 * stdin, writes to stdout. Line buffer handles partial chunks.
 */

import type { Transport, TransportState } from './types.js';

export interface StdioTransportOptions {
  readonly stdin?: NodeJS.ReadableStream | undefined;
  readonly stdout?: NodeJS.WritableStream | undefined;
}

export class StdioTransport implements Transport {
  private _state: TransportState = 'idle';

  get state(): TransportState {
    return this._state;
  }

  onMessage: ((frame: string) => void) | null = null;
  onConnect: (() => void) | null = null;
  onClose: ((code?: number) => void) | null = null;
  onError: ((error: Error) => void) | null = null;

  private readonly _stdin: NodeJS.ReadableStream;
  private readonly _stdout: NodeJS.WritableStream;
  private _lineBuffer = '';
  private _onData: ((chunk: Buffer) => void) | null = null;
  private _onEnd: (() => void) | null = null;

  constructor(options?: StdioTransportOptions) {
    this._stdin = options?.stdin ?? process.stdin;
    this._stdout = options?.stdout ?? process.stdout;
  }

  async connect(): Promise<void> {
    if (this._state !== 'idle') {
      if (this._state === 'connected') {
        return;
      }
      throw new Error(`StdioTransport: cannot connect in state '${this._state}'`);
    }
    this._state = 'connected';

    this._onData = (chunk: Buffer) => {
      this._lineBuffer += chunk.toString('utf-8');
      const lines = this._lineBuffer.split('\n');
      // Last element is the incomplete line (or empty string if ended with \n)
      this._lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.length > 0) {
          this.onMessage?.(line);
        }
      }
    };

    this._onEnd = () => {
      this._state = 'closed';
      this.onClose?.();
    };

    this._stdin.on('data', this._onData);
    this._stdin.on('end', this._onEnd);

    this.onConnect?.();
  }

  async send(frame: string): Promise<void> {
    if (this._state !== 'connected') {
      throw new Error(`StdioTransport: cannot send in state '${this._state}'`);
    }
    this._stdout.write(`${frame}\n`);
  }

  async close(): Promise<void> {
    if (this._state === 'closed') {
      return;
    }
    if (this._onData) {
      this._stdin.removeListener('data', this._onData);
    }
    if (this._onEnd) {
      this._stdin.removeListener('end', this._onEnd);
    }
    this._state = 'closed';
    this.onClose?.();
  }
}
