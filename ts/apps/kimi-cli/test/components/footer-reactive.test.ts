import { describe, it, expect, vi } from 'vitest';

import { FooterComponent } from '../../src/components/FooterComponent.js';
import type { FooterFeedHandlers } from '../../src/components/FooterComponent.js';
import { darkColors } from '../../src/theme/colors.js';
import type { AppState } from '../../src/app/state.js';
import type { StatusUpdateData, SessionMetaChangedData } from '../../src/wire/events.js';

function strip(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function baseState(overrides: Partial<AppState> = {}): AppState {
  return {
    model: 'k2',
    workDir: '/tmp',
    sessionId: 'sess_1',
    yolo: false,
    planMode: false,
    thinking: false,
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 200_000,
    isStreaming: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    theme: 'dark',
    version: 'test',
    editorCommand: null,
    availableModels: {},
    ...overrides,
  } as AppState;
}

function makeFakeFeed(): FooterFeedHandlers & {
  emitStatusUpdate: (data: StatusUpdateData) => void;
  emitSessionMetaChanged: (data: SessionMetaChangedData) => void;
  statusListeners: Set<(d: StatusUpdateData) => void>;
  metaListeners: Set<(d: SessionMetaChangedData) => void>;
} {
  const statusListeners = new Set<(d: StatusUpdateData) => void>();
  const metaListeners = new Set<(d: SessionMetaChangedData) => void>();
  return {
    onStatusUpdate(h) {
      statusListeners.add(h);
      return () => {
        statusListeners.delete(h);
      };
    },
    onSessionMetaChanged(h) {
      metaListeners.add(h);
      return () => {
        metaListeners.delete(h);
      };
    },
    emitStatusUpdate(data) {
      for (const fn of statusListeners) fn(data);
    },
    emitSessionMetaChanged(data) {
      for (const fn of metaListeners) fn(data);
    },
    statusListeners,
    metaListeners,
  };
}

describe('FooterComponent — reactive feed (Phase 21 Slice F)', () => {
  it('renders without crashing when nothing is subscribed (baseline)', () => {
    const fc = new FooterComponent(baseState(), darkColors);
    const out = strip(fc.render(120).join(''));
    expect(out).toMatch(/context: 0\.0%/);
    expect(out).toMatch(/k2/);
  });

  it('status.update with context_usage.percent=50 → renders 50.0% and calls requestRender', () => {
    const feed = makeFakeFeed();
    const renderSpy = vi.fn();
    const fc = new FooterComponent(baseState(), darkColors);
    fc.attach(feed, renderSpy);

    feed.emitStatusUpdate({
      context_usage: { percent: 50, used: 100_000, total: 200_000 },
    });

    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(strip(fc.render(200).join(''))).toMatch(/context: 50\.0%/);
  });

  it('status.update carries a new model → Footer model field updates', () => {
    const feed = makeFakeFeed();
    const renderSpy = vi.fn();
    const fc = new FooterComponent(baseState({ model: 'k2' }), darkColors);
    fc.attach(feed, renderSpy);

    feed.emitStatusUpdate({ model: 'kimi-k2-5' });

    expect(renderSpy).toHaveBeenCalled();
    const out = strip(fc.render(200).join(''));
    expect(out).toContain('kimi-k2-5');
    expect(out).not.toContain(' k2 ');
  });

  it('session_meta.changed triggers requestRender even without visible state change', () => {
    const feed = makeFakeFeed();
    const renderSpy = vi.fn();
    const fc = new FooterComponent(baseState(), darkColors);
    fc.attach(feed, renderSpy);

    feed.emitSessionMetaChanged({
      patch: { title: 'my plan' },
      source: 'user',
    });

    expect(renderSpy).toHaveBeenCalledTimes(1);
  });

  it('attach() returns a disposer that removes all listeners', () => {
    const feed = makeFakeFeed();
    const renderSpy = vi.fn();
    const fc = new FooterComponent(baseState(), darkColors);
    const dispose = fc.attach(feed, renderSpy);

    expect(feed.statusListeners.size).toBe(1);
    expect(feed.metaListeners.size).toBe(1);

    dispose();

    expect(feed.statusListeners.size).toBe(0);
    expect(feed.metaListeners.size).toBe(0);

    feed.emitStatusUpdate({ context_usage: { percent: 42, used: 1, total: 2 } });
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it('non-finite percent → renders 0.0% instead of NaN', () => {
    const feed = makeFakeFeed();
    const renderSpy = vi.fn();
    const fc = new FooterComponent(baseState(), darkColors);
    fc.attach(feed, renderSpy);

    feed.emitStatusUpdate({
      context_usage: { percent: Number.NaN, used: 0, total: 0 },
    });

    expect(renderSpy).toHaveBeenCalled();
    const out = strip(fc.render(200).join(''));
    expect(out).not.toMatch(/NaN/);
    expect(out).toMatch(/context: 0\.0%/);
  });
});
