/**
 * MockDataSource -- the development-period event source.
 *
 * Satisfies the DataSource interface consumed by WireClientImpl.
 * Given user input, it resolves a scenario and generates WireMessage
 * events via MockEventGenerator.
 */

import type { Scenario } from './mock-event-generator.js';
import { MockEventGenerator } from './mock-event-generator.js';
import { MockSessionStore } from './mock-session-store.js';
import { approvalScenario } from './scenarios/approval.js';
import { simpleChatScenario } from './scenarios/simple-chat.js';
import { toolCallScenario } from './scenarios/tool-call.js';
import type { WireMessage } from './types.js';

// ── Scenario Resolver ───────────────────────────────────────────────

/**
 * A function that, given user input, returns a Scenario.
 * The mock data source uses this to decide which event sequence to generate.
 */
export type ScenarioResolver = (input: string, sessionId: string, turnId: string) => Scenario;

// ── MockDataSource Options ──────────────────────────────────────────

export interface MockDataSourceOptions {
  /** Override the default scenario resolver. */
  scenarioResolver?: ScenarioResolver | undefined;
  /** Delay multiplier for the event generator. */
  delayMultiplier?: number | undefined;
}

// ── MockDataSource ──────────────────────────────────────────────────

export class MockDataSource {
  readonly sessions: MockSessionStore;
  private readonly generator: MockEventGenerator;
  private readonly scenarioResolver: ScenarioResolver;

  /** Currently active event iterables per session. */
  private activeStreams = new Map<
    string,
    {
      push: (msg: WireMessage) => void;
      end: () => void;
    }
  >();

  constructor(options?: MockDataSourceOptions) {
    this.sessions = new MockSessionStore();
    this.generator = new MockEventGenerator({
      delayMultiplier: options?.delayMultiplier,
    });
    this.scenarioResolver = options?.scenarioResolver ?? defaultScenarioResolver;
  }

  /** Start producing events for a new turn. */
  startTurn(sessionId: string, turnId: string, input: string): void {
    this.generator.reset();

    const scenario = this.scenarioResolver(input, sessionId, turnId);

    // Consume the scenario generator and push events to the subscriber
    void (async () => {
      for await (const msg of this.generator.generate(scenario, sessionId, turnId)) {
        const stream = this.activeStreams.get(sessionId);
        if (stream !== undefined) {
          stream.push(msg);
        }
      }
    })();
  }

  /** Consume events for a session (called by WireClient.subscribe). */
  events(sessionId: string): AsyncIterable<WireMessage> {
    // Create a push-based async iterable
    const buffer: WireMessage[] = [];
    let resolve: (() => void) | null = null;
    let done = false;

    const push = (msg: WireMessage): void => {
      buffer.push(msg);
      if (resolve !== null) {
        const r = resolve;
        resolve = null;
        r();
      }
    };

    const end = (): void => {
      done = true;
      if (resolve !== null) {
        const r = resolve;
        resolve = null;
        r();
      }
    };

    this.activeStreams.set(sessionId, { push, end });
    const activeStreams = this.activeStreams;

    return {
      [Symbol.asyncIterator](): AsyncIterator<WireMessage> {
        return {
          async next(): Promise<IteratorResult<WireMessage>> {
            while (buffer.length === 0 && !done) {
              await new Promise<void>((r) => {
                resolve = r;
              });
            }
            if (buffer.length > 0) {
              return { done: false, value: buffer.shift()! };
            }
            return { done: true, value: undefined as unknown as WireMessage };
          },
          return(): Promise<IteratorResult<WireMessage>> {
            done = true;
            activeStreams.delete(sessionId);
            return Promise.resolve({ done: true, value: undefined as unknown as WireMessage });
          },
        };
      },
    };
  }

  /** Resolve a Core-initiated request (e.g. approval response). */
  resolveRequest(requestId: string, data: unknown): void {
    this.generator.resolveRequest(requestId, data);
  }

  /** Cancel the current turn for a session. */
  cancelTurn(_sessionId: string): void {
    this.generator.cancel();
  }
}

// ── Default Scenario Resolver ───────────────────────────────────────

function defaultScenarioResolver(input: string, sessionId: string, turnId: string): Scenario {
  const lower = input.toLowerCase();

  if (lower.includes('approve') || lower.includes('write')) {
    return approvalScenario(input, sessionId, turnId);
  }

  if (lower.includes('tool') || lower.includes('file')) {
    return toolCallScenario(input, sessionId, turnId);
  }

  return simpleChatScenario(input, sessionId, turnId);
}
