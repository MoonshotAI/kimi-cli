/**
 * MockWireClient -- mock implementation of the WireClient interface.
 *
 * Uses `MockEventGenerator` + scenario configs to produce event streams.
 * Session operations are delegated to `MockSessionStore`.
 */

import type { WireClient, WireClientOptions, SessionInfo, ApprovalResponsePayload } from './client.js';
import type { WireEvent } from './types.js';
import type { Scenario } from './mock-event-generator.js';
import { MockEventGenerator } from './mock-event-generator.js';
import { MockSessionStore } from './mock-session-store.js';
import { createCancellableStream, type CancellableStream } from './event-stream.js';
import { simpleChatScenario } from './scenarios/simple-chat.js';

// ── Scenario resolver ─────────────────────────────────────────────────

/**
 * A function that, given user input, returns a Scenario.
 * The mock client uses this to decide which event sequence to generate.
 */
export type ScenarioResolver = (input: string) => Scenario;

// ── MockWireClient Options ────────────────────────────────────────────

export interface MockWireClientOptions extends WireClientOptions {
  /** Override the default scenario resolver. */
  scenarioResolver?: ScenarioResolver | undefined;
  /** Delay multiplier for the event generator. */
  delayMultiplier?: number | undefined;
}

// ── MockWireClient ────────────────────────────────────────────────────

export class MockWireClient implements WireClient {
  private readonly generator: MockEventGenerator;
  private readonly sessionStore: MockSessionStore;
  private readonly scenarioResolver: ScenarioResolver;
  private readonly options: MockWireClientOptions;

  private currentStream: CancellableStream<WireEvent> | null = null;
  private turnCount = 0;

  /** Accumulated steer inputs for the current turn. */
  private steerQueue: string[] = [];

  /** Pending approval callbacks. */
  private pendingApprovals = new Map<string, (response: ApprovalResponsePayload) => void>();

  /** Whether plan mode is active. */
  private planMode: boolean;

  constructor(options: MockWireClientOptions) {
    this.options = options;
    this.planMode = false;
    this.generator = new MockEventGenerator({
      delayMultiplier: options.delayMultiplier,
    });
    this.sessionStore = new MockSessionStore();
    this.scenarioResolver = options.scenarioResolver ?? defaultScenarioResolver;
  }

  // ── Prompt ──────────────────────────────────────────────────────────

  prompt(input: string, _images?: string[]): AsyncIterable<WireEvent> {
    this.turnCount++;
    this.steerQueue = [];
    this.generator.reset();

    const scenario = this.scenarioResolver(input);
    const sourceIterable = this.generator.generate(scenario);
    const stream = createCancellableStream(sourceIterable);
    this.currentStream = stream;

    // Wrap to inject steer events and handle cleanup
    const self = this;
    const wrappedIterable: AsyncIterable<WireEvent> = {
      [Symbol.asyncIterator](): AsyncIterator<WireEvent> {
        const inner = stream.iterable[Symbol.asyncIterator]();
        return {
          async next(): Promise<IteratorResult<WireEvent>> {
            // Drain any queued steer inputs first
            while (self.steerQueue.length > 0) {
              const steerInput = self.steerQueue.shift()!;
              return {
                done: false,
                value: { type: 'SteerInput', userInput: steerInput },
              };
            }

            const result = await inner.next();
            if (result.done) {
              self.currentStream = null;
              return result;
            }
            return result;
          },
          return(value?: WireEvent): Promise<IteratorResult<WireEvent>> {
            self.currentStream = null;
            if (inner.return) {
              return inner.return(value);
            }
            return Promise.resolve({ done: true as const, value: undefined as unknown as WireEvent });
          },
        };
      },
    };

    // Record the turn in the session store
    if (this.options.sessionId) {
      this.sessionStore.recordTurn(this.options.sessionId, this.turnCount);
    }

    return wrappedIterable;
  }

  // ── Steer ───────────────────────────────────────────────────────────

  steer(input: string): void {
    this.steerQueue.push(input);
  }

  // ── Cancel ──────────────────────────────────────────────────────────

  cancel(): void {
    this.generator.cancel();
    if (this.currentStream !== null) {
      this.currentStream.cancel();
    }
  }

  // ── Approval ────────────────────────────────────────────────────────

  approvalResponse(requestId: string, response: ApprovalResponsePayload): void {
    const callback = this.pendingApprovals.get(requestId);
    if (callback !== undefined) {
      callback(response);
      this.pendingApprovals.delete(requestId);
    }
    // In the simple mock, approvals are handled by the scenario itself,
    // so this is mostly a no-op. Real implementations would resolve
    // the future that the agent core is awaiting.
  }

  // ── Question ────────────────────────────────────────────────────────

  questionResponse(_requestId: string, _answer: string): void {
    // No-op in mock. Real implementation would resolve the question future.
  }

  // ── Plan Mode ───────────────────────────────────────────────────────

  setPlanMode(enabled: boolean): void {
    this.planMode = enabled;
  }

  // ── Replay ──────────────────────────────────────────────────────────

  replay(): AsyncIterable<WireEvent> {
    // Return an empty stream for the mock -- no history to replay.
    return emptyAsyncIterable();
  }

  // ── Dispose ─────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    this.cancel();
    this.pendingApprovals.clear();
  }

  // ── Session Management (delegated to MockSessionStore) ──────────────

  async createSession(workDir: string): Promise<string> {
    return this.sessionStore.create(workDir);
  }

  async listSessions(workDir: string): Promise<SessionInfo[]> {
    return this.sessionStore.list(workDir);
  }

  async listAllSessions(): Promise<SessionInfo[]> {
    return this.sessionStore.listAll();
  }

  async continueSession(workDir: string): Promise<string | null> {
    return this.sessionStore.continue(workDir);
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessionStore.delete(sessionId);
  }

  async forkSession(sessionId: string, atTurn?: number): Promise<string> {
    return this.sessionStore.fork(sessionId, atTurn);
  }

  async setSessionTitle(sessionId: string, title: string): Promise<void> {
    this.sessionStore.setTitle(sessionId, title);
  }
}

// ── Default scenario resolver ─────────────────────────────────────────

function defaultScenarioResolver(input: string): Scenario {
  // Always use the simple chat scenario as default
  return simpleChatScenario(input);
}

// ── Helpers ───────────────────────────────────────────────────────────

function emptyAsyncIterable<T>(): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        async next(): Promise<IteratorResult<T>> {
          return { done: true, value: undefined as T };
        },
      };
    },
  };
}
