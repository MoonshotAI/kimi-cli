/**
 * Phase 19 Slice B.3 — `checkLLMCapabilities` production helper.
 *
 * Migrated from `test/helpers/wire/phase18-extensions.ts` (where the helper
 * lived as a test-only shim) to `src/soul-plus/capability-check.ts`. The
 * helper now takes an explicit `ModelCapability` (fetched by the caller
 * from `provider.getCapability(...)`) instead of sniffing an ad-hoc
 * `.capabilities` blob off the kosong adapter.
 *
 * Return contract:
 *   - undefined  → input is compatible with declared capabilities
 *   - Error      → input asks for a modality the model does not support
 */

import { describe, expect, it } from 'vitest';

import type { ModelCapability } from '@moonshot-ai/kosong';

import { checkLLMCapabilities } from '../../src/soul-plus/capability-check.js';
import { LLMCapabilityMismatchError } from '../../src/soul-plus/errors.js';

function cap(overrides: Partial<ModelCapability> = {}): ModelCapability {
  return {
    image_in: false,
    video_in: false,
    audio_in: false,
    thinking: false,
    tool_use: false,
    max_context_tokens: 0,
    ...overrides,
  };
}

describe('checkLLMCapabilities', () => {
  it('returns undefined when image input + capability.image_in=true', () => {
    const result = checkLLMCapabilities({
      model: 'gemini-1.5-pro',
      inputContainsImage: true,
      inputContainsVideo: false,
      inputContainsAudio: false,
      capability: cap({ image_in: true }),
    });
    expect(result).toBeUndefined();
  });

  it('returns LLMCapabilityMismatchError when image input + capability.image_in=false', () => {
    const result = checkLLMCapabilities({
      model: 'gpt-3.5-turbo',
      inputContainsImage: true,
      inputContainsVideo: false,
      inputContainsAudio: false,
      capability: cap({ image_in: false }),
    });
    expect(result).toBeInstanceOf(LLMCapabilityMismatchError);
    expect(result?.message).toMatch(/image/i);
    expect(result?.message).toMatch(/gpt-3\.5-turbo/);
  });

  it('returns error when video input + capability.video_in=false', () => {
    const result = checkLLMCapabilities({
      model: 'claude-3-5-sonnet',
      inputContainsImage: false,
      inputContainsVideo: true,
      inputContainsAudio: false,
      capability: cap({ video_in: false }),
    });
    expect(result).toBeInstanceOf(LLMCapabilityMismatchError);
    expect(result?.message).toMatch(/video/i);
  });

  it('returns error when audio input + capability.audio_in=false', () => {
    const result = checkLLMCapabilities({
      model: 'claude-3-5-sonnet',
      inputContainsImage: false,
      inputContainsVideo: false,
      inputContainsAudio: true,
      capability: cap({ audio_in: false }),
    });
    expect(result).toBeInstanceOf(LLMCapabilityMismatchError);
    expect(result?.message).toMatch(/audio/i);
  });

  it('returns undefined when no media input, even if all caps are false', () => {
    const result = checkLLMCapabilities({
      model: 'gpt-3.5-turbo',
      inputContainsImage: false,
      inputContainsVideo: false,
      inputContainsAudio: false,
      capability: cap(),
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined when model is empty string (-32001 owns that path)', () => {
    const result = checkLLMCapabilities({
      model: '',
      inputContainsImage: true,
      inputContainsVideo: false,
      inputContainsAudio: false,
      capability: cap({ image_in: false }),
    });
    expect(result).toBeUndefined();
  });

  it('returns error when video+audio both present and both capped false', () => {
    const result = checkLLMCapabilities({
      model: 'some-model',
      inputContainsImage: false,
      inputContainsVideo: true,
      inputContainsAudio: true,
      capability: cap({ video_in: false, audio_in: false }),
    });
    // Behaviour guarantee: produces exactly one error, not an aggregate.
    // We don't pin which modality "wins" — only that the error is real.
    expect(result).toBeInstanceOf(LLMCapabilityMismatchError);
  });

  it('returns undefined when all modalities supported', () => {
    const result = checkLLMCapabilities({
      model: 'gemini-1.5-pro',
      inputContainsImage: true,
      inputContainsVideo: true,
      inputContainsAudio: true,
      capability: cap({ image_in: true, video_in: true, audio_in: true }),
    });
    expect(result).toBeUndefined();
  });
});
