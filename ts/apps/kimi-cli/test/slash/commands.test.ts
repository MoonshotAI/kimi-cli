/**
 * Slash command execution tests.
 */

import { describe, it, expect, vi } from 'vitest';

import type { AppState } from '../../src/app/state.js';
import { createDefaultRegistry } from '../../src/slash/index.js';
import type { SlashCommandContext } from '../../src/slash/index.js';
import type { WireClient } from '../../src/wire/index.js';

// ── Helpers ──────────────────────────────────────────────────────────

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

function mockWireClient(): WireClient {
  return {
    initialize: vi.fn(async () => ({ protocol_version: '2.1', capabilities: {} })),
    createSession: vi.fn(async () => ({ session_id: 'new' })),
    listSessions: vi.fn(async () => ({ sessions: [] })),
    destroySession: vi.fn(async () => {}),
    prompt: vi.fn(async () => ({ turn_id: 'turn_1' })),
    steer: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    fork: vi.fn(async () => ({ session_id: 'forked' })),
    rename: vi.fn(async () => {}),
    getStatus: vi.fn(async () => ({ state: 'idle' })),
    getUsage: vi.fn(async () => ({
      total_input_tokens: 100,
      total_output_tokens: 200,
      total_cache_read_tokens: 50,
      total_cache_write_tokens: 25,
      total_cost_usd: 0.0042,
    })),
    compact: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    setThinking: vi.fn(async () => {}),
    setPlanMode: vi.fn(async () => {}),
    setYolo: vi.fn(async () => {}),
    subscribe: vi.fn(() => ({
      [Symbol.asyncIterator]: () => ({ next: async () => new Promise(() => {}) }),
    })),
    respondToRequest: vi.fn(),
    handleSlashCommand: vi.fn(async () => ({ ok: true, message: 'noop' })),
    dispose: vi.fn(async () => {}),
  } as unknown as WireClient;
}

function makeCtx(overrides?: Partial<AppState>): {
  ctx: SlashCommandContext;
  setAppState: ReturnType<typeof vi.fn>;
} {
  const setAppState = vi.fn();
  return {
    ctx: {
      wireClient: mockWireClient(),
      appState: mockState(overrides),
      setAppState,
      showStatus: vi.fn(),
    },
    setAppState,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Slash commands', () => {
  const registry = createDefaultRegistry();

  it('registry has all built-in commands', () => {
    // At least 16 shell + 3 soul = 19
    expect(registry.size).toBeGreaterThanOrEqual(19);
  });

  it('/exit returns exit result', async () => {
    const cmd = registry.find('exit')!;
    const { ctx } = makeCtx();
    const result = await cmd.execute('', ctx);
    expect(result.type).toBe('exit');
  });

  it('/quit is an alias for /exit', () => {
    expect(registry.find('quit')?.name).toBe('exit');
  });

  it('/help returns ok with __show_help__', async () => {
    const cmd = registry.find('help')!;
    const { ctx } = makeCtx();
    const result = await cmd.execute('', ctx);
    expect(result).toEqual({ type: 'ok', message: '__show_help__' });
  });

  it('/? is an alias for /help', () => {
    expect(registry.find('?')?.name).toBe('help');
  });

  it('/version returns version string', async () => {
    const cmd = registry.find('version')!;
    const { ctx } = makeCtx({ version: '1.2.3' });
    const result = await cmd.execute('', ctx);
    expect(result).toEqual({ type: 'ok', message: 'kimi-cli v1.2.3' });
  });

  it('/clear returns reload action without calling wire directly', async () => {
    // Phase 20 §A — the slash command is a pure mapper; the wire
    // dispatch + streaming guard are owned by InteractiveMode's
    // `performReload`. That split keeps a single `isStreaming` check
    // governing both paths (mid-turn /clear cannot leak into core
    // while the UI refuses to reload).
    const cmd = registry.find('clear')!;
    const { ctx } = makeCtx({ sessionId: 'session-xyz' });
    const result = await cmd.execute('', ctx);
    expect(result).toEqual({ type: 'reload', action: 'clear' });
    expect(ctx.wireClient.clear).not.toHaveBeenCalled();
  });

  it('/reset is an alias for /clear', () => {
    expect(registry.find('reset')?.name).toBe('clear');
  });

  it('/yolo toggles yolo mode', async () => {
    const cmd = registry.find('yolo')!;

    // Toggle on (currently off)
    const { ctx: ctx1, setAppState: set1 } = makeCtx({ yolo: false });
    await cmd.execute('', ctx1);
    expect(set1).toHaveBeenCalledWith({ yolo: true });

    // Toggle off (currently on)
    const { ctx: ctx2, setAppState: set2 } = makeCtx({ yolo: true });
    await cmd.execute('', ctx2);
    expect(set2).toHaveBeenCalledWith({ yolo: false });
  });

  it('/yolo on/off sets explicitly', async () => {
    const cmd = registry.find('yolo')!;

    const { ctx: ctx1, setAppState: set1 } = makeCtx({ yolo: false });
    await cmd.execute('on', ctx1);
    expect(set1).toHaveBeenCalledWith({ yolo: true });

    const { ctx: ctx2, setAppState: set2 } = makeCtx({ yolo: true });
    await cmd.execute('off', ctx2);
    expect(set2).toHaveBeenCalledWith({ yolo: false });
  });

  it('/plan toggles plan mode', async () => {
    const cmd = registry.find('plan')!;
    const { ctx, setAppState } = makeCtx({ planMode: false });
    await cmd.execute('', ctx);
    expect(setAppState).toHaveBeenCalledWith({ planMode: true });
  });

  it('/plan on/off sets explicitly', async () => {
    const cmd = registry.find('plan')!;

    const { ctx, setAppState } = makeCtx({ planMode: true });
    await cmd.execute('off', ctx);
    expect(setAppState).toHaveBeenCalledWith({ planMode: false });
  });

  it('/model with no args emits the picker signal', async () => {
    const cmd = registry.find('model')!;
    const { ctx } = makeCtx({ model: 'gpt-4' });
    const result = await cmd.execute('', ctx);
    expect(result).toEqual({ type: 'ok', message: '__show_model_picker__' });
  });

  it('/model <alias> skips the picker and jumps straight to thinking selection', async () => {
    const cmd = registry.find('model')!;
    const { ctx } = makeCtx({
      availableModels: {
        'claude-3': { provider: 'anthropic', model: 'claude-3-5-sonnet' },
      },
    });
    const result = await cmd.execute('claude-3', ctx);
    expect(result).toEqual({ type: 'ok', message: '__show_model_picker__:claude-3' });
  });

  it('/model <unknown> surfaces a clear error', async () => {
    const cmd = registry.find('model')!;
    const { ctx } = makeCtx({ availableModels: {} });
    const result = await cmd.execute('nope', ctx);
    expect(result).toEqual({ type: 'ok', message: 'Unknown model alias: nope' });
  });

  it('/title shows session ID when no args', async () => {
    const cmd = registry.find('title')!;
    const { ctx } = makeCtx({ sessionId: 'session-0042' });
    const result = await cmd.execute('', ctx);
    expect(result).toEqual({ type: 'ok', message: 'Session: session-0042' });
  });

  it('/title <text> sets title via Wire', async () => {
    const cmd = registry.find('title')!;
    const { ctx } = makeCtx();
    const result = await cmd.execute('My Title', ctx);
    expect(ctx.wireClient.rename).toHaveBeenCalledWith('session-001', 'My Title');
    expect(result).toEqual({ type: 'ok', message: 'Title set to: My Title' });
  });

  it('/theme toggles dark/light', async () => {
    const cmd = registry.find('theme')!;

    const { ctx: ctx1, setAppState: set1 } = makeCtx({ theme: 'dark' });
    await cmd.execute('', ctx1);
    expect(set1).toHaveBeenCalledWith({ theme: 'light' });

    const { ctx: ctx2, setAppState: set2 } = makeCtx({ theme: 'light' });
    await cmd.execute('', ctx2);
    expect(set2).toHaveBeenCalledWith({ theme: 'dark' });
  });

  it('/usage emits the usage signal (InteractiveMode renders the report)', async () => {
    const cmd = registry.find('usage')!;
    const { ctx } = makeCtx();
    const result = await cmd.execute('', ctx);
    expect(result).toEqual({ type: 'ok', message: '__show_usage__' });
  });

  it('/fork calls wireClient.fork', async () => {
    const cmd = registry.find('fork')!;
    const { ctx } = makeCtx();
    const result = await cmd.execute('', ctx);
    expect(ctx.wireClient.fork).toHaveBeenCalledWith('session-001');
    expect(result.type).toBe('ok');
  });

  it('/debug shows debug info', async () => {
    const cmd = registry.find('debug')!;
    const { ctx } = makeCtx({ model: 'test-m', sessionId: 's-1' });
    const result = await cmd.execute('', ctx);
    expect(result.type).toBe('ok');
    if (result.type === 'ok') {
      expect(result.message).toContain('s-1');
      expect(result.message).toContain('test-m');
    }
  });

  it('/sessions returns __show_sessions__ signal', async () => {
    const cmd = registry.find('sessions')!;
    const { ctx } = makeCtx();
    const result = await cmd.execute('', ctx);
    expect(result).toEqual({ type: 'ok', message: '__show_sessions__' });
  });

  it('/compact calls wireClient.compact', async () => {
    const cmd = registry.find('compact')!;
    const { ctx } = makeCtx();
    await cmd.execute('', ctx);
    // Phase 17 §D.2 — src calls `compact(sessionId, customInstruction?)`;
    // the second param is undefined when `/compact` had no extra text.
    expect(ctx.wireClient.compact).toHaveBeenCalledWith('session-001', undefined);
  });

  it('/thinking toggles thinking mode', async () => {
    const cmd = registry.find('thinking')!;
    const { ctx, setAppState } = makeCtx({ thinking: false });
    await cmd.execute('', ctx);
    expect(setAppState).toHaveBeenCalledWith({ thinking: true });
  });

  it('/new returns reload', async () => {
    const cmd = registry.find('new')!;
    const { ctx } = makeCtx();
    const result = await cmd.execute('', ctx);
    expect(result.type).toBe('reload');
  });
});
