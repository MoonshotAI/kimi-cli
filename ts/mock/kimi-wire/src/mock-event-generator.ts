/**
 * MockEventGenerator -- configurable event sequence generator.
 *
 * Given a `Scenario` (an ordered list of WireMessage descriptors with
 * optional delays), it produces an `AsyncIterable<WireMessage>` that
 * the MockDataSource feeds to the WireClient's subscribe() consumer.
 */

import type { WireMessage } from './types.js';
import { createEvent } from './types.js';

// ── Scenario Types ────────────────────────────────────────────────────

/**
 * A single step in a mock scenario. Either a concrete WireMessage to
 * emit, a request message (pauses stream until resolved), or a delay.
 */
export type ScenarioStep =
  | { kind: 'event'; message: WireMessage }
  | { kind: 'request'; message: WireMessage }
  | { kind: 'delay'; ms: number };

/**
 * A named scenario: an ordered list of steps that the mock event
 * generator will walk through.
 */
export interface Scenario {
  name: string;
  description: string;
  steps: ScenarioStep[];
}

// ── Helpers to build scenario steps ───────────────────────────────────

/** Create an event step from a WireMessage. */
export function evt(message: WireMessage): ScenarioStep {
  return { kind: 'event', message };
}

/** Create a request step (pauses until resolved). */
export function req(message: WireMessage): ScenarioStep {
  return { kind: 'request', message };
}

/** Create a delay step. */
export function delay(ms: number): ScenarioStep {
  return { kind: 'delay', ms };
}

// ── MockEventGenerator ────────────────────────────────────────────────

export interface MockEventGeneratorOptions {
  /** Global delay multiplier. 0 = instant, 1 = normal, 2 = double. */
  delayMultiplier?: number | undefined;
}

/**
 * Walks a `Scenario` and yields `WireMessage` values as an async iterable.
 *
 * Supports external cancellation via `cancel()`. When cancelled, the
 * generator emits a `step.interrupted` event followed by `turn.end` and
 * then terminates.
 */
export class MockEventGenerator {
  private readonly delayMultiplier: number;
  private cancelled = false;
  private requestResolvers = new Map<string, (data: unknown) => void>();

  constructor(options?: MockEventGeneratorOptions) {
    this.delayMultiplier = options?.delayMultiplier ?? 1;
  }

  /** Signal the generator to stop after the current step. */
  cancel(): void {
    this.cancelled = true;
  }

  /** Reset cancellation state for reuse. */
  reset(): void {
    this.cancelled = false;
    this.requestResolvers.clear();
  }

  /** Whether the generator has been cancelled. */
  get isCancelled(): boolean {
    return this.cancelled;
  }

  /** Resolve a pending request (e.g. approval response). */
  resolveRequest(requestId: string, data: unknown): void {
    const resolver = this.requestResolvers.get(requestId);
    if (resolver !== undefined) {
      resolver(data);
      this.requestResolvers.delete(requestId);
    }
  }

  /**
   * Generate events from a scenario.
   * The iterable respects cancellation: when `cancel()` is called,
   * the remaining steps are skipped and an interruption sequence is emitted.
   */
  async *generate(scenario: Scenario, sessionId: string = '__mock__', turnId: string = 'turn_0'): AsyncIterable<WireMessage> {
    this.cancelled = false;
    const opts = { session_id: sessionId, turn_id: turnId };

    for (const step of scenario.steps) {
      if (this.cancelled) {
        yield createEvent('step.interrupted', { step: 0, reason: 'cancelled' }, opts);
        yield createEvent('turn.end', { turn_id: turnId, reason: 'cancelled', success: false }, opts);
        return;
      }

      if (step.kind === 'delay') {
        const actualDelay = Math.round(step.ms * this.delayMultiplier);
        if (actualDelay > 0) {
          await sleep(actualDelay);
        }
        if (this.cancelled) {
          yield createEvent('step.interrupted', { step: 0, reason: 'cancelled' }, opts);
          yield createEvent('turn.end', { turn_id: turnId, reason: 'cancelled', success: false }, opts);
          return;
        }
      } else if (step.kind === 'request') {
        // Yield the request and pause until resolved
        yield step.message;
        await new Promise<unknown>((resolve) => {
          this.requestResolvers.set(step.message.id, resolve);
        });
        // After resolution, continue with the next steps
      } else {
        yield step.message;
      }
    }
  }
}

// ── Internal helpers ──────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
