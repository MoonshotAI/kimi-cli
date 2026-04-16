/**
 * Provider factory — createProvider, resolveModelAlias, createProviderFromConfig tests.
 */

import { describe, expect, it } from 'vitest';

import {
  ProviderFactoryError,
  createProvider,
  createProviderFromConfig,
  resolveModelAlias,
} from '../../src/config/provider-factory.js';
import type { KimiConfig, ProviderConfig } from '../../src/config/schema.js';

// ── createProvider ──────────────────────────────────────────────────────

describe('createProvider', () => {
  it('creates AnthropicChatProvider', () => {
    const config: ProviderConfig = {
      type: 'anthropic',
      apiKey: 'test-key',
      defaultModel: 'k25',
    };
    const provider = createProvider('ant', config);
    expect(provider.name).toBe('anthropic');
    expect(provider.modelName).toBe('k25');
  });

  it('creates OpenAILegacyChatProvider', () => {
    const config: ProviderConfig = {
      type: 'openai',
      apiKey: 'test-key',
      defaultModel: 'gpt-4o',
    };
    const provider = createProvider('oai', config);
    expect(provider.name).toBe('openai');
    expect(provider.modelName).toBe('gpt-4o');
  });

  it('creates KimiChatProvider', () => {
    const config: ProviderConfig = {
      type: 'kimi',
      apiKey: 'test-key',
      defaultModel: 'moonshot-v1-auto',
    };
    const provider = createProvider('kimi', config);
    expect(provider.name).toBe('kimi');
    expect(provider.modelName).toBe('moonshot-v1-auto');
  });

  it('creates GoogleGenAIChatProvider', () => {
    const config: ProviderConfig = {
      type: 'google-genai',
      apiKey: 'test-key',
      defaultModel: 'gemini-2.5-flash',
    };
    const provider = createProvider('google', config);
    expect(provider.name).toBe('google_genai');
    expect(provider.modelName).toBe('gemini-2.5-flash');
  });

  it('modelOverride takes priority over defaultModel', () => {
    const config: ProviderConfig = {
      type: 'anthropic',
      apiKey: 'test-key',
      defaultModel: 'k25',
    };
    const provider = createProvider('ant', config, 'k25');
    expect(provider.modelName).toBe('k25');
  });

  it('throws when no model specified', () => {
    const config: ProviderConfig = {
      type: 'anthropic',
      apiKey: 'test-key',
    };
    expect(() => createProvider('ant', config)).toThrow(ProviderFactoryError);
    expect(() => createProvider('ant', config)).toThrow(/no model specified/);
  });

  it('throws for each provider type when no model', () => {
    for (const type of ['anthropic', 'openai', 'kimi', 'google-genai'] as const) {
      const config: ProviderConfig = { type, apiKey: 'test-key' };
      expect(() => createProvider('p', config)).toThrow(ProviderFactoryError);
    }
  });
});

// ── resolveModelAlias ───────────────────────────────────────────────────

describe('resolveModelAlias', () => {
  const config: KimiConfig = {
    providers: {
      anthropic: { type: 'anthropic', apiKey: 'k' },
      openai: { type: 'openai', apiKey: 'k' },
    },
    defaultProvider: 'anthropic',
    models: {
      sonnet: { provider: 'anthropic', model: 'k25' },
      gpt4: { provider: 'openai', model: 'gpt-4o' },
    },
  };

  it('resolves known alias', () => {
    const result = resolveModelAlias(config, 'sonnet');
    expect(result).toEqual({
      providerName: 'anthropic',
      modelName: 'k25',
    });
  });

  it('resolves another alias', () => {
    const result = resolveModelAlias(config, 'gpt4');
    expect(result).toEqual({
      providerName: 'openai',
      modelName: 'gpt-4o',
    });
  });

  it('falls back to defaultProvider for unknown alias', () => {
    const result = resolveModelAlias(config, 'some-raw-model');
    expect(result).toEqual({
      providerName: 'anthropic',
      modelName: 'some-raw-model',
    });
  });

  it('returns undefined when no alias and no defaultProvider', () => {
    const noDefault: KimiConfig = {
      providers: {},
    };
    expect(resolveModelAlias(noDefault, 'anything')).toBeUndefined();
  });
});

// ── createProviderFromConfig ────────────────────────────────────────────

describe('createProviderFromConfig', () => {
  const config: KimiConfig = {
    providers: {
      anthropic: {
        type: 'anthropic',
        apiKey: 'ant-key',
        defaultModel: 'k25',
      },
      openai: {
        type: 'openai',
        apiKey: 'oai-key',
        defaultModel: 'gpt-4o',
      },
    },
    defaultProvider: 'anthropic',
    defaultModel: 'sonnet',
    models: {
      sonnet: { provider: 'anthropic', model: 'k25' },
      gpt4: { provider: 'openai', model: 'gpt-4o' },
    },
  };

  it('resolves alias to correct provider', () => {
    const provider = createProviderFromConfig(config, 'sonnet');
    expect(provider.name).toBe('anthropic');
    expect(provider.modelName).toBe('k25');
  });

  it('resolves alias to different provider', () => {
    const provider = createProviderFromConfig(config, 'gpt4');
    expect(provider.name).toBe('openai');
    expect(provider.modelName).toBe('gpt-4o');
  });

  it('uses defaultModel when no model specified', () => {
    const provider = createProviderFromConfig(config);
    // defaultModel is "sonnet" which is an alias → anthropic
    expect(provider.name).toBe('anthropic');
    expect(provider.modelName).toBe('k25');
  });

  it('falls back to defaultProvider for raw model name', () => {
    const provider = createProviderFromConfig(config, 'k25');
    expect(provider.name).toBe('anthropic');
    expect(provider.modelName).toBe('k25');
  });

  it('throws when alias references unconfigured provider', () => {
    const badConfig: KimiConfig = {
      providers: {},
      models: {
        ghost: { provider: 'nonexistent', model: 'x' },
      },
    };
    expect(() => createProviderFromConfig(badConfig, 'ghost')).toThrow(ProviderFactoryError);
    expect(() => createProviderFromConfig(badConfig, 'ghost')).toThrow(/not configured/);
  });

  it('throws when no provider can be determined', () => {
    const emptyConfig: KimiConfig = {
      providers: {},
    };
    expect(() => createProviderFromConfig(emptyConfig)).toThrow(ProviderFactoryError);
    expect(() => createProviderFromConfig(emptyConfig)).toThrow(/No provider could be determined/);
  });

  it('throws when defaultProvider is not in providers map', () => {
    const badConfig: KimiConfig = {
      providers: {},
      defaultProvider: 'missing',
    };
    expect(() => createProviderFromConfig(badConfig, 'some-model')).toThrow(ProviderFactoryError);
    expect(() => createProviderFromConfig(badConfig, 'some-model')).toThrow(/not configured/);
  });
});

// ── OpenAI Responses and VertexAI provider types ─────────────────────

describe('createProvider — openai_responses and vertexai', () => {
  it('creates OpenAIResponsesChatProvider', () => {
    const config: ProviderConfig = {
      type: 'openai_responses',
      apiKey: 'test-key',
      baseUrl: 'https://openai.app.msh.team/raw/x/v1',
      defaultModel: 'gpt-5',
    };
    const provider = createProvider('qianxun', config);
    expect(provider.modelName).toBe('gpt-5');
  });

  it('creates GoogleGenAIChatProvider for vertexai with vertexai flag', () => {
    const config: ProviderConfig = {
      type: 'vertexai',
      apiKey: 'test-key',
      defaultModel: 'gemini-3-pro',
    };
    const provider = createProvider('vertex', config);
    expect(provider.modelName).toBe('gemini-3-pro');
  });
});

// ── Anthropic baseUrl passthrough ────────────────────────────────────

describe('createProvider — Anthropic baseUrl passthrough', () => {
  it('passes baseUrl to Anthropic provider', () => {
    const config: ProviderConfig = {
      type: 'anthropic',
      apiKey: 'test-key',
      baseUrl: 'https://api.kimi.com/coding',
      defaultModel: 'claude-sonnet',
    };
    const provider = createProvider('anthropic-kimi', config);
    expect(provider.name).toBe('anthropic');
    expect(provider.modelName).toBe('claude-sonnet');
  });

  it('passes baseUrl to google-genai provider', () => {
    const config: ProviderConfig = {
      type: 'google-genai',
      apiKey: 'test-key',
      baseUrl: 'https://custom-google-proxy.com',
      defaultModel: 'gemini-2.5-flash',
    };
    const provider = createProvider('google-proxy', config);
    expect(provider.name).toBe('google_genai');
    expect(provider.modelName).toBe('gemini-2.5-flash');
  });
});

// ── OAuth provider check ──────────────────────────────────────────────

describe('createProvider — OAuth check', () => {
  it('throws when provider has oauth but no apiKey', () => {
    const config: ProviderConfig = {
      type: 'kimi',
      apiKey: '',
      baseUrl: 'https://api.kimi.com/v1',
      oauth: { storage: 'file', key: 'oauth/test' },
    };
    expect(() => createProvider('managed:test', config, 'test-model')).toThrow(
      ProviderFactoryError,
    );
    expect(() => createProvider('managed:test', config, 'test-model')).toThrow(/OAuth/);
  });

  it('throws when provider has oauth and apiKey is undefined', () => {
    const config: ProviderConfig = {
      type: 'kimi',
      baseUrl: 'https://api.kimi.com/v1',
      oauth: { storage: 'file', key: 'oauth/test' },
    };
    expect(() => createProvider('managed:test', config, 'test-model')).toThrow(
      ProviderFactoryError,
    );
  });

  it('allows provider with oauth when apiKey is present', () => {
    const config: ProviderConfig = {
      type: 'kimi',
      apiKey: 'real-api-key',
      baseUrl: 'https://api.moonshot.cn/v1',
      oauth: { storage: 'file', key: 'oauth/test' },
    };
    const provider = createProvider('managed:moonshot', config, 'test-model');
    expect(provider.name).toBe('kimi');
  });

  it('allows provider without oauth normally', () => {
    const config: ProviderConfig = {
      type: 'kimi',
      apiKey: 'test-key',
      baseUrl: 'https://api.msh.team/v1',
    };
    const provider = createProvider('kimi-internal', config, 'test-model');
    expect(provider.name).toBe('kimi');
  });
});
