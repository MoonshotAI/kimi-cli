/**
 * Phase 19 Slice B.3 — ModelCapability type & UNKNOWN_CAPABILITY default.
 *
 * Failing on import until `src/capability.ts` is implemented. Covers the
 * pure type/helper layer; provider-specific `getCapability` tables live in
 * `capability-providers.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { UNKNOWN_CAPABILITY, type ModelCapability } from '../src/capability.js';

describe('ModelCapability / UNKNOWN_CAPABILITY', () => {
  it('UNKNOWN_CAPABILITY has all boolean fields false', () => {
    expect(UNKNOWN_CAPABILITY.image_in).toBe(false);
    expect(UNKNOWN_CAPABILITY.video_in).toBe(false);
    expect(UNKNOWN_CAPABILITY.audio_in).toBe(false);
    expect(UNKNOWN_CAPABILITY.thinking).toBe(false);
    expect(UNKNOWN_CAPABILITY.tool_use).toBe(false);
  });

  it('UNKNOWN_CAPABILITY.max_context_tokens is 0 (unknown)', () => {
    expect(UNKNOWN_CAPABILITY.max_context_tokens).toBe(0);
  });

  it('accepts a well-formed ModelCapability literal (type guard)', () => {
    const cap: ModelCapability = {
      image_in: true,
      video_in: false,
      audio_in: false,
      thinking: true,
      tool_use: true,
      max_context_tokens: 128_000,
    };
    expect(cap.image_in).toBe(true);
    expect(cap.max_context_tokens).toBe(128_000);
  });

  it('UNKNOWN_CAPABILITY is read-only (frozen or otherwise immutable)', () => {
    // Defensive: future code should not be able to mutate the shared default.
    // We accept either Object.isFrozen() or a thrown TypeError on mutation
    // attempt (strict mode). Either way, the observed value afterwards must
    // still be the conservative default.
    const beforeImage = UNKNOWN_CAPABILITY.image_in;
    try {
      (UNKNOWN_CAPABILITY as unknown as { image_in: boolean }).image_in = true;
    } catch {
      // frozen in strict mode — fine
    }
    expect(UNKNOWN_CAPABILITY.image_in).toBe(beforeImage);
    expect(UNKNOWN_CAPABILITY.image_in).toBe(false);
  });
});
