/**
 * WakeQueueScheduler — pure FIFO `TurnTrigger` queue (v2 §6.4 /
 * 决策 #109 / phase-4 todo Part A.2).
 *
 * Phase 4 creates the empty queue structure so the SoulPlus facade has a
 * slot to expose. Phase 7 (TeamDaemon / auto-wake) will plug triggers
 * into it from notification completion / timer events. Zero external
 * dependencies — this is a container, not a service.
 */

import type { TurnTrigger } from './types.js';

export class WakeQueueScheduler {
  private queue: TurnTrigger[] = [];

  enqueue(trigger: TurnTrigger): void {
    this.queue.push(trigger);
  }

  /**
   * Remove and return every buffered trigger in FIFO order. Idempotent
   * on an empty queue (returns `[]`).
   */
  drain(): TurnTrigger[] {
    const drained = this.queue;
    this.queue = [];
    return drained;
  }

  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /** Non-destructive read of the head trigger. */
  peek(): TurnTrigger | undefined {
    return this.queue[0];
  }
}
