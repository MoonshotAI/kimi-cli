/**
 * Covers: `SessionLifecycleStateMachine` (v2 §5.8.2 / appendix D.7).
 *
 * The 5-state lifecycle owner is the canonical state field — everything
 * else (SoulLifecycleGate, JournalWriter, TurnManager) gates its own
 * behaviour on this machine. These tests lock the transition matrix and
 * the `is*` predicates so implementer cannot silently widen or narrow the
 * allowed graph.
 */

import { describe, expect, it } from 'vitest';

import { SessionLifecycleStateMachine } from '../../src/soul-plus/index.js';

describe('SessionLifecycleStateMachine', () => {
  it('defaults to idle when no initial state is provided', () => {
    const machine = new SessionLifecycleStateMachine();
    expect(machine.state).toBe('idle');
    expect(machine.isIdle()).toBe(true);
    expect(machine.isActive()).toBe(false);
    expect(machine.isCompleting()).toBe(false);
    expect(machine.isCompacting()).toBe(false);
    expect(machine.isDestroying()).toBe(false);
  });

  it('accepts an explicit initial state', () => {
    const machine = new SessionLifecycleStateMachine('active');
    expect(machine.state).toBe('active');
    expect(machine.isActive()).toBe(true);
    expect(machine.isIdle()).toBe(false);
  });

  describe('legal transitions', () => {
    it.each([
      ['idle', 'active'],
      ['idle', 'destroying'],
      ['active', 'completing'],
      ['active', 'compacting'],
      ['active', 'destroying'],
      ['completing', 'idle'],
      ['completing', 'active'],
      ['completing', 'destroying'],
      ['compacting', 'active'],
      ['compacting', 'destroying'],
    ] as const)('%s → %s', (from, to) => {
      const machine = new SessionLifecycleStateMachine(from);
      expect(() => {
        machine.transitionTo(to);
      }).not.toThrow();
      expect(machine.state).toBe(to);
    });
  });

  describe('illegal transitions are rejected', () => {
    it.each([
      ['idle', 'completing'],
      ['idle', 'compacting'],
      ['active', 'idle'],
      ['compacting', 'completing'],
      ['compacting', 'idle'],
      ['completing', 'compacting'],
    ] as const)('%s → %s', (from, to) => {
      const machine = new SessionLifecycleStateMachine(from);
      expect(() => {
        machine.transitionTo(to);
      }).toThrow();
      // the state must be unchanged after a rejected transition
      expect(machine.state).toBe(from);
    });

    it('destroying is terminal (no outgoing transitions)', () => {
      const machine = new SessionLifecycleStateMachine('destroying');
      for (const target of ['idle', 'active', 'completing', 'compacting'] as const) {
        expect(() => {
          machine.transitionTo(target);
        }).toThrow();
      }
      expect(machine.state).toBe('destroying');
      expect(machine.isDestroying()).toBe(true);
    });
  });

  it('drives the canonical turn lifecycle idle → active → completing → idle', () => {
    const machine = new SessionLifecycleStateMachine();
    machine.transitionTo('active');
    expect(machine.isActive()).toBe(true);
    machine.transitionTo('completing');
    expect(machine.isCompleting()).toBe(true);
    machine.transitionTo('idle');
    expect(machine.isIdle()).toBe(true);
  });

  it('supports compaction branch active → compacting → active', () => {
    const machine = new SessionLifecycleStateMachine('active');
    machine.transitionTo('compacting');
    expect(machine.isCompacting()).toBe(true);
    machine.transitionTo('active');
    expect(machine.isActive()).toBe(true);
  });
});
