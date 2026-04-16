/**
 * env_overrides tests — Python augment_provider_with_env_vars() parity.
 *
 * Only the provider + model resolved from `config.defaultModel` should
 * receive the overrides — unselected providers stay untouched. Overrides
 * are non-persistent; the input config object is not mutated.
 */

import { describe, expect, it } from 'vitest';

import { applyEnvOverrides } from '../../src/config/env-overrides.js';
import type { KimiConfig } from '../../src/config/schema.js';

function baseConfig(): KimiConfig {
  return {
    defaultProvider: 'kimi-internal',
    defaultModel: 'kimi-k2-5',
    providers: {
      'kimi-internal': {
        type: 'kimi',
        baseUrl: 'https://config-url/v1',
        apiKey: 'config-key',
        defaultModel: 'kimi-k2.5',
      },
      'other-kimi': {
        type: 'kimi',
        baseUrl: 'https://other-url/v1',
        apiKey: 'other-key',
      },
      'openai-main': {
        type: 'openai',
        baseUrl: 'https://openai-url/v1',
        apiKey: 'openai-key',
      },
    },
    models: {
      'kimi-k2-5': {
        provider: 'kimi-internal',
        model: 'kimi-k2.5',
        maxContextSize: 250000,
      },
    },
  };
}

describe('applyEnvOverrides — kimi provider', () => {
  it('KIMI_BASE_URL overrides selected provider baseUrl', () => {
    const out = applyEnvOverrides(baseConfig(), { KIMI_BASE_URL: 'https://env-url/v1' });
    expect(out.providers['kimi-internal']?.baseUrl).toBe('https://env-url/v1');
  });

  it('KIMI_API_KEY overrides selected provider apiKey', () => {
    const out = applyEnvOverrides(baseConfig(), { KIMI_API_KEY: 'env-key' });
    expect(out.providers['kimi-internal']?.apiKey).toBe('env-key');
  });

  it('KIMI_MODEL_NAME overrides resolved model name', () => {
    const out = applyEnvOverrides(baseConfig(), { KIMI_MODEL_NAME: 'kimi-latest' });
    expect(out.models?.['kimi-k2-5']?.model).toBe('kimi-latest');
  });

  it('KIMI_MODEL_MAX_CONTEXT_SIZE overrides maxContextSize (numeric parse)', () => {
    const out = applyEnvOverrides(baseConfig(), { KIMI_MODEL_MAX_CONTEXT_SIZE: '500000' });
    expect(out.models?.['kimi-k2-5']?.maxContextSize).toBe(500000);
  });

  it('KIMI_MODEL_CAPABILITIES overrides capabilities (comma-split + filtered)', () => {
    const out = applyEnvOverrides(baseConfig(), {
      KIMI_MODEL_CAPABILITIES: 'thinking, image_in, bogus, video_in',
    });
    const caps = out.models?.['kimi-k2-5']?.capabilities;
    expect(caps).toBeDefined();
    expect(caps!.sort()).toEqual(['image_in', 'thinking', 'video_in']);
  });

  it('leaves unselected providers untouched', () => {
    const out = applyEnvOverrides(baseConfig(), { KIMI_BASE_URL: 'https://env-url/v1' });
    expect(out.providers['other-kimi']?.baseUrl).toBe('https://other-url/v1');
  });

  it('does not mutate the input config', () => {
    const input = baseConfig();
    applyEnvOverrides(input, { KIMI_BASE_URL: 'https://env-url/v1' });
    expect(input.providers['kimi-internal']?.baseUrl).toBe('https://config-url/v1');
  });

  it('skips overrides when env vars are empty strings', () => {
    const out = applyEnvOverrides(baseConfig(), {
      KIMI_BASE_URL: '',
      KIMI_API_KEY: '',
      KIMI_MODEL_NAME: '',
      KIMI_MODEL_MAX_CONTEXT_SIZE: '',
      KIMI_MODEL_CAPABILITIES: '',
    });
    expect(out.providers['kimi-internal']?.baseUrl).toBe('https://config-url/v1');
  });

  it('skips overrides when env vars are undefined', () => {
    const out = applyEnvOverrides(baseConfig(), {});
    expect(out.providers['kimi-internal']?.baseUrl).toBe('https://config-url/v1');
  });

  it('returns the input reference when nothing changes (optimisation)', () => {
    const input = baseConfig();
    const out = applyEnvOverrides(input, {});
    expect(out).toBe(input);
  });

  it('bad KIMI_MODEL_MAX_CONTEXT_SIZE (not a number) is ignored', () => {
    const out = applyEnvOverrides(baseConfig(), { KIMI_MODEL_MAX_CONTEXT_SIZE: 'not-a-number' });
    expect(out.models?.['kimi-k2-5']?.maxContextSize).toBe(250000);
  });
});

describe('applyEnvOverrides — openai provider', () => {
  function openaiConfig(): KimiConfig {
    return {
      ...baseConfig(),
      defaultProvider: 'openai-main',
      defaultModel: 'gpt-5',
      models: {
        'gpt-5': { provider: 'openai-main', model: 'gpt-5' },
      },
    };
  }

  it('OPENAI_BASE_URL overrides selected openai provider baseUrl', () => {
    const out = applyEnvOverrides(openaiConfig(), { OPENAI_BASE_URL: 'https://env/v1' });
    expect(out.providers['openai-main']?.baseUrl).toBe('https://env/v1');
  });

  it('OPENAI_API_KEY overrides selected openai provider apiKey', () => {
    const out = applyEnvOverrides(openaiConfig(), { OPENAI_API_KEY: 'env-key' });
    expect(out.providers['openai-main']?.apiKey).toBe('env-key');
  });

  it('works for openai_responses type too', () => {
    const cfg = openaiConfig();
    cfg.providers['openai-main']!.type = 'openai_responses';
    const out = applyEnvOverrides(cfg, { OPENAI_BASE_URL: 'https://env/v1' });
    expect(out.providers['openai-main']?.baseUrl).toBe('https://env/v1');
  });

  it('KIMI_* env vars do not affect openai provider', () => {
    const out = applyEnvOverrides(openaiConfig(), { KIMI_BASE_URL: 'https://wrong/v1' });
    expect(out.providers['openai-main']?.baseUrl).toBe('https://openai-url/v1');
  });
});

describe('applyEnvOverrides — provider resolution', () => {
  it('falls back to defaultProvider when defaultModel is absent from models map', () => {
    const cfg = baseConfig();
    cfg.defaultModel = 'some-unknown-alias';
    const out = applyEnvOverrides(cfg, { KIMI_BASE_URL: 'https://env/v1' });
    // Should override defaultProvider (kimi-internal) as fallback
    expect(out.providers['kimi-internal']?.baseUrl).toBe('https://env/v1');
  });

  it('does nothing when neither defaultModel nor defaultProvider resolves', () => {
    const cfg: KimiConfig = {
      providers: { 'kimi-a': { type: 'kimi', apiKey: 'k' } },
    };
    const out = applyEnvOverrides(cfg, { KIMI_BASE_URL: 'https://env/v1' });
    expect(out.providers['kimi-a']?.baseUrl).toBeUndefined();
  });
});

describe('applyEnvOverrides — requestedModel target (M2 fix)', () => {
  function multiModelConfig(): KimiConfig {
    return {
      defaultProvider: 'kimi-default',
      defaultModel: 'default-alias',
      providers: {
        'kimi-default': {
          type: 'kimi',
          baseUrl: 'https://default/v1',
          apiKey: 'default-key',
        },
        'kimi-other': {
          type: 'kimi',
          baseUrl: 'https://other/v1',
          apiKey: 'other-key',
        },
      },
      models: {
        'default-alias': { provider: 'kimi-default', model: 'k25' },
        'other-alias': { provider: 'kimi-other', model: 'k25-other' },
      },
    };
  }

  it('overrides target requestedModel provider when requestedModel given', () => {
    const out = applyEnvOverrides(
      multiModelConfig(),
      { KIMI_BASE_URL: 'https://env/v1' },
      'other-alias',
    );
    expect(out.providers['kimi-other']?.baseUrl).toBe('https://env/v1');
    // default provider should be untouched
    expect(out.providers['kimi-default']?.baseUrl).toBe('https://default/v1');
  });

  it('falls back to defaultModel when requestedModel is undefined', () => {
    const out = applyEnvOverrides(
      multiModelConfig(),
      { KIMI_BASE_URL: 'https://env/v1' },
    );
    expect(out.providers['kimi-default']?.baseUrl).toBe('https://env/v1');
    expect(out.providers['kimi-other']?.baseUrl).toBe('https://other/v1');
  });

  it('overrides model fields on requestedModel alias', () => {
    const out = applyEnvOverrides(
      multiModelConfig(),
      { KIMI_MODEL_NAME: 'kimi-overridden' },
      'other-alias',
    );
    expect(out.models?.['other-alias']?.model).toBe('kimi-overridden');
    expect(out.models?.['default-alias']?.model).toBe('k25');
  });
});
