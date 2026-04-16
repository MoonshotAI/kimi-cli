/**
 * Config schema — validation tests.
 */

import { describe, expect, it } from 'vitest';

import {
  KimiConfigSchema,
  ModelAliasSchema,
  OAuthRefSchema,
  ProviderConfigSchema,
  getDefaultConfig,
} from '../../src/config/schema.js';

describe('KimiConfigSchema', () => {
  it('accepts empty object and fills defaults', () => {
    const result = KimiConfigSchema.parse({});
    expect(result.providers).toEqual({});
    expect(result.defaultProvider).toBeUndefined();
    expect(result.defaultModel).toBeUndefined();
    expect(result.models).toBeUndefined();
    expect(result.thinking).toBeUndefined();
    expect(result.planMode).toBeUndefined();
    expect(result.yolo).toBeUndefined();
  });

  it('validates a full config', () => {
    const result = KimiConfigSchema.parse({
      providers: {
        myAnthropic: { type: 'anthropic', apiKey: 'sk-ant-xxx', defaultModel: 'k25' },
        myOpenAI: { type: 'openai', apiKey: 'sk-xxx', baseUrl: 'https://api.openai.com/v1' },
      },
      defaultProvider: 'myAnthropic',
      defaultModel: 'sonnet',
      models: {
        sonnet: { provider: 'myAnthropic', model: 'k25' },
      },
      thinking: { mode: 'auto', effort: 'high' },
      planMode: true,
      yolo: false,
    });
    expect(result.providers['myAnthropic']?.type).toBe('anthropic');
    expect(result.providers['myOpenAI']?.baseUrl).toBe('https://api.openai.com/v1');
    expect(result.models?.['sonnet']?.provider).toBe('myAnthropic');
    expect(result.thinking?.mode).toBe('auto');
    expect(result.planMode).toBe(true);
  });

  it('rejects invalid provider type', () => {
    expect(() =>
      KimiConfigSchema.parse({
        providers: { bad: { type: 'invalid-provider' } },
      }),
    ).toThrow();
  });

  it('rejects invalid thinking mode', () => {
    expect(() =>
      KimiConfigSchema.parse({
        thinking: { mode: 'turbo' },
      }),
    ).toThrow();
  });

  it('accepts all four provider types', () => {
    for (const type of ['anthropic', 'openai', 'kimi', 'google-genai'] as const) {
      const result = KimiConfigSchema.parse({
        providers: { p: { type } },
      });
      expect(result.providers['p']?.type).toBe(type);
    }
  });
});

describe('getDefaultConfig', () => {
  it('returns valid config with empty providers', () => {
    const config = getDefaultConfig();
    expect(config.providers).toEqual({});
    // Should pass schema validation
    expect(() => KimiConfigSchema.parse(config)).not.toThrow();
  });
});

// ── Extended provider types ───────────────────────────────────────────

describe('KimiConfigSchema — extended types', () => {
  it('accepts all six provider types', () => {
    for (const type of [
      'anthropic',
      'openai',
      'kimi',
      'google-genai',
      'openai_responses',
      'vertexai',
    ] as const) {
      const result = KimiConfigSchema.parse({
        providers: { p: { type } },
      });
      expect(result.providers['p']?.type).toBe(type);
    }
  });

  it('accepts new top-level fields from Python config', () => {
    const result = KimiConfigSchema.parse({
      defaultThinking: true,
      defaultYolo: false,
      defaultPlanMode: false,
      defaultEditor: 'vim',
      theme: 'dark',
      hooks: [],
      mergeAllAvailableSkills: false,
      showThinkingStream: true,
    });
    expect(result.defaultThinking).toBe(true);
    expect(result.defaultYolo).toBe(false);
    expect(result.defaultPlanMode).toBe(false);
    expect(result.defaultEditor).toBe('vim');
    expect(result.theme).toBe('dark');
    expect(result.hooks).toEqual([]);
    expect(result.mergeAllAvailableSkills).toBe(false);
    expect(result.showThinkingStream).toBe(true);
  });

  it('accepts raw field', () => {
    const result = KimiConfigSchema.parse({
      raw: { loop_control: { max_steps_per_turn: 100 } },
    });
    expect(result.raw).toBeDefined();
    expect((result.raw!['loop_control'] as Record<string, unknown>)['max_steps_per_turn']).toBe(
      100,
    );
  });
});

// ── OAuth ref schema ──────────────────────────────────────────────────

describe('OAuthRefSchema', () => {
  it('accepts valid oauth ref', () => {
    const result = OAuthRefSchema.parse({ storage: 'file', key: 'oauth/kimi-code' });
    expect(result.storage).toBe('file');
    expect(result.key).toBe('oauth/kimi-code');
  });

  it('accepts empty object', () => {
    const result = OAuthRefSchema.parse({});
    expect(result.storage).toBeUndefined();
    expect(result.key).toBeUndefined();
  });
});

// ── Provider config with OAuth ────────────────────────────────────────

describe('ProviderConfigSchema — OAuth', () => {
  it('accepts provider with oauth field', () => {
    const result = ProviderConfigSchema.parse({
      type: 'kimi',
      apiKey: 'sk-test',
      oauth: { storage: 'file', key: 'oauth/test' },
    });
    expect(result.oauth).toBeDefined();
    expect(result.oauth!.storage).toBe('file');
  });

  it('accepts provider without oauth field', () => {
    const result = ProviderConfigSchema.parse({
      type: 'kimi',
      apiKey: 'sk-test',
    });
    expect(result.oauth).toBeUndefined();
  });
});

// ── Model alias extensions ────────────────────────────────────────────

describe('ModelAliasSchema — extensions', () => {
  it('accepts maxContextSize and capabilities', () => {
    const result = ModelAliasSchema.parse({
      provider: 'kimi',
      model: 'kimi-k2.5',
      maxContextSize: 262144,
      capabilities: ['thinking', 'image_in', 'video_in'],
    });
    expect(result.maxContextSize).toBe(262144);
    expect(result.capabilities).toEqual(['thinking', 'image_in', 'video_in']);
  });

  it('allows omitting maxContextSize and capabilities', () => {
    const result = ModelAliasSchema.parse({
      provider: 'anthropic',
      model: 'claude-sonnet',
    });
    expect(result.maxContextSize).toBeUndefined();
    expect(result.capabilities).toBeUndefined();
  });
});
