/**
 * CoreDataSource — implements the DataSource interface using a real
 * SoulPlus engine instead of mock data.
 *
 * Bridges the gap between the CLI's WireClientImpl (which consumes
 * DataSource) and kimi-core's SoulPlus (which uses dispatch +
 * SessionEventBus). The TUI layer is completely unaware of this swap.
 *
 * Event mapping: SoulEvent → WireMessage
 *   SoulPlus emits SoulEvents via SessionEventBus.
 *   CoreDataSource listens and converts them to WireMessages that
 *   the CLI's useWire hook already knows how to consume.
 *
 * Missing events manually emitted:
 *   - turn.begin: emitted when startTurn() is called
 *   - turn.end:   emitted when the SoulPlus dispatch promise settles
 *   - tool.result: SoulEvent doesn't have this; we track tool.call
 *     events and emit a synthetic tool.result when the next step ends
 */

import type { SoulEvent } from '@moonshot-ai/core';
import type { SessionEventBus } from '../../../../packages/kimi-core/src/soul-plus/session-event-bus.js';

import type { WireMessage } from '../wire/wire-message.js';
import { createEvent } from '../wire/wire-message.js';
import type { DataSource, SessionStore } from '../wire/client.js';
import type { SessionInfo } from '../wire/methods.js';
import type { Engine } from './create-engine.js';

// ── Pushable async iterable ──────────────────────────────────────────

interface PushableStream {
  push(msg: WireMessage): void;
  end(): void;
  iterable: AsyncIterable<WireMessage>;
}

function createPushableStream(): PushableStream {
  const buffer: WireMessage[] = [];
  let resolve: (() => void) | null = null;
  let done = false;

  return {
    push(msg) {
      buffer.push(msg);
      if (resolve) { const r = resolve; resolve = null; r(); }
    },
    end() {
      done = true;
      if (resolve) { const r = resolve; resolve = null; r(); }
    },
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<WireMessage> {
        return {
          async next(): Promise<IteratorResult<WireMessage>> {
            while (buffer.length === 0 && !done) {
              await new Promise<void>((r) => { resolve = r; });
            }
            if (buffer.length > 0) {
              return { done: false, value: buffer.shift()! };
            }
            return { done: true, value: undefined as unknown as WireMessage };
          },
        };
      },
    },
  };
}

// ── In-memory session store for CoreDataSource ──────────────────────

class CoreSessionStore implements SessionStore {
  private sessions = new Map<string, { id: string; workDir: string; title: string | null; createdAt: number; updatedAt: number }>();
  private counter = 0;

  create(workDir: string): string {
    const id = `session-${(++this.counter).toString().padStart(4, '0')}`;
    const now = Date.now();
    this.sessions.set(id, { id, workDir, title: null, createdAt: now, updatedAt: now });
    return id;
  }

  list(workDir: string): SessionInfo[] {
    return [...this.sessions.values()]
      .filter((s) => s.workDir === workDir)
      .map((s) => ({ id: s.id, work_dir: s.workDir, title: s.title, created_at: s.createdAt, updated_at: s.updatedAt, archived: false }))
      .sort((a, b) => b.updated_at - a.updated_at);
  }

  listAll(): SessionInfo[] {
    return [...this.sessions.values()]
      .map((s) => ({ id: s.id, work_dir: s.workDir, title: s.title, created_at: s.createdAt, updated_at: s.updatedAt, archived: false }))
      .sort((a, b) => b.updated_at - a.updated_at);
  }

  delete(sessionId: string): void { this.sessions.delete(sessionId); }

  fork(sessionId: string, _atTurn?: number): string {
    const src = this.sessions.get(sessionId);
    const newId = this.create(src?.workDir ?? '.');
    if (src) {
      const s = this.sessions.get(newId)!;
      s.title = src.title ? `${src.title} (fork)` : null;
    }
    return newId;
  }

  setTitle(sessionId: string, title: string): void {
    const s = this.sessions.get(sessionId);
    if (s) { s.title = title; s.updatedAt = Date.now(); }
  }

  get(sessionId: string): SessionInfo | undefined {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;
    return { id: s.id, work_dir: s.workDir, title: s.title, created_at: s.createdAt, updated_at: s.updatedAt, archived: false };
  }

  recordTurn(sessionId: string, _turnNumber: number): void {
    const s = this.sessions.get(sessionId);
    if (s) s.updatedAt = Date.now();
  }
}

// ── CoreDataSource ──────────────────────────────────────────────────

export class CoreDataSource implements DataSource {
  public readonly sessions: SessionStore;

  private readonly engine: Engine;
  private readonly streams = new Map<string, PushableStream>();
  private seqCounter = 0;
  private turnCounter = 0;
  private currentTurnId: string | null = null;
  /** The session that is currently running a turn (for routing SoulEvents). */
  private activeSessionId: string | null = null;
  /** Timer to detect turn end: fires after step.end if no step.begin follows. */
  private turnEndTimer: ReturnType<typeof setTimeout> | null = null;
  /** Tool calls pending in the current step (id → name). */
  private pendingTools = new Map<string, string>();

  constructor(engine: Engine) {
    this.engine = engine;
    this.sessions = new CoreSessionStore();

    // Listen to SoulEvents and forward as WireMessages.
    engine.eventBus.on((event: SoulEvent) => {
      this.handleSoulEvent(event);
    });
  }

  // ── DataSource interface ──────────────────────────────────────────

  startTurn(sessionId: string, turnId: string, input: string): void {
    this.currentTurnId = turnId;
    this.activeSessionId = sessionId;

    // Emit turn.begin
    this.pushEvent(sessionId, 'turn.begin', {
      turn_id: turnId,
      user_input: input,
      input_kind: 'user',
    });

    // dispatch() is NON-BLOCKING — it returns immediately with
    // { turn_id, status: 'started' }. The actual Soul turn runs
    // in the background. We must NOT emit turn.end here.
    // turn.end is emitted from handleSoulEvent when step.end fires.
    void this.engine.soulPlus
      .dispatch({
        method: 'session.prompt',
        data: { input: { text: input } },
      })
      .catch(() => {
        // Dispatch itself failed (not the turn) — emit error turn.end.
        this.pushEvent(sessionId, 'turn.end', {
          turn_id: turnId,
          reason: 'error',
          success: false,
        });
        this.currentTurnId = null;
        this.activeSessionId = null;
      });
  }

  events(sessionId: string): AsyncIterable<WireMessage> {
    let stream = this.streams.get(sessionId);
    if (!stream) {
      stream = createPushableStream();
      this.streams.set(sessionId, stream);
    }
    return stream.iterable;
  }

  resolveRequest(_requestId: string, _data: unknown): void {
    // TODO: approval responses — SoulPlus Slice 3 is always-allow,
    // so no approval requests are generated yet.
  }

  cancelTurn(_sessionId: string): void {
    void this.engine.soulPlus.dispatch({
      method: 'session.cancel',
      data: {},
    });
  }

  // ── SoulEvent → WireMessage mapping ───────────────────────────────

  private handleSoulEvent(event: SoulEvent): void {
    const sessionId = this.activeSessionId;
    if (!sessionId) return;

    switch (event.type) {
      case 'content.delta':
        this.pushEvent(sessionId, 'content.delta', {
          type: 'text',
          text: event.delta,
        });
        break;

      case 'thinking.delta':
        this.pushEvent(sessionId, 'content.delta', {
          type: 'think',
          think: event.delta,
        });
        break;

      case 'tool.call':
        this.pendingTools.set(event.toolCallId, event.name);
        this.pushEvent(sessionId, 'tool.call', {
          id: event.toolCallId,
          name: event.name,
          args: event.args,
        });
        break;

      case 'tool.progress':
        this.pushEvent(sessionId, 'tool.progress', {
          tool_call_id: event.toolCallId,
          update: event.update,
        });
        break;

      case 'step.begin':
        this.cancelTurnEndTimer();
        this.pendingTools.clear();
        this.pushEvent(sessionId, 'step.begin', { step: event.step });
        break;

      case 'step.end':
        // Emit synthetic tool.result for all pending tools from this step.
        // Soul executes tools internally and doesn't emit tool.result events,
        // so we synthesize them here so the CLI can move tool calls from
        // the dynamic area into Static with a green success indicator.
        for (const [toolCallId] of this.pendingTools) {
          this.pushEvent(sessionId, 'tool.result', {
            tool_call_id: toolCallId,
            output: '(completed)',
            is_error: false,
          });
        }
        this.pendingTools.clear();

        this.pushEvent(sessionId, 'step.end', { step: event.step });
        // Schedule turn.end — if another step.begin arrives before the
        // timer fires, the timer is cancelled and the turn continues.
        this.scheduleTurnEnd(sessionId, 'done', true);
        break;

      case 'step.interrupted':
        this.pushEvent(sessionId, 'step.interrupted', {
          step: event.step,
          reason: event.reason,
        });
        // Interrupted → turn is definitely over.
        this.cancelTurnEndTimer();
        this.finishTurn(sessionId, event.reason, false);
        break;

      case 'compaction.begin':
        this.pushEvent(sessionId, 'compaction.begin', {});
        break;

      case 'compaction.end':
        this.pushEvent(sessionId, 'compaction.end', {
          tokens_before: event.tokensBefore,
          tokens_after: event.tokensAfter,
        });
        break;
    }
  }

  private scheduleTurnEnd(sessionId: string, reason: string, success: boolean): void {
    this.cancelTurnEndTimer();
    this.turnEndTimer = setTimeout(() => {
      this.turnEndTimer = null;
      this.finishTurn(sessionId, reason, success);
    }, 200);
  }

  private cancelTurnEndTimer(): void {
    if (this.turnEndTimer !== null) {
      clearTimeout(this.turnEndTimer);
      this.turnEndTimer = null;
    }
  }

  private finishTurn(sessionId: string, reason: string, success: boolean): void {
    this.pushEvent(sessionId, 'turn.end', {
      turn_id: this.currentTurnId,
      reason,
      success,
    });
    this.currentTurnId = null;
    this.activeSessionId = null;
  }

  private pushEvent(sessionId: string, method: string, data: unknown): void {
    let stream = this.streams.get(sessionId);
    if (!stream) {
      stream = createPushableStream();
      this.streams.set(sessionId, stream);
    }
    const opts = {
      session_id: sessionId,
      turn_id: this.currentTurnId ?? undefined,
      seq: ++this.seqCounter,
    };
    stream.push(createEvent(method, data, opts));
  }
}
