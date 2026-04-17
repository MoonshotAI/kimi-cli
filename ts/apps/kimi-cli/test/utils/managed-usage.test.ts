import { describe, it, expect } from 'vitest';

import {
  isManagedKimiCode,
  parseManagedUsagePayload,
  formatDuration,
  formatResetTime,
} from '../../src/utils/managed-usage.js';

describe('isManagedKimiCode', () => {
  it('matches only the kimi-code managed provider', () => {
    expect(isManagedKimiCode('managed:kimi-code')).toBe(true);
    expect(isManagedKimiCode('managed:moonshot-ai')).toBe(false);
    expect(isManagedKimiCode('openai')).toBe(false);
    expect(isManagedKimiCode('')).toBe(false);
    expect(isManagedKimiCode(null)).toBe(false);
    expect(isManagedKimiCode(undefined)).toBe(false);
  });
});

describe('parseManagedUsagePayload', () => {
  it('returns empty when payload is not an object', () => {
    expect(parseManagedUsagePayload(null)).toEqual({ summary: null, limits: [] });
    expect(parseManagedUsagePayload('nope')).toEqual({ summary: null, limits: [] });
  });

  it('extracts a summary from the `usage` object', () => {
    const parsed = parseManagedUsagePayload({
      usage: { used: 40, limit: 1000, name: 'Weekly limit' },
    });
    expect(parsed.summary).toEqual({
      label: 'Weekly limit',
      used: 40,
      limit: 1000,
    });
    expect(parsed.limits).toEqual([]);
  });

  it('falls back to remaining=limit-used when used is absent', () => {
    const parsed = parseManagedUsagePayload({ usage: { remaining: 200, limit: 1000 } });
    expect(parsed.summary).toEqual({ label: 'Weekly limit', used: 800, limit: 1000 });
  });

  it('labels limits from window duration when no name is given', () => {
    const parsed = parseManagedUsagePayload({
      limits: [
        { detail: { used: 1, limit: 100 }, window: { duration: 300, timeUnit: 'MINUTE' } },
        { detail: { used: 2, limit: 50 }, window: { duration: 24, timeUnit: 'HOUR' } },
      ],
    });
    expect(parsed.limits.map((l) => l.label)).toEqual(['5h limit', '24h limit']);
  });

  it('prefers explicit item.name over window duration label', () => {
    const parsed = parseManagedUsagePayload({
      limits: [
        { name: 'Daily cap', detail: { used: 5, limit: 100 }, window: { duration: 1440, timeUnit: 'MINUTE' } },
      ],
    });
    expect(parsed.limits[0]!.label).toBe('Daily cap');
  });

  it('surfaces reset hints from resetAt timestamps', () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const parsed = parseManagedUsagePayload({ usage: { used: 1, limit: 10, resetAt: future } });
    expect(parsed.summary?.resetHint).toMatch(/resets in/);
  });
});

describe('formatDuration', () => {
  it('formats days/hours/minutes', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(90)).toBe('1m');
    expect(formatDuration(3600)).toBe('1h');
    expect(formatDuration(3661)).toBe('1h 1m');
    expect(formatDuration(86_400 + 7200 + 600)).toBe('1d 2h 10m');
  });
});

describe('formatResetTime', () => {
  it('returns "reset" for past timestamps', () => {
    const past = new Date(Date.now() - 5000).toISOString();
    expect(formatResetTime(past)).toBe('reset');
  });
  it('returns "resets in X" for future timestamps', () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    expect(formatResetTime(future)).toMatch(/^resets in /);
  });
  it('falls back when parsing fails', () => {
    expect(formatResetTime('not-a-date')).toBe('resets at not-a-date');
  });
});
