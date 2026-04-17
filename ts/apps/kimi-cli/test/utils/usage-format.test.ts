import { describe, it, expect } from 'vitest';

import {
  formatTokenCount,
  renderProgressBar,
  ratioSeverity,
} from '../../src/utils/usage-format.js';

describe('formatTokenCount', () => {
  it('passes small values through unchanged', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(1)).toBe('1');
    expect(formatTokenCount(999)).toBe('999');
  });

  it('rounds integers over 1k to 1 decimal', () => {
    expect(formatTokenCount(1_000)).toBe('1.0k');
    expect(formatTokenCount(1_234)).toBe('1.2k');
    expect(formatTokenCount(9_876)).toBe('9.9k');
  });

  it('switches to M above a million', () => {
    expect(formatTokenCount(1_000_000)).toBe('1.0M');
    expect(formatTokenCount(2_500_000)).toBe('2.5M');
  });

  it('clamps negatives and NaN to 0', () => {
    expect(formatTokenCount(-1)).toBe('0');
    expect(formatTokenCount(Number.NaN)).toBe('0');
    expect(formatTokenCount(Number.POSITIVE_INFINITY)).toBe('0');
  });
});

describe('renderProgressBar', () => {
  it('empty bar at ratio 0', () => {
    expect(renderProgressBar(0, 10)).toBe('░'.repeat(10));
  });
  it('full bar at ratio 1', () => {
    expect(renderProgressBar(1, 10)).toBe('█'.repeat(10));
  });
  it('half bar at ratio 0.5', () => {
    expect(renderProgressBar(0.5, 10)).toBe('█'.repeat(5) + '░'.repeat(5));
  });
  it('clamps ratios outside [0,1]', () => {
    expect(renderProgressBar(-1, 8)).toBe('░'.repeat(8));
    expect(renderProgressBar(2, 8)).toBe('█'.repeat(8));
  });
  it('coerces NaN to 0', () => {
    expect(renderProgressBar(Number.NaN, 6)).toBe('░'.repeat(6));
  });
});

describe('ratioSeverity', () => {
  it('green below 0.5', () => {
    expect(ratioSeverity(0)).toBe('ok');
    expect(ratioSeverity(0.49)).toBe('ok');
  });
  it('yellow in [0.5, 0.85)', () => {
    expect(ratioSeverity(0.5)).toBe('warn');
    expect(ratioSeverity(0.7)).toBe('warn');
    expect(ratioSeverity(0.849)).toBe('warn');
  });
  it('red at or above 0.85', () => {
    expect(ratioSeverity(0.85)).toBe('danger');
    expect(ratioSeverity(1)).toBe('danger');
  });
});
