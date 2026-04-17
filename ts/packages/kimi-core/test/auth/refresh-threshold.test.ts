/**
 * defaultRefreshThreshold — three boundary cases ported from
 * Python tests/auth/test_oauth_refresh.py L414/L419/L424.
 *
 * Formula (oauth-manager.ts:39-44):
 *   threshold = max(MIN_REFRESH_THRESHOLD_SECONDS, expiresIn * 0.5)
 * where MIN_REFRESH_THRESHOLD_SECONDS = 300 and 0 / negative expiresIn
 * fall back to MIN (the TS implementation short-circuits on `> 0`).
 */

import { describe, expect, it } from 'vitest';

import { defaultRefreshThreshold } from '../../src/auth/oauth-manager.js';

describe('defaultRefreshThreshold — boundary cases', () => {
  it('returns expiresIn * 0.5 when ratio exceeds the 300s minimum (expiresIn=1800 → 900)', () => {
    // Python parity: L414 — 1800 * 0.5 = 900 > 300.
    expect(defaultRefreshThreshold(1800)).toBe(900);
  });

  it('clamps to the 300s minimum when expiresIn * 0.5 falls below (expiresIn=500 → 300)', () => {
    // Python parity: L419 — 500 * 0.5 = 250 < 300, so the floor wins.
    expect(defaultRefreshThreshold(500)).toBe(300);
  });

  it('falls back to the 300s minimum when expiresIn is 0 (expiresIn=0 → 300)', () => {
    // Python parity: L424 — pathological token with no lifetime still
    // refreshes on a fixed cadence; never produces a zero threshold.
    expect(defaultRefreshThreshold(0)).toBe(300);
  });
});
