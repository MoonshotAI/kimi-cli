/**
 * Verify DynamicInjectionManager is wired into SoulPlus → TurnManager.
 *
 * Slice 5.4: DIM was already implemented in dynamic-injection.ts but
 * not wired into the production SoulPlus constructor. These tests verify
 * the wiring is complete by checking that plan-mode injections actually
 * fire at launchTurn time (not just that TurnManager was constructed).
 */

import { describe, expect, it, vi } from 'vitest';

import { SoulPlus } from '../../src/soul-plus/soul-plus.js';
import { InMemorySessionJournalImpl } from '../../src/storage/session-journal.js';
import { InMemoryContextState } from '../../src/storage/context-state.js';
import { SessionEventBus } from '../../src/soul-plus/session-event-bus.js';
import type { Runtime } from '../../src/soul/runtime.js';

function createTestSoulPlus() {
  const journal = new InMemorySessionJournalImpl();
  const context = new InMemoryContextState({ initialModel: 'test' });
  const eventBus = new SessionEventBus();
  const runtime: Runtime = {
    kosong: { chat: vi.fn() },
  };

  return { soulPlus: new SoulPlus({
    sessionId: 'test-dim-wiring',
    contextState: context,
    sessionJournal: journal,
    runtime,
    eventBus,
    tools: [],
  }), context };
}

describe('DynamicInjectionManager wiring (Slice 5.4)', () => {
  it('plan mode reminders inject into ContextState at launchTurn', async () => {
    const { soulPlus, context } = createTestSoulPlus();
    const turnManager = soulPlus.getTurnManager();

    // Enable plan mode
    turnManager.setPlanMode(true);

    // Launch a turn — this triggers drainDynamicInjectionsIntoContext
    const response = await soulPlus.dispatch({
      method: 'session.prompt',
      data: { input: { text: 'test prompt' } },
    });

    // The turn should start (even if kosong.chat is mocked and fails later,
    // DIM injection happens synchronously at launchTurn before the LLM call)
    expect(response).toHaveProperty('turn_id');

    // KEY ASSERTION: the plan-mode reminder was durably written via
    // appendSystemReminder and appears in buildMessages().
    const messages = context.buildMessages();
    const joined = messages
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    expect(joined).toContain('Plan mode is active');
    expect(joined).toContain('<system-reminder>');
  });

  it('no plan-mode injection when plan mode is off', async () => {
    const { soulPlus, context } = createTestSoulPlus();

    // Plan mode defaults to false — launch turn
    await soulPlus.dispatch({
      method: 'session.prompt',
      data: { input: { text: 'test' } },
    });

    // No plan-mode injection should appear in buildMessages()
    const messages = context.buildMessages();
    const joined = messages
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    expect(joined).not.toContain('Plan mode is active');
  });
});
