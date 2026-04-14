import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigLoadError, loadConfig, getDefaultConfig } from '../../src/config/loader.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const originalEnv = { ...process.env };
let testDir: string;

beforeEach(() => {
  // Create a unique temp directory for each test.
  testDir = join(tmpdir(), `kimi-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });

  // Point KIMI_SHARE_DIR to our temp dir so default config path is isolated.
  process.env['KIMI_SHARE_DIR'] = testDir;
});

afterEach(() => {
  process.env = { ...originalEnv };
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // best effort cleanup
  }
});

// ---------------------------------------------------------------------------
// Loading from TOML string (--config)
// ---------------------------------------------------------------------------

describe('loadConfig with inline --config string', () => {
  it('loads a TOML string', () => {
    const result = loadConfig({
      config: 'theme = "light"\ndefault_thinking = true',
    });

    expect(result.source).toBe('inline');
    expect(result.config.theme).toBe('light');
    expect(result.config.default_thinking).toBe(true);
    // Other fields should have defaults
    expect(result.config.default_model).toBe('');
  });

  it('loads a JSON string', () => {
    const result = loadConfig({
      config: '{"theme": "light", "default_yolo": true}',
    });

    expect(result.source).toBe('inline');
    expect(result.config.theme).toBe('light');
    expect(result.config.default_yolo).toBe(true);
  });

  it('throws on empty --config string', () => {
    expect(() => loadConfig({ config: '' })).toThrow(ConfigLoadError);
    expect(() => loadConfig({ config: '   ' })).toThrow(ConfigLoadError);
  });

  it('throws on invalid TOML/JSON string', () => {
    expect(() => loadConfig({ config: '{{invalid' })).toThrow(ConfigLoadError);
  });

  it('throws on valid TOML but invalid config values', () => {
    expect(() =>
      loadConfig({ config: 'theme = "blue"' }),
    ).toThrow(ConfigLoadError);
  });
});

// ---------------------------------------------------------------------------
// Loading from file (--config-file)
// ---------------------------------------------------------------------------

describe('loadConfig with --config-file', () => {
  it('loads a TOML file', () => {
    const filePath = join(testDir, 'custom.toml');
    writeFileSync(filePath, 'default_model = "my-model"\ntheme = "light"');

    const result = loadConfig({ configFile: filePath });

    expect(result.source).toBe('file');
    expect(result.filePath).toBe(filePath);
    expect(result.config.default_model).toBe('my-model');
    expect(result.config.theme).toBe('light');
  });

  it('loads a JSON file', () => {
    const filePath = join(testDir, 'custom.json');
    writeFileSync(filePath, JSON.stringify({ default_editor: 'nano' }));

    const result = loadConfig({ configFile: filePath });

    expect(result.source).toBe('file');
    expect(result.config.default_editor).toBe('nano');
  });

  it('throws when file does not exist', () => {
    expect(() =>
      loadConfig({ configFile: join(testDir, 'nonexistent.toml') }),
    ).toThrow(ConfigLoadError);
  });

  it('throws on invalid TOML in file', () => {
    const filePath = join(testDir, 'bad.toml');
    writeFileSync(filePath, '{{{{');
    expect(() => loadConfig({ configFile: filePath })).toThrow(ConfigLoadError);
  });
});

// ---------------------------------------------------------------------------
// Default path (no flags)
// ---------------------------------------------------------------------------

describe('loadConfig with default path', () => {
  it('creates default config when file does not exist', () => {
    const result = loadConfig({});

    expect(result.source).toBe('default');
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings[0]).toMatch(/Created default config/);

    // The file should now exist
    const configPath = join(testDir, 'config.toml');
    expect(existsSync(configPath)).toBe(true);

    // Config should be all defaults
    expect(result.config.theme).toBe('dark');
    expect(result.config.default_model).toBe('');
  });

  it('loads existing default config file', () => {
    // Write a config file first
    const configPath = join(testDir, 'config.toml');
    writeFileSync(configPath, 'theme = "light"');

    const result = loadConfig({});

    expect(result.source).toBe('default');
    expect(result.config.theme).toBe('light');
    expect(result.filePath).toBe(configPath);
  });

  it('falls back to defaults on invalid default config file', () => {
    const configPath = join(testDir, 'config.toml');
    writeFileSync(configPath, 'theme = "pink"');

    const result = loadConfig({});

    expect(result.source).toBe('default');
    // Should use defaults and produce a warning
    expect(result.config.theme).toBe('dark');
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings[0]).toMatch(/Invalid configuration/);
  });
});

// ---------------------------------------------------------------------------
// KIMI_SHARE_DIR override
// ---------------------------------------------------------------------------

describe('KIMI_SHARE_DIR override', () => {
  it('uses KIMI_SHARE_DIR for default config path', () => {
    const customDir = join(testDir, 'custom-share');
    mkdirSync(customDir, { recursive: true });
    process.env['KIMI_SHARE_DIR'] = customDir;

    const result = loadConfig({});

    expect(result.filePath).toBe(join(customDir, 'config.toml'));
    expect(existsSync(join(customDir, 'config.toml'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CLI --config override priority
// ---------------------------------------------------------------------------

describe('priority: --config overrides default file', () => {
  it('inline config takes priority even when default file exists', () => {
    // Write a config file with theme=light
    const configPath = join(testDir, 'config.toml');
    writeFileSync(configPath, 'theme = "light"');

    // But pass inline config with theme=dark
    const result = loadConfig({ config: 'theme = "dark"' });

    expect(result.source).toBe('inline');
    expect(result.config.theme).toBe('dark');
  });
});

// ---------------------------------------------------------------------------
// getDefaultConfig
// ---------------------------------------------------------------------------

describe('getDefaultConfig', () => {
  it('returns a valid Config with all defaults', () => {
    const config = getDefaultConfig();

    expect(config.default_model).toBe('');
    expect(config.theme).toBe('dark');
    expect(config.loop_control.max_steps_per_turn).toBe(100);
    expect(config.hooks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Full config round-trip: write TOML -> load
// ---------------------------------------------------------------------------

describe('TOML round-trip', () => {
  it('loads a comprehensive TOML config', () => {
    const toml = `
default_model = "my-model"
default_thinking = true
default_yolo = false
default_plan_mode = true
default_editor = "code --wait"
theme = "light"
merge_all_available_skills = true

[loop_control]
max_steps_per_turn = 200
max_retries_per_step = 5
max_ralph_iterations = -1
reserved_context_size = 80000
compaction_trigger_ratio = 0.9

[background]
max_running_tasks = 8
read_max_bytes = 60000
keep_alive_on_exit = true
agent_task_timeout_s = 1800

[notifications]
claim_stale_after_ms = 30000

[mcp.client]
tool_call_timeout_ms = 120000

[providers.myProvider]
type = "openai_legacy"
base_url = "https://api.example.com"
api_key = "sk-test"

[providers.myProvider.oauth]
storage = "keyring"
key = "my-oauth-key"

[models.myModel]
provider = "myProvider"
model = "gpt-4"
max_context_size = 128000
capabilities = ["thinking", "image_in"]

[services.moonshot_search]
base_url = "https://search.example.com"
api_key = "sk-search"

[[hooks]]
event = "PreToolUse"
command = "echo pre"
matcher = ".*"
timeout = 60

[[hooks]]
event = "Stop"
command = "echo stop"
`;

    const configPath = join(testDir, 'config.toml');
    writeFileSync(configPath, toml);

    const result = loadConfig({ configFile: configPath });
    const config = result.config;

    expect(config.default_model).toBe('my-model');
    expect(config.default_thinking).toBe(true);
    expect(config.default_plan_mode).toBe(true);
    expect(config.default_editor).toBe('code --wait');
    expect(config.theme).toBe('light');
    expect(config.merge_all_available_skills).toBe(true);

    expect(config.loop_control.max_steps_per_turn).toBe(200);
    expect(config.loop_control.max_ralph_iterations).toBe(-1);
    expect(config.loop_control.compaction_trigger_ratio).toBe(0.9);

    expect(config.background.max_running_tasks).toBe(8);
    expect(config.background.keep_alive_on_exit).toBe(true);
    expect(config.background.agent_task_timeout_s).toBe(1800);

    expect(config.notifications.claim_stale_after_ms).toBe(30_000);
    expect(config.mcp.client.tool_call_timeout_ms).toBe(120_000);

    const prov = config.providers['myProvider'];
    expect(prov).toBeDefined();
    expect(prov!.type).toBe('openai_legacy');
    expect(prov!.oauth?.storage).toBe('keyring');

    const model = config.models['myModel'];
    expect(model).toBeDefined();
    expect(model!.max_context_size).toBe(128_000);
    expect(model!.capabilities).toEqual(['thinking', 'image_in']);

    expect(config.services.moonshot_search?.base_url).toBe(
      'https://search.example.com',
    );

    expect(config.hooks).toHaveLength(2);
    expect(config.hooks[0]!.event).toBe('PreToolUse');
    expect(config.hooks[0]!.timeout).toBe(60);
    expect(config.hooks[1]!.event).toBe('Stop');
    expect(config.hooks[1]!.timeout).toBe(30); // default
  });
});
