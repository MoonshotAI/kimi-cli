/**
 * Phase 21 §D.4 — `/hooks` slash command.
 */

import { describe, expect, it, vi } from 'vitest';

import type { AppState } from '../../src/app/state.js';
import { createDefaultRegistry } from '../../src/slash/index.js';
import type { SlashCommandContext } from '../../src/slash/index.js';
import type { WireClient } from '../../src/wire/index.js';
import type { InitializeResult } from '../../src/wire/methods.js';

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

function makeCtx(init: InitializeResult | undefined): SlashCommandContext {
  const wireClient: Partial<WireClient> = {
    getInitializeResponse: vi.fn(() => init),
  };
  return {
    wireClient: wireClient as WireClient,
    appState: mockState(),
    setAppState: vi.fn(),
    showStatus: vi.fn(),
  };
}

describe('/hooks', () => {
  const registry = createDefaultRegistry();

  it('formats each configured hook as "event → matcher → command"', async () => {
    const cmd = registry.find('hooks')!;
    const ctx = makeCtx({
      protocol_version: '2.1',
      capabilities: {
        hooks: {
          configured: [
            { event: 'PreToolUse', matcher: 'Bash', command: 'guard.sh' },
            { event: 'Stop', command: 'notify.sh' },
          ],
        },
      },
    });

    const result = await cmd.execute('', ctx);

    expect(result.type).toBe('ok');
    if (result.type === 'ok') {
      expect(result.message).toBe(
        ['PreToolUse → Bash → guard.sh', 'Stop → * → notify.sh'].join('\n'),
      );
    }
  });

  it('prints "No hooks configured." when the list is empty', async () => {
    const cmd = registry.find('hooks')!;
    const ctx = makeCtx({
      protocol_version: '2.1',
      capabilities: { hooks: { configured: [] } },
    });

    const result = await cmd.execute('', ctx);

    expect(result).toEqual({ type: 'ok', message: 'No hooks configured.' });
  });

  it('prints "No hooks configured." when the client has no initialize response yet', async () => {
    const cmd = registry.find('hooks')!;
    const ctx = makeCtx(undefined);

    const result = await cmd.execute('', ctx);

    expect(result).toEqual({ type: 'ok', message: 'No hooks configured.' });
  });

  it('prints "No hooks configured." when the client lacks getInitializeResponse', async () => {
    const cmd = registry.find('hooks')!;
    const ctx: SlashCommandContext = {
      wireClient: {} as WireClient,
      appState: mockState(),
      setAppState: vi.fn(),
      showStatus: vi.fn(),
    };

    const result = await cmd.execute('', ctx);

    expect(result).toEqual({ type: 'ok', message: 'No hooks configured.' });
  });
});
