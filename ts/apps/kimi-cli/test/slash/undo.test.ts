/**
 * Phase 21 §D.1 — `/undo` slash command.
 *
 * Covers the happy path (session.rollback dispatched with n_turns_back:1
 * and the result is a reload→undo directive), the wire-error path
 * (error message surfaced in-transcript, no reload), and the guard for
 * clients that do not implement `rollback`.
 */

import { describe, expect, it, vi } from 'vitest';

import type { AppState } from '../../src/app/state.js';
import { createDefaultRegistry } from '../../src/slash/index.js';
import type { SlashCommandContext } from '../../src/slash/index.js';
import type { WireClient } from '../../src/wire/index.js';

function mockState(overrides?: Partial<AppState>): AppState {
  return {
    model: 'test-model',
    workDir: '/test',
    sessionId: 'session-001',
    yolo: false,
    planMode: false,
    thinking: false,
    contextUsage: 0.1,
    contextTokens: 0,
    maxContextTokens: 200_000,
    isStreaming: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    theme: 'dark',
    version: '0.1.0',
    editorCommand: null,
    availableModels: {},
    ...overrides,
  };
}

function makeCtx(
  wire: Partial<WireClient>,
  overrides?: Partial<AppState>,
): SlashCommandContext {
  return {
    wireClient: wire as WireClient,
    appState: mockState(overrides),
    setAppState: vi.fn(),
    showStatus: vi.fn(),
  };
}

describe('/undo', () => {
  const registry = createDefaultRegistry();

  it('dispatches session.rollback with n_turns_back:1 and returns a reload→undo action', async () => {
    const rollback = vi.fn(async () => ({ new_turn_count: 2 }));
    const cmd = registry.find('undo')!;
    const ctx = makeCtx({ rollback }, { sessionId: 'session-xyz' });

    const result = await cmd.execute('', ctx);

    expect(rollback).toHaveBeenCalledTimes(1);
    expect(rollback).toHaveBeenCalledWith('session-xyz', 1);
    expect(result).toEqual({ type: 'reload', action: 'undo' });
  });

  it('surfaces a readable message when the wire call throws', async () => {
    const rollback = vi.fn(async () => {
      throw new Error('session active');
    });
    const cmd = registry.find('undo')!;
    const ctx = makeCtx({ rollback });

    const result = await cmd.execute('', ctx);

    expect(result.type).toBe('ok');
    if (result.type === 'ok') {
      expect(result.message).toBe('/undo failed: session active');
    }
  });

  it('reports gracefully when the client does not support rollback', async () => {
    // Older / mock WireClient implementations may not define
    // `rollback` — the optional method should degrade, not crash.
    const cmd = registry.find('undo')!;
    const ctx = makeCtx({});

    const result = await cmd.execute('', ctx);

    expect(result).toEqual({ type: 'ok', message: 'Undo is not supported by this client.' });
  });
});
