import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';

import { describe, expect, test } from 'vitest';

import { SSHProcess } from '../src/ssh.js';

/**
 * Build a minimal fake ssh2 ClientChannel that satisfies SSHProcess's needs:
 *
 * - behaves as a Readable (for stdout) via PassThrough
 * - exposes .stderr as a Readable via a second PassThrough
 * - records .signal() and .close() calls
 * - emits 'close' / 'exit' on-demand
 */
function createFakeChannel(): {
  channel: unknown;
  signalCalls: string[];
  closeCalls: number;
  emitClose: () => void;
  emitExit: (code: number) => void;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const signalCalls: string[] = [];
  let closeCalls = 0;

  // Listeners registered via channel.on(...)
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  const channel = Object.assign(stdout, {
    stderr,
    signal(name: string): void {
      signalCalls.push(name);
    },
    close(): void {
      closeCalls++;
    },
    // Override .on to capture lifecycle listeners ('close', 'exit') while
    // still letting the underlying Readable receive 'data'/'end'/'error'.
    on(event: string, cb: (...args: unknown[]) => void): unknown {
      if (event === 'close' || event === 'exit') {
        let arr = listeners.get(event);
        if (!arr) {
          arr = [];
          listeners.set(event, arr);
        }
        arr.push(cb);
        return channel;
      }
      return PassThrough.prototype.on.call(stdout, event, cb);
    },
  });

  function emit(event: string, ...args: unknown[]): void {
    const arr = listeners.get(event);
    if (!arr) return;
    for (const cb of arr) {
      cb(...args);
    }
  }

  return {
    channel,
    signalCalls,
    get closeCalls() {
      return closeCalls;
    },
    emitClose: () => emit('close'),
    emitExit: (code: number) => emit('exit', code),
  };
}

function createChildBackedChannel(): { channel: unknown } {
  const child = spawn(process.execPath, [
    '-e',
    [
      "process.on('SIGTERM', () => {",
      "  console.log('cleanup done');",
      '  process.exit(42);',
      '});',
      "console.log('ready');",
      'setInterval(() => {}, 1000);',
    ].join('\n'),
  ]);

  const stdout = new PassThrough();
  child.stdout.pipe(stdout);

  const channel = Object.assign(stdout, {
    stderr: child.stderr,
    signal(name: string): void {
      child.kill(`SIG${name}` as NodeJS.Signals);
    },
    close(): void {
      child.kill('SIGTERM');
    },
    on(event: string, listener: (...args: unknown[]) => void): unknown {
      if (event === 'exit' || event === 'close') {
        child.on(event, listener as (...args: [number | null]) => void);
        return channel;
      }
      return PassThrough.prototype.on.call(stdout, event, listener);
    },
  });

  return { channel };
}

describe('SSHProcess.kill()', () => {
  test('kill("SIGTERM") sends "TERM" to channel.signal (strips SIG prefix)', async () => {
    const fake = createFakeChannel();
    const proc = new SSHProcess(fake.channel as never);

    await proc.kill('SIGTERM');

    expect(fake.signalCalls).toEqual(['TERM']);
    expect(fake.closeCalls).toBe(0);
  });

  test('kill("SIGINT") sends "INT"', async () => {
    const fake = createFakeChannel();
    const proc = new SSHProcess(fake.channel as never);

    await proc.kill('SIGINT');

    expect(fake.signalCalls).toEqual(['INT']);
  });

  test('kill("SIGKILL") sends "KILL"', async () => {
    const fake = createFakeChannel();
    const proc = new SSHProcess(fake.channel as never);

    await proc.kill('SIGKILL');

    expect(fake.signalCalls).toEqual(['KILL']);
  });

  test('kill() with no signal defaults to "TERM"', async () => {
    const fake = createFakeChannel();
    const proc = new SSHProcess(fake.channel as never);

    await proc.kill();

    expect(fake.signalCalls).toEqual(['TERM']);
  });

  test('kill() with a signal that does not start with "SIG" is passed through unchanged', async () => {
    const fake = createFakeChannel();
    const proc = new SSHProcess(fake.channel as never);

    // Cast through unknown because NodeJS.Signals is a string-literal type.
    await proc.kill('USR1' as unknown as NodeJS.Signals);

    expect(fake.signalCalls).toEqual(['USR1']);
  });

  test('wait() resolves with the exit code emitted before close', async () => {
    const fake = createFakeChannel();
    const proc = new SSHProcess(fake.channel as never);

    // Fire exit first, then close.
    fake.emitExit(42);
    fake.emitClose();

    const code = await proc.wait();
    expect(code).toBe(42);
    expect(proc.exitCode).toBe(42);
  });

  test('wait() resolves with 1 (abnormal) when close arrives without exit', async () => {
    const fake = createFakeChannel();
    const proc = new SSHProcess(fake.channel as never);

    fake.emitClose();

    const code = await proc.wait();
    expect(code).toBe(1);
    expect(proc.exitCode).toBe(1);
  });

  test('kill(SIGTERM) preserves cleanup output and the real exit status', async () => {
    const { channel } = createChildBackedChannel();
    const proc = new SSHProcess(channel as never);
    const stdoutChunks: Buffer[] = [];

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(Buffer.from(chunk));
    });
    const stdoutEnded = new Promise<void>((resolve) => {
      proc.stdout.on('end', () => {
        resolve();
      });
    });

    const firstChunk = await new Promise<Buffer>((resolve) => {
      proc.stdout.once('data', (chunk: Buffer) => {
        resolve(chunk);
      });
    });
    expect(firstChunk.toString()).toContain('ready');

    await proc.kill('SIGTERM');

    const exitCode = await proc.wait();
    await Promise.race([
      stdoutEnded,
      new Promise<void>((resolve) => {
        setTimeout(resolve, 250);
      }),
    ]);
    const stdout = Buffer.concat(stdoutChunks).toString('utf-8');

    expect(exitCode).toBe(42);
    expect(proc.exitCode).toBe(42);
    expect(stdout).toContain('ready');
    expect(stdout).toContain('cleanup done');
  }, 10000);
});
