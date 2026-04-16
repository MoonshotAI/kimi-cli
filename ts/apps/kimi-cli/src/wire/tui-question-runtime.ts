/**
 * TUIQuestionRuntime — bridge QuestionRuntime impl for the Ink TUI
 * (Slice 4.3 Part 2).
 *
 * Parallels {@link TUIApprovalRuntime}: AskUserQuestionTool calls
 * `askQuestion(req)`, which emits a wire `question.request` envelope to
 * the TUI and blocks on a Deferred. The TUI renders a question dialog,
 * the user selects options, and `useWire` forwards their choice to
 * `KimiCoreClient.respondToRequest(requestId, data)` which calls
 * `resolveFromClient` here and unblocks the tool invocation.
 *
 * The bridge is WAL-free — in-flight questions do not survive a crash.
 */

import { randomUUID } from 'node:crypto';

import type { QuestionRequest, QuestionResult, QuestionRuntime } from '@moonshot-ai/core';

import type { QuestionRequestData } from './events.js';
import { createRequest } from './wire-message.js';
import type { WireMessage } from './wire-message.js';

// ── Deps ────────────────────────────────────────────────────────────

export interface TUIQuestionRuntimeDeps {
  readonly sessionId: string | (() => string);
  readonly emit: (msg: WireMessage) => void;
  readonly currentTurnId?: (() => string | undefined) | undefined;
  readonly allocateRequestId?: (() => string) | undefined;
}

// ── Deferred ────────────────────────────────────────────────────────

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Pending {
  readonly requestId: string;
  readonly questionTexts: string[];
  readonly deferred: Deferred<QuestionResult>;
  abortCleanup: (() => void) | undefined;
  settled: boolean;
}

// ── Implementation ──────────────────────────────────────────────────

export class TUIQuestionRuntime implements QuestionRuntime {
  private readonly deps: TUIQuestionRuntimeDeps;
  private readonly allocateRequestId: () => string;
  private readonly pending = new Map<string, Pending>();

  constructor(deps: TUIQuestionRuntimeDeps) {
    this.deps = deps;
    this.allocateRequestId = deps.allocateRequestId ?? (() => `quest_${randomUUID()}`);
  }

  async askQuestion(req: QuestionRequest): Promise<QuestionResult> {
    if (req.signal.aborted) {
      return { answer: '' };
    }

    const requestId = this.allocateRequestId();
    const deferred = makeDeferred<QuestionResult>();

    // Abort propagation — on signal, settle with an empty answer so the
    // tool path returns the "dismissed" response instead of throwing.
    let abortCleanup: (() => void) | undefined;
    const abortListener = (): void => {
      this.dismissOne(requestId);
    };
    req.signal.addEventListener('abort', abortListener, { once: true });
    abortCleanup = (): void => {
      req.signal.removeEventListener('abort', abortListener);
    };

    const entry: Pending = {
      requestId,
      questionTexts: req.questions.map((q) => q.question),
      deferred,
      abortCleanup,
      settled: false,
    };
    this.pending.set(requestId, entry);

    // Emit the TUI wire request after the pending entry is installed so
    // a racing resolveFromClient still sees the waiter.
    const data: QuestionRequestData = {
      id: requestId,
      tool_call_id: req.toolCallId,
      questions: req.questions.map((q) => ({
        question: q.question,
        header: q.header,
        multi_select: q.multiSelect ?? false,
        options: q.options.map((o) => ({
          label: o.label,
          description: o.description,
        })),
      })),
    };
    const resolvedSessionId =
      typeof this.deps.sessionId === 'string' ? this.deps.sessionId : this.deps.sessionId();
    const msg = createRequest('question.request', data, {
      session_id: resolvedSessionId,
      ...(this.deps.currentTurnId?.() !== undefined
        ? { turn_id: this.deps.currentTurnId?.() as string }
        : {}),
    });
    msg.id = requestId;
    this.deps.emit(msg);

    return deferred.promise;
  }

  /**
   * Route a TUI response into the runtime. Called from
   * `KimiCoreClient.respondToRequest` — validates the shape, serialises
   * the answer array as JSON, and resolves the Deferred.
   *
   * Accepts two wire shapes:
   *   - `{ answers: string[] }` — structured selection from the dialog.
   *   - `{ answer: string }`    — free-form text when the dialog opts
   *                               for a single textual reply.
   * Any other shape is treated as "dismissed" (empty answer).
   */
  resolveFromClient(requestId: string, data: unknown): void {
    const entry = this.claim(requestId);
    if (entry === undefined) return;

    if (
      typeof data === 'object' &&
      data !== null &&
      Array.isArray((data as { answers?: unknown }).answers)
    ) {
      const answers = (data as { answers: unknown[] }).answers.filter(
        (a): a is string => typeof a === 'string',
      );
      const mapping: Record<string, string> = {};
      const pairs = Math.min(entry.questionTexts.length, answers.length);
      for (let i = 0; i < pairs; i++) {
        const question = entry.questionTexts[i];
        const answer = answers[i];
        if (question !== undefined && answer !== undefined) {
          mapping[question] = answer;
        }
      }
      entry.deferred.resolve({ answer: JSON.stringify({ answers: mapping }) });
      return;
    }

    if (
      typeof data === 'object' &&
      data !== null &&
      typeof (data as { answer?: unknown }).answer === 'string'
    ) {
      entry.deferred.resolve({ answer: (data as { answer: string }).answer });
      return;
    }

    // Unrecognised shape — treat as dismissal.
    entry.deferred.resolve({ answer: '' });
  }

  /** Test helper — in-flight question count. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Cancel all outstanding questions — called on session teardown. */
  disposeAll(): void {
    const ids = Array.from(this.pending.keys());
    for (const requestId of ids) {
      this.dismissOne(requestId);
    }
  }

  // ── Internal ──────────────────────────────────────────────────────

  private claim(requestId: string): Pending | undefined {
    const entry = this.pending.get(requestId);
    if (entry === undefined || entry.settled) return undefined;
    entry.settled = true;
    if (entry.abortCleanup !== undefined) {
      entry.abortCleanup();
      entry.abortCleanup = undefined;
    }
    this.pending.delete(requestId);
    return entry;
  }

  private dismissOne(requestId: string): void {
    const entry = this.claim(requestId);
    if (entry === undefined) return;
    entry.deferred.resolve({ answer: '' });
  }
}
