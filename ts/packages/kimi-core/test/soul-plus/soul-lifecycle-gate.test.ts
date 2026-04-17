/**
 * Covers: `SoulLifecycleGate` (v2 §5.2 / §5.8.2).
 *
 * The facade bridges the 5-state internal machine to the 3-state gate
 * exposed to Slice 1 `JournalWriter` and Slice 2 `Runtime.lifecycle`.
 * Tests pin the 5→3 mapping (including the `destroying → completing`
 * Phase 1 collapse) and the delegation of `transitionTo` back into the
 * underlying machine.
 */

import { describe, expect, it } from 'vitest';

import { SoulLifecycleGate, SessionLifecycleStateMachine } from '../../src/soul-plus/index.js';

describe('SoulLifecycleGate', () => {
  describe('5 → 3 state mapping', () => {
    it.each([
      ['idle', 'active'],
      ['active', 'active'],
      ['compacting', 'compacting'],
      ['completing', 'completing'],
      ['destroying', 'completing'],
    ] as const)('machine %s → facade state %s', (internal, external) => {
      const machine = new SessionLifecycleStateMachine(internal);
      const facade = new SoulLifecycleGate(machine);
      expect(facade.state).toBe(external);
    });
  });

  it('reflects state changes driven on the underlying machine', () => {
    const machine = new SessionLifecycleStateMachine();
    const facade = new SoulLifecycleGate(machine);

    expect(facade.state).toBe('active'); // idle collapses to 'active'
    machine.transitionTo('active');
    expect(facade.state).toBe('active');
    machine.transitionTo('compacting');
    expect(facade.state).toBe('compacting');
    machine.transitionTo('active');
    expect(facade.state).toBe('active');
    machine.transitionTo('completing');
    expect(facade.state).toBe('completing');
  });

  describe('transitionTo delegates to the state machine', () => {
    it('`active` resumes the underlying machine from compacting', async () => {
      const machine = new SessionLifecycleStateMachine('compacting');
      const facade = new SoulLifecycleGate(machine);
      await facade.transitionTo('active');
      expect(machine.state).toBe('active');
    });

    it('`compacting` from active is legal', async () => {
      const machine = new SessionLifecycleStateMachine('active');
      const facade = new SoulLifecycleGate(machine);
      await facade.transitionTo('compacting');
      expect(machine.state).toBe('compacting');
    });

    it('`completing` from active is legal', async () => {
      const machine = new SessionLifecycleStateMachine('active');
      const facade = new SoulLifecycleGate(machine);
      await facade.transitionTo('completing');
      expect(machine.state).toBe('completing');
    });

    it('propagates rejection from an illegal underlying transition', async () => {
      const machine = new SessionLifecycleStateMachine('idle');
      const facade = new SoulLifecycleGate(machine);
      // idle → compacting is illegal (must go through active first)
      await expect(facade.transitionTo('compacting')).rejects.toThrow();
    });
  });

  it('returns a fresh Promise from every transitionTo call', async () => {
    const machine = new SessionLifecycleStateMachine('active');
    const facade = new SoulLifecycleGate(machine);
    const p = facade.transitionTo('completing');
    expect(p).toBeInstanceOf(Promise);
    await p;
  });
});
