/**
 * StdioTransport — stdin/stdout NDJSON transport (§9-D.2).
 *
 * Used for CLI subprocess communication. Reads newline-delimited JSON from
 * stdin, writes to stdout. Line buffer handles partial chunks.
 *
 * UTF-8 framing (S5-M-3): uses `StringDecoder('utf8')` so multi-byte characters
 * (Chinese, emoji, etc.) split across chunk boundaries are reassembled instead
 * of producing replacement characters mid-frame.
 */

import { StringDecoder } from 'node:string_decoder';

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
  private _decoder: StringDecoder | null = null;
  private _onData: ((chunk: Buffer | string) => void) | null = null;
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

    const decoder = new StringDecoder('utf8');
    this._decoder = decoder;

    this._onData = (chunk: Buffer | string) => {
      // Normalize to Buffer so StringDecoder can hold partial multi-byte
      // sequences across chunk boundaries. PassThrough in object/string mode
      // may hand us a string — in that case just append (already decoded).
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      this._lineBuffer += text;
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
      // Flush any trailing bytes held in the decoder so orphan multi-byte
      // sequences aren't silently dropped. Only complete `\n`-terminated
      // lines emit as messages; any residual partial line still stays in
      // `_lineBuffer` (NDJSON requires trailing newline).
      const tail = this._decoder?.end() ?? '';
      if (tail.length > 0) {
        this._lineBuffer += tail;
      }
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
    // Flush any residual decoder bytes (drops partial trailing sequences).
    this._decoder?.end();
    this._decoder = null;
    this._state = 'closed';
    this.onClose?.();
  }
}
