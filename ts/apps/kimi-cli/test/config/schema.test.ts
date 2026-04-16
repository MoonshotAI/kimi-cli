import { describe, expect, it } from 'vitest';

import {
  ConfigSchema,
  HookDefSchema,
  LLMModelSchema,
  LLMProviderSchema,
  LoopControlSchema,
} from '../../src/config/schema.js';

// ---------------------------------------------------------------------------
// Empty config -- all defaults
// ---------------------------------------------------------------------------

describe('ConfigSchema defaults', () => {
  it('parses an empty object into all default values', () => {
    const config = ConfigSchema.parse({});

    expect(config.default_model).toBe('');
    expect(config.default_thinking).toBe(false);
    expect(config.default_yolo).toBe(false);
    expect(config.default_plan_mode).toBe(false);
    expect(config.default_editor).toBe('');
    expect(config.theme).toBe('dark');
    expect(config.merge_all_available_skills).toBe(false);
    expect(config.show_thinking_stream).toBe(false);

    // Nested defaults
    expect(config.loop_control.max_steps_per_turn).toBe(100);
    expect(config.loop_control.max_retries_per_step).toBe(3);
    expect(config.loop_control.max_ralph_iterations).toBe(0);
    expect(config.loop_control.reserved_context_size).toBe(50_000);
    expect(config.loop_control.compaction_trigger_ratio).toBe(0.85);

    expect(config.background.max_running_tasks).toBe(4);
    expect(config.background.read_max_bytes).toBe(30_000);
    expect(config.background.keep_alive_on_exit).toBe(false);
    expect(config.background.agent_task_timeout_s).toBe(900);

    expect(config.notifications.claim_stale_after_ms).toBe(15_000);

    expect(config.mcp.client.tool_call_timeout_ms).toBe(60_000);

    expect(config.providers).toEqual({});
    expect(config.models).toEqual({});
    expect(config.services).toEqual({});
    expect(config.hooks).toEqual([]);
  });

  it('loop_control.max_steps_per_turn defaults to 100', () => {
    const lc = LoopControlSchema.parse({});
    expect(lc.max_steps_per_turn).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Full config parsing
// ---------------------------------------------------------------------------

describe('ConfigSchema full parsing', () => {
  it('parses a complete configuration object', () => {
    const input = {
      default_model: 'my-model',
      default_thinking: true,
      default_yolo: true,
      default_plan_mode: true,
      default_editor: 'vim',
      theme: 'light',
      merge_all_available_skills: true,
      show_thinking_stream: true,
      loop_control: {
        max_steps_per_turn: 50,
        max_retries_per_step: 5,
        max_ralph_iterations: -1,
        reserved_context_size: 80_000,
        compaction_trigger_ratio: 0.9,
      },
      background: {
        max_running_tasks: 8,
        read_max_bytes: 60_000,
        notification_tail_lines: 40,
        notification_tail_chars: 6_000,
        wait_poll_interval_ms: 1000,
        worker_heartbeat_interval_ms: 10_000,
        worker_stale_after_ms: 30_000,
        kill_grace_period_ms: 4_000,
        keep_alive_on_exit: true,
        agent_task_timeout_s: 1800,
      },
      notifications: {
        claim_stale_after_ms: 30_000,
      },
      mcp: {
        client: {
          tool_call_timeout_ms: 120_000,
        },
      },
      providers: {
        myProvider: {
          type: 'openai_legacy',
          base_url: 'https://api.example.com',
          api_key: 'sk-test-key',
          env: { SOME_VAR: 'value' },
          custom_headers: { 'X-Custom': 'header' },
          oauth: { storage: 'keyring', key: 'my-key' },
        },
      },
      models: {
        myModel: {
          provider: 'myProvider',
          model: 'gpt-4',
          max_context_size: 128_000,
          capabilities: ['thinking', 'image_in'],
        },
      },
      services: {
        moonshot_search: {
          base_url: 'https://search.example.com',
          api_key: 'sk-search',
        },
        moonshot_fetch: {
          base_url: 'https://fetch.example.com',
          api_key: 'sk-fetch',
          custom_headers: { 'X-Fetch': 'yes' },
        },
      },
      hooks: [
        {
          event: 'PreToolUse',
          command: 'echo pre-tool',
          matcher: '.*',
          timeout: 60,
        },
        {
          event: 'Stop',
          command: 'echo stopped',
        },
      ],
    };

    const config = ConfigSchema.parse(input);

    expect(config.default_model).toBe('my-model');
    expect(config.default_thinking).toBe(true);
    expect(config.show_thinking_stream).toBe(true);
    expect(config.theme).toBe('light');
    expect(config.loop_control.max_steps_per_turn).toBe(50);
    expect(config.loop_control.max_ralph_iterations).toBe(-1);
    expect(config.background.max_running_tasks).toBe(8);
    expect(config.background.keep_alive_on_exit).toBe(true);
    expect(config.notifications.claim_stale_after_ms).toBe(30_000);
    expect(config.mcp.client.tool_call_timeout_ms).toBe(120_000);

    // Providers
    const provider = config.providers['myProvider'];
    expect(provider).toBeDefined();
    expect(provider!.type).toBe('openai_legacy');
    expect(provider!.api_key).toBe('sk-test-key');
    expect(provider!.oauth?.storage).toBe('keyring');

    // Models
    const model = config.models['myModel'];
    expect(model).toBeDefined();
    expect(model!.provider).toBe('myProvider');
    expect(model!.capabilities).toEqual(['thinking', 'image_in']);

    // Services
    expect(config.services.moonshot_search?.base_url).toBe('https://search.example.com');
    expect(config.services.moonshot_fetch?.api_key).toBe('sk-fetch');

    // Hooks
    expect(config.hooks).toHaveLength(2);
    expect(config.hooks[0]!.event).toBe('PreToolUse');
    expect(config.hooks[0]!.timeout).toBe(60);
    expect(config.hooks[1]!.command).toBe('echo stopped');
    expect(config.hooks[1]!.matcher).toBe(''); // default
    expect(config.hooks[1]!.timeout).toBe(30); // default
  });
});

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

describe('ConfigSchema validation errors', () => {
  it('rejects invalid theme value', () => {
    const result = ConfigSchema.safeParse({ theme: 'blue' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid hook event type', () => {
    const result = HookDefSchema.safeParse({
      event: 'InvalidEvent',
      command: 'echo test',
    });
    expect(result.success).toBe(false);
  });

  it('rejects hook timeout below 1', () => {
    const result = HookDefSchema.safeParse({
      event: 'PreToolUse',
      command: 'echo test',
      timeout: 0,
    });
    expect(result.success).toBe(false);
  });

  it('rejects hook timeout above 600', () => {
    const result = HookDefSchema.safeParse({
      event: 'PreToolUse',
      command: 'echo test',
      timeout: 601,
    });
    expect(result.success).toBe(false);
  });

  it('rejects max_steps_per_turn below 1', () => {
    const result = LoopControlSchema.safeParse({ max_steps_per_turn: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects compaction_trigger_ratio above 0.99', () => {
    const result = LoopControlSchema.safeParse({
      compaction_trigger_ratio: 1.0,
    });
    expect(result.success).toBe(false);
  });

  it('rejects compaction_trigger_ratio below 0.5', () => {
    const result = LoopControlSchema.safeParse({
      compaction_trigger_ratio: 0.3,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Providers nested object
// ---------------------------------------------------------------------------

describe('providers nested parsing', () => {
  it('parses a provider with minimal fields', () => {
    const result = LLMProviderSchema.safeParse({
      type: 'kimi',
      base_url: 'https://api.kimi.ai',
      api_key: 'sk-xxx',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.env).toBeUndefined();
      expect(result.data.custom_headers).toBeUndefined();
      expect(result.data.oauth).toBeUndefined();
    }
  });

  it('rejects a provider with invalid type', () => {
    const result = LLMProviderSchema.safeParse({
      type: 'unknown_provider',
      base_url: 'https://api.example.com',
      api_key: 'sk-xxx',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a provider missing required fields', () => {
    const result = LLMProviderSchema.safeParse({
      type: 'kimi',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Models nested object
// ---------------------------------------------------------------------------

describe('models nested parsing', () => {
  it('parses a model with all fields', () => {
    const result = LLMModelSchema.safeParse({
      provider: 'kimi',
      model: 'kimi-latest',
      max_context_size: 200_000,
      capabilities: ['thinking', 'image_in', 'video_in'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capabilities).toEqual(['thinking', 'image_in', 'video_in']);
    }
  });

  it('parses a model without optional capabilities', () => {
    const result = LLMModelSchema.safeParse({
      provider: 'kimi',
      model: 'kimi-latest',
      max_context_size: 200_000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capabilities).toBeUndefined();
    }
  });

  it('rejects invalid capability value', () => {
    const result = LLMModelSchema.safeParse({
      provider: 'kimi',
      model: 'kimi-latest',
      max_context_size: 200_000,
      capabilities: ['flying'],
    });
    expect(result.success).toBe(false);
  });
});
