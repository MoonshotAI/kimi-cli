/**
 * Phase 19 Slice B.3 — Per-provider `getCapability(model?)` table tests.
 *
 * For every provider:
 *   - Known models return the capabilities the table declares for them.
 *   - Unknown models return UNKNOWN_CAPABILITY (no throw) so the capability
 *     gate stays non-fatal when the operator uses a model the provider has
 *     not catalogued yet.
 *
 * Assertions stick to individual fields (image_in / video_in / …) rather
 * than matching the whole object so future additions (e.g. new fields in
 * `ModelCapability`) do not churn every row.
 */

import { describe, expect, it } from 'vitest';

import { UNKNOWN_CAPABILITY, type ModelCapability } from '../src/capability.js';
import { AnthropicChatProvider } from '../src/providers/anthropic.js';
import { ChaosChatProvider } from '../src/providers/chaos.js';
import { GoogleGenAIChatProvider } from '../src/providers/google-genai.js';
import { KimiChatProvider } from '../src/providers/kimi.js';
import { OpenAILegacyChatProvider } from '../src/providers/openai-legacy.js';
import { OpenAIResponsesChatProvider } from '../src/providers/openai-responses.js';
import { MockChatProvider } from '../src/mock-provider.js';

// ── KimiChatProvider ──────────────────────────────────────────────────

describe('KimiChatProvider.getCapability', () => {
  function make(model: string): KimiChatProvider {
    return new KimiChatProvider({ model, apiKey: 'test-key' });
  }

  it('kimi-for-coding → thinking + image_in + video_in + tool_use', () => {
    const cap = make('kimi-for-coding').getCapability();
    expect(cap.thinking).toBe(true);
    expect(cap.image_in).toBe(true);
    expect(cap.video_in).toBe(true);
    expect(cap.tool_use).toBe(true);
  });

  it('kimi-code → thinking + image_in + video_in + tool_use', () => {
    const cap = make('kimi-code').getCapability();
    expect(cap.thinking).toBe(true);
    expect(cap.image_in).toBe(true);
    expect(cap.video_in).toBe(true);
    expect(cap.tool_use).toBe(true);
  });

  it('kimi-k2-turbo-preview → image_in + video_in + thinking + tool_use', () => {
    const cap = make('kimi-k2-turbo-preview').getCapability();
    expect(cap.image_in).toBe(true);
    expect(cap.video_in).toBe(true);
    expect(cap.thinking).toBe(true);
    expect(cap.tool_use).toBe(true);
  });

  it('kimi-k2.5 (kimi-k2 family with version suffix) → image_in + video_in', () => {
    const cap = make('kimi-k2.5').getCapability();
    expect(cap.image_in).toBe(true);
    expect(cap.video_in).toBe(true);
    expect(cap.tool_use).toBe(true);
  });

  it('kimi-thinking-preview → thinking=true (from "thinking" substring)', () => {
    const cap = make('kimi-thinking-preview').getCapability();
    expect(cap.thinking).toBe(true);
  });

  it('explicit model arg overrides this.modelName', () => {
    const provider = make('kimi-k2-turbo-preview');
    const capForUnknown = provider.getCapability('totally-unknown-xyz');
    expect(capForUnknown.image_in).toBe(false);
    expect(capForUnknown.video_in).toBe(false);
    expect(capForUnknown.thinking).toBe(false);
  });

  it('unknown Kimi model → UNKNOWN_CAPABILITY (no throw)', () => {
    const cap = make('some-fake-model').getCapability();
    expect(cap).toEqual(UNKNOWN_CAPABILITY);
  });
});

// ── GoogleGenAIChatProvider ───────────────────────────────────────────

describe('GoogleGenAIChatProvider.getCapability', () => {
  function make(model: string): GoogleGenAIChatProvider {
    return new GoogleGenAIChatProvider({ model, apiKey: 'test-key' });
  }

  it('gemini-1.5-pro → image_in + video_in + audio_in + tool_use', () => {
    const cap = make('gemini-1.5-pro').getCapability();
    expect(cap.image_in).toBe(true);
    expect(cap.video_in).toBe(true);
    expect(cap.audio_in).toBe(true);
    expect(cap.tool_use).toBe(true);
  });

  it('gemini-1.5-flash → image_in + video_in + audio_in + tool_use', () => {
    const cap = make('gemini-1.5-flash').getCapability();
    expect(cap.image_in).toBe(true);
    expect(cap.video_in).toBe(true);
    expect(cap.audio_in).toBe(true);
    expect(cap.tool_use).toBe(true);
  });

  it('gemini-2.0-flash → image_in + video_in + audio_in + tool_use', () => {
    const cap = make('gemini-2.0-flash').getCapability();
    expect(cap.image_in).toBe(true);
    expect(cap.video_in).toBe(true);
    expect(cap.audio_in).toBe(true);
    expect(cap.tool_use).toBe(true);
  });

  it('unknown Gemini model → UNKNOWN_CAPABILITY (no throw)', () => {
    const cap = make('gemini-not-real-xyz').getCapability();
    expect(cap).toEqual(UNKNOWN_CAPABILITY);
  });

  it('non-gemini model name → UNKNOWN_CAPABILITY', () => {
    const cap = make('claude-3-5-sonnet').getCapability();
    expect(cap).toEqual(UNKNOWN_CAPABILITY);
  });
});

// ── AnthropicChatProvider ─────────────────────────────────────────────

describe('AnthropicChatProvider.getCapability', () => {
  function make(model: string): AnthropicChatProvider {
    return new AnthropicChatProvider({ model, apiKey: 'test-key', stream: false });
  }

  it('claude-3-5-sonnet → image_in + tool_use, audio_in=false', () => {
    const cap = make('claude-3-5-sonnet').getCapability();
    expect(cap.image_in).toBe(true);
    expect(cap.tool_use).toBe(true);
    expect(cap.audio_in).toBe(false);
  });

  it('claude-3-haiku → image_in + tool_use, audio_in=false, thinking=false', () => {
    // Claude 3 Haiku supports vision (all Claude 3.x share vision support);
    // Anthropic has no audio models; thinking is a Claude 4 feature.
    const cap = make('claude-3-haiku').getCapability();
    expect(cap.image_in).toBe(true);
    expect(cap.tool_use).toBe(true);
    expect(cap.audio_in).toBe(false);
    expect(cap.thinking).toBe(false);
  });

  it('claude-opus-4 → image_in + thinking + tool_use', () => {
    const cap = make('claude-opus-4').getCapability();
    expect(cap.image_in).toBe(true);
    expect(cap.thinking).toBe(true);
    expect(cap.tool_use).toBe(true);
  });

  it('no Anthropic model supports audio_in', () => {
    // Sanity: Anthropic has no audio-input models today. If one ships later
    // and this fails, update the table — but make it a conscious decision.
    for (const m of ['claude-3-5-sonnet', 'claude-3-haiku', 'claude-opus-4']) {
      expect(make(m).getCapability().audio_in).toBe(false);
    }
  });

  it('unknown Anthropic model → UNKNOWN_CAPABILITY', () => {
    const cap = make('claude-not-real').getCapability();
    expect(cap).toEqual(UNKNOWN_CAPABILITY);
  });
});

// ── OpenAILegacyChatProvider ──────────────────────────────────────────

describe('OpenAILegacyChatProvider.getCapability', () => {
  function make(model: string): OpenAILegacyChatProvider {
    return new OpenAILegacyChatProvider({ model, apiKey: 'test-key' });
  }

  it('gpt-4o → image_in + tool_use', () => {
    const cap = make('gpt-4o').getCapability();
    expect(cap.image_in).toBe(true);
    expect(cap.tool_use).toBe(true);
  });

  it('gpt-3.5-turbo → image_in=false, tool_use=true', () => {
    const cap = make('gpt-3.5-turbo').getCapability();
    expect(cap.image_in).toBe(false);
    expect(cap.tool_use).toBe(true);
  });

  it('o1 → thinking=true, tool_use=true', () => {
    const cap = make('o1').getCapability();
    expect(cap.thinking).toBe(true);
    expect(cap.tool_use).toBe(true);
  });

  it('unknown OpenAI-legacy model → UNKNOWN_CAPABILITY', () => {
    const cap = make('gpt-mystery').getCapability();
    expect(cap).toEqual(UNKNOWN_CAPABILITY);
  });
});

// ── OpenAIResponsesChatProvider ───────────────────────────────────────

describe('OpenAIResponsesChatProvider.getCapability', () => {
  function make(model: string): OpenAIResponsesChatProvider {
    return new OpenAIResponsesChatProvider({ model, apiKey: 'test-key' });
  }

  it('gpt-4.1 → image_in + tool_use (Responses flagship)', () => {
    const cap = make('gpt-4.1').getCapability();
    expect(cap.image_in).toBe(true);
    expect(cap.tool_use).toBe(true);
  });

  it('o1 → thinking=true, tool_use=true', () => {
    const cap = make('o1').getCapability();
    expect(cap.thinking).toBe(true);
    expect(cap.tool_use).toBe(true);
  });

  it('o3-mini → thinking=true', () => {
    const cap = make('o3-mini').getCapability();
    expect(cap.thinking).toBe(true);
  });

  it('unknown Responses model → UNKNOWN_CAPABILITY', () => {
    const cap = make('gpt-mystery').getCapability();
    expect(cap).toEqual(UNKNOWN_CAPABILITY);
  });
});

// ── ChaosChatProvider ─────────────────────────────────────────────────

describe('ChaosChatProvider.getCapability', () => {
  it('returns UNKNOWN_CAPABILITY regardless of inner provider', () => {
    const inner = new KimiChatProvider({ model: 'kimi-k2-turbo-preview', apiKey: 'test-key' });
    const chaos = new ChaosChatProvider(inner, { errorProbability: 0 });
    const cap = chaos.getCapability();
    expect(cap).toEqual(UNKNOWN_CAPABILITY);
  });

  it('returns UNKNOWN_CAPABILITY even when asked about a specific model', () => {
    const inner = new MockChatProvider([]);
    const chaos = new ChaosChatProvider(inner, { errorProbability: 0 });
    const cap: ModelCapability = chaos.getCapability('gemini-1.5-pro');
    expect(cap.image_in).toBe(false);
    expect(cap.video_in).toBe(false);
    expect(cap.audio_in).toBe(false);
    expect(cap.thinking).toBe(false);
    expect(cap.tool_use).toBe(false);
    expect(cap.max_context_tokens).toBe(0);
  });
});
