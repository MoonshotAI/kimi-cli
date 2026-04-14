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
import { toolCallScenario } from './scenarios/tool-call.js';
import { approvalScenario } from './scenarios/approval.js';

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

    const self = this;

    // Use an async generator so we can `await` mid-stream for approvals
    async function* generate(): AsyncGenerator<WireEvent> {
      for await (const event of stream.iterable) {
        // Drain any queued steer inputs
        while (self.steerQueue.length > 0) {
          const steerInput = self.steerQueue.shift()!;
          yield { type: 'SteerInput', userInput: steerInput } as WireEvent;
        }

        // Yield the event
        yield event;

        // If this was an ApprovalRequest, pause until approvalResponse() is called
        if (event.type === 'ApprovalRequest') {
          await new Promise<ApprovalResponsePayload>((resolve) => {
            self.pendingApprovals.set(event.id, resolve);
          });
          // Approval received — stream continues with remaining events
        }
      }
      self.currentStream = null;
    }

    // Record the turn in the session store
    if (this.options.sessionId) {
      this.sessionStore.recordTurn(this.options.sessionId, this.turnCount);
    }

    return generate();
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
    const resolver = this.pendingApprovals.get(requestId);
    if (resolver !== undefined) {
      resolver(response);
      this.pendingApprovals.delete(requestId);
    }
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
  const lower = input.toLowerCase();

  // Route to approval scenario when input contains "approve" or "write"
  if (lower.includes('approve') || lower.includes('write')) {
    const { preApproval, postApproval } = approvalScenario(input);
    // Combine pre + post into one flat scenario.
    // The MockWireClient's async generator will pause at the ApprovalRequest
    // event until approvalResponse() is called, then continue with post steps.
    return {
      name: 'approval',
      description: 'Approval flow',
      steps: [...preApproval.steps, ...postApproval.steps],
    };
  }

  // Route to tool call scenario when input contains "tool" or "file"
  if (lower.includes('tool') || lower.includes('file')) {
    return toolCallScenario(input);
  }

  // Default: simple chat scenario
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
