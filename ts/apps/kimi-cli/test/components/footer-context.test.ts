import { describe, it, expect } from 'vitest';

import { FooterComponent } from '../../src/components/FooterComponent.js';
import { darkColors } from '../../src/theme/colors.js';
import type { AppState } from '../../src/app/state.js';

const ANSI_SGR = /\u001B\[[0-9;]*m/g;
function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
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
    maxContextTokens: 0,
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

describe('FooterComponent — context NaN resilience', () => {
  it('NaN usage → renders 0.0% (never literal "NaN%")', () => {
    const fc = new FooterComponent(baseState({ contextUsage: Number.NaN }), darkColors);
    const out = strip(fc.render(120).join(''));
    expect(out).not.toMatch(/NaN/);
    expect(out).toMatch(/context: 0\.0%/);
  });

  it('undefined-ish (coerced) usage → renders 0.0%', () => {
    const fc = new FooterComponent(
      baseState({ contextUsage: undefined as unknown as number }),
      darkColors,
    );
    const out = strip(fc.render(120).join(''));
    expect(out).not.toMatch(/NaN/);
    expect(out).toMatch(/context: 0\.0%/);
  });

  it('clamps ratios above 1.0 → renders 100.0%', () => {
    const fc = new FooterComponent(baseState({ contextUsage: 1.5 }), darkColors);
    const out = strip(fc.render(120).join(''));
    expect(out).toMatch(/context: 100\.0%/);
  });

  it('ratio 0.427 → renders 42.7%', () => {
    const fc = new FooterComponent(baseState({ contextUsage: 0.427 }), darkColors);
    const out = strip(fc.render(200).join(''));
    expect(out).toMatch(/context: 42\.7%/);
  });

  it('tokens provided but max=0 → falls back to percent-only, no division-by-zero artefact', () => {
    const fc = new FooterComponent(
      baseState({ contextUsage: 0, contextTokens: 500, maxContextTokens: 0 }),
      darkColors,
    );
    const out = strip(fc.render(200).join(''));
    expect(out).not.toMatch(/Infinity|NaN/);
    expect(out).toMatch(/context: 0\.0%/);
    // With maxTokens=0, token-count annotation is suppressed.
    expect(out).not.toMatch(/\(500\//);
  });
});
