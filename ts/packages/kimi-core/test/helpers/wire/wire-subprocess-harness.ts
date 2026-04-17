/**
 * Subprocess wire harness — Phase 9 §4.
 *
 * Boots the `kimi --wire` binary over stdio and wraps it with the
 * shared `WireE2EHarness` interface.
 *
 * TODO(Phase 11): the CLI's `--wire` runner is currently stubbed to
 * `process.stdout.write('Wire mode: not yet implemented (Phase 11)')`
 * — see `apps/kimi-cli/src/index.ts:592-594`. Until that lands, the
 * subprocess path is unusable and the self-test is `skip-if-no-bin`.
 *
 * The implementation below does the full pipework (spawn + JSON-line
 * framing + queue plumbing) so Phase 11 only has to wire the real bin
 * entry. Callers check `harness.isStub` before assuming the transport
 * works.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { WireCodec } from '../../../src/wire-protocol/codec.js';
import { createWireRequest } from '../../../src/wire-protocol/message-factory.js';
import type { WireMessage } from '../../../src/wire-protocol/types.js';
import {
  WireFrameQueue,
  type WireCollectUntilRequestOptions,
  type WireCollectUntilResponseOptions,
  type WireE2EHarness,
} from './wire-e2e-harness.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_EXIT_GRACE_MS = 2_000;

export interface WireSubprocessHarness extends WireE2EHarness {
  readonly pid: number;
  readonly isStub: boolean;
  readonly process: ChildProcessByStdio<Writable, Readable, Readable>;
  waitExit(timeoutMs?: number): Promise<number>;
}

export interface StartWireSubprocessOptions {
  readonly binPath?: string;
  readonly extraArgs?: readonly string[];
  readonly yolo?: boolean;
  readonly configPath?: string;
  readonly configText?: string;
  readonly mcpConfigPath?: string;
  readonly skillsDirs?: readonly string[];
  readonly agentFile?: string;
  readonly workDir: string;
  readonly homeDir: string;
  readonly env?: Record<string, string>;
  readonly defaultTimeoutMs?: number;
  readonly exitGraceMs?: number;
}

function resolveBinPath(override?: string): string | undefined {
  const envPath = process.env['KIMI_E2E_WIRE_CMD'];
  const candidates = [override, envPath].filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Fallback: packages/kimi-cli/dist/cli.js — tolerate absence so tests
  // can `skip-if-no-bin` at the call site.
  const defaults = [
    join(process.cwd(), 'apps', 'kimi-cli', 'dist', 'index.mjs'),
    join(process.cwd(), 'apps', 'kimi-cli', 'dist', 'cli.js'),
  ];
  for (const c of defaults) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

/**
 * Returns whether the `kimi --wire` subprocess harness can run right
 * now. Useful for `test.skipIf(!canStartWireSubprocess())` gates.
 */
export function canStartWireSubprocess(binPath?: string): boolean {
  // Phase 11 blocker: the CLI `--wire` runner is stubbed. Even if the
  // bin exists, the subprocess won't speak the wire protocol yet.
  void binPath;
  return false;
}

export async function startWireSubprocess(
  opts: StartWireSubprocessOptions,
): Promise<WireSubprocessHarness> {
  const binPath = resolveBinPath(opts.binPath);
  if (binPath === undefined) {
    throw new Error(
      'startWireSubprocess: no kimi CLI binary found. Set KIMI_E2E_WIRE_CMD ' +
        'or build apps/kimi-cli (pnpm -C apps/kimi-cli build).',
    );
  }

  // Phase 9 guard — the `--wire` runner is a stub in apps/kimi-cli. We
  // still construct the process so the harness shape stays identical,
  // but flag it via `isStub: true` so self-tests know to skip.
  const argv = [
    binPath,
    '--wire',
    ...(opts.yolo === true ? ['--yolo'] : []),
    ...(opts.configPath !== undefined ? ['--config', opts.configPath] : []),
    ...(opts.mcpConfigPath !== undefined ? ['--mcp-config', opts.mcpConfigPath] : []),
    ...(opts.agentFile !== undefined ? ['--agent', opts.agentFile] : []),
    ...(opts.extraArgs ?? []),
  ];

  const child = spawn(process.execPath, argv, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: opts.workDir,
    env: {
      ...process.env,
      KIMI_HOME: opts.homeDir,
      ...opts.env,
    },
  }) as ChildProcessByStdio<Writable, Readable, Readable>;

  const codec = new WireCodec();
  const queue = new WireFrameQueue();

  const reader = createInterface({ input: child.stdout });
  reader.on('line', (line) => {
    try {
      const msg = codec.decode(line);
      queue.push(msg);
    } catch {
      /* swallow — stub / startup chatter is not a wire frame */
    }
  });

  let disposed = false;
  let exitCode: number | null = null;
  const exitPromise = new Promise<number>((resolve) => {
    child.on('exit', (code) => {
      exitCode = code ?? 0;
      resolve(exitCode);
    });
  });

  async function send(msg: WireMessage): Promise<void> {
    if (disposed) throw new Error('subprocess harness disposed');
    const frame = codec.encode(msg) + '\n';
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(frame, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  const defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function doRequest(
    method: string,
    params: unknown,
    o?: { sessionId?: string; timeoutMs?: number },
  ): Promise<WireMessage> {
    const sessionId = o?.sessionId ?? '__process__';
    const req = createWireRequest({ method, sessionId, data: params });
    const waitPromise = queue.waitFor(
      (m) => m.type === 'response' && m.request_id === req.id,
      o?.timeoutMs ?? defaultTimeoutMs,
      `request '${method}' (id=${req.id}, pid=${child.pid ?? -1})`,
    );
    await send(req);
    return waitPromise;
  }

  async function expectEvent(
    method: string,
    o?: { timeoutMs?: number; matcher?: (msg: WireMessage) => boolean },
  ): Promise<WireMessage> {
    const timeoutMs = o?.timeoutMs ?? defaultTimeoutMs;
    return queue.waitFor(
      (m) => {
        if (m.type !== 'event') return false;
        if (m.method !== method) return false;
        if (o?.matcher !== undefined && !o.matcher(m)) return false;
        return true;
      },
      timeoutMs,
      `event '${method}' (pid=${child.pid ?? -1})`,
    );
  }

  async function collectUntilResponse(
    requestId: string,
    o?: WireCollectUntilResponseOptions,
  ): Promise<{ response: WireMessage; events: readonly WireMessage[] }> {
    const timeoutMs = o?.timeoutMs ?? defaultTimeoutMs;
    const startAt = queue.snapshot.length;
    const processed = new Set<string>();
    let unsubscribe: (() => void) | undefined;
    if (o?.requestHandler !== undefined) {
      const handler = o.requestHandler;
      unsubscribe = queue.subscribe((m) => {
        if (m.type !== 'request') return;
        if (processed.has(m.id)) return;
        processed.add(m.id);
        void (async (): Promise<void> => {
          try {
            const reply = await handler(m);
            await send(reply);
          } catch {
            /* swallow */
          }
        })();
      });
    }
    try {
      const response = await queue.waitFor(
        (m) => m.type === 'response' && m.request_id === requestId,
        timeoutMs,
        `collectUntilResponse(request_id=${requestId}, pid=${child.pid ?? -1})`,
      );
      // Python parity: terminating response is returned separately;
      // `events` is only `event` + reverse-RPC `request`.
      const events = queue.snapshot
        .slice(startAt)
        .filter((m) => m.type === 'event' || m.type === 'request');
      return { response, events };
    } finally {
      unsubscribe?.();
    }
  }

  async function collectUntilRequest(
    o?: WireCollectUntilRequestOptions,
  ): Promise<{ request: WireMessage; events: readonly WireMessage[] }> {
    const timeoutMs = o?.timeoutMs ?? defaultTimeoutMs;
    const startAt = queue.snapshot.length;
    const request = await queue.waitFor(
      (m) => m.type === 'request' && queue.snapshot.indexOf(m) >= startAt,
      timeoutMs,
      `collectUntilRequest (pid=${child.pid ?? -1})`,
    );
    const events = queue.snapshot
      .slice(startAt)
      .filter((m) => m.type === 'event');
    return { request, events };
  }

  async function waitExit(timeoutMs?: number): Promise<number> {
    if (exitCode !== null) return exitCode;
    const ms = timeoutMs ?? opts.exitGraceMs ?? DEFAULT_EXIT_GRACE_MS;
    return Promise.race([
      exitPromise,
      new Promise<number>((_, reject) =>
        setTimeout(
          () =>{ 
            reject(
              new Error(
                `waitExit: process (pid=${child.pid ?? -1}) did not exit in ${ms}ms`,
              ),
            ); },
          ms,
        ),
      ),
    ]);
  }

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    queue.dispose();
    if (exitCode === null) {
      child.stdin.end();
      child.kill('SIGTERM');
      const grace = opts.exitGraceMs ?? DEFAULT_EXIT_GRACE_MS;
      try {
        await Promise.race([
          exitPromise,
          new Promise<number>((_, reject) =>
            setTimeout(() =>{  reject(new Error('SIGTERM timeout')); }, grace),
          ),
        ]);
      } catch {
        child.kill('SIGKILL');
        await exitPromise.catch(() => {});
      }
    }
    reader.close();
  };

  return {
    get received(): readonly WireMessage[] {
      return queue.snapshot;
    },
    send,
    request: doRequest,
    expectEvent,
    collectUntilResponse,
    collectUntilRequest,
    dispose,
    [Symbol.asyncDispose]: dispose,
    pid: child.pid ?? -1,
    isStub: true, // Phase 9: flip to false when `--wire` runner ships.
    process: child,
    waitExit,
  };
}
