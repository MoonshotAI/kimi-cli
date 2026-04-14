/**
 * MockEventGenerator -- configurable event sequence generator.
 *
 * Given a `Scenario` (an ordered list of event descriptors with optional
 * delays), it produces an `AsyncIterable<WireEvent>` that the
 * `MockWireClient` feeds to callers of `prompt()`.
 */

import type { WireEvent } from './types.js';

// ── Scenario Types ────────────────────────────────────────────────────

/**
 * A single step in a mock scenario. Either a concrete event to emit
 * or a delay (in milliseconds) to simulate network/processing latency.
 */
export type ScenarioStep =
  | { kind: 'event'; event: WireEvent }
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

/** Create an event step. */
export function event(e: WireEvent): ScenarioStep {
  return { kind: 'event', event: e };
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
 * Walks a `Scenario` and yields `WireEvent` values as an async iterable.
 *
 * Supports external cancellation via `cancel()`. When cancelled, the
 * generator emits a `StepInterrupted` event followed by `TurnEnd` and
 * then terminates.
 */
export class MockEventGenerator {
  private readonly delayMultiplier: number;
  private cancelled = false;

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
  }

  /** Whether the generator has been cancelled. */
  get isCancelled(): boolean {
    return this.cancelled;
  }

  /**
   * Generate events from a scenario.
   * The iterable respects cancellation: when `cancel()` is called,
   * the remaining steps are skipped and an interruption sequence is emitted.
   */
  async *generate(scenario: Scenario): AsyncIterable<WireEvent> {
    this.cancelled = false;

    for (const step of scenario.steps) {
      if (this.cancelled) {
        yield { type: 'StepInterrupted' };
        yield { type: 'TurnEnd' };
        return;
      }

      if (step.kind === 'delay') {
        const actualDelay = Math.round(step.ms * this.delayMultiplier);
        if (actualDelay > 0) {
          await sleep(actualDelay);
        }
        // Check cancellation after the delay
        if (this.cancelled) {
          yield { type: 'StepInterrupted' };
          yield { type: 'TurnEnd' };
          return;
        }
      } else {
        yield step.event;
      }
    }
  }
}

// ── Internal helpers ──────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
