/**
 * Config loader — TOML parsing, three-layer merge, and env var injection tests.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ConfigError,
  loadConfig,
  parseConfigString,
  snakeToCamel,
  transformTomlData,
} from '../../src/config/loader.js';
import { PathConfig } from '../../src/session/path-config.js';

// ── Helpers ─────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `kimi-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeToml(dir: string, content: string): void {
  writeFileSync(join(dir, 'config.toml'), content, 'utf-8');
}

// ── TOML parsing ────────────────────────────────────────────────────────

describe('parseConfigString', () => {
  it('parses valid TOML', () => {
    const config = parseConfigString(`
defaultProvider = "anthropic"

[providers.anthropic]
type = "anthropic"
apiKey = "sk-ant-test"
defaultModel = "k25"
`);
    expect(config.providers['anthropic']?.type).toBe('anthropic');
    expect(config.providers['anthropic']?.apiKey).toBe('sk-ant-test');
    expect(config.defaultProvider).toBe('anthropic');
  });

  it('returns default config for empty string', () => {
    const config = parseConfigString('');
    expect(config.providers).toEqual({});
  });

  it('returns default config for whitespace-only string', () => {
    const config = parseConfigString('   \n\t  ');
    expect(config.providers).toEqual({});
  });

  it('throws ConfigError for invalid TOML syntax', () => {
    expect(() => parseConfigString('[[[')).toThrow(ConfigError);
  });

  it('throws ConfigError for invalid schema', () => {
    expect(() =>
      parseConfigString(`
[providers.bad]
type = "unknown-provider"
`),
    ).toThrow(ConfigError);
  });

  it('parses model aliases', () => {
    const config = parseConfigString(`
[providers.anthropic]
type = "anthropic"

[models.sonnet]
provider = "anthropic"
model = "k25"
`);
    expect(config.models?.['sonnet']?.model).toBe('k25');
  });
});

// ── Three-layer merge ───────────────────────────────────────────────────

describe('loadConfig three-layer merge', () => {
  let globalDir: string;
  let projectDir: string;

  beforeEach(() => {
    globalDir = makeTmpDir();
    projectDir = makeTmpDir();
    mkdirSync(join(projectDir, '.kimi'), { recursive: true });
  });

  afterEach(() => {
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('loads from global config only', () => {
    writeToml(
      globalDir,
      `
[providers.anthropic]
type = "anthropic"
apiKey = "global-key"
`,
    );
    const config = loadConfig({
      pathConfig: new PathConfig({ home: globalDir }),
    });
    expect(config.providers['anthropic']?.apiKey).toBe('global-key');
  });

  it('project config overrides global config', () => {
    writeToml(
      globalDir,
      `
[providers.anthropic]
type = "anthropic"
apiKey = "global-key"
defaultModel = "global-model"
`,
    );
    writeToml(
      join(projectDir, '.kimi'),
      `
[providers.anthropic]
type = "anthropic"
apiKey = "project-key"
`,
    );
    const config = loadConfig({
      pathConfig: new PathConfig({ home: globalDir }),
      workspaceDir: projectDir,
    });
    // Project overrides apiKey
    expect(config.providers['anthropic']?.apiKey).toBe('project-key');
    // Global's defaultModel is preserved (deep merge)
    expect(config.providers['anthropic']?.defaultModel).toBe('global-model');
  });

  it('CLI overrides take highest priority', () => {
    writeToml(
      globalDir,
      `
[providers.anthropic]
type = "anthropic"
apiKey = "global-key"
`,
    );
    const config = loadConfig({
      pathConfig: new PathConfig({ home: globalDir }),
      overrides: {
        providers: {
          anthropic: { type: 'anthropic', apiKey: 'cli-key' },
        },
      },
    });
    expect(config.providers['anthropic']?.apiKey).toBe('cli-key');
  });

  it('returns default config when no files exist', () => {
    const emptyDir = makeTmpDir();
    try {
      const config = loadConfig({
        pathConfig: new PathConfig({ home: emptyDir }),
      });
      expect(config.providers).toEqual({});
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('merges providers from different layers', () => {
    writeToml(
      globalDir,
      `
[providers.anthropic]
type = "anthropic"
apiKey = "ant-key"
`,
    );
    writeToml(
      join(projectDir, '.kimi'),
      `
[providers.kimi]
type = "kimi"
apiKey = "kimi-key"
`,
    );
    const config = loadConfig({
      pathConfig: new PathConfig({ home: globalDir }),
      workspaceDir: projectDir,
    });
    expect(config.providers['anthropic']?.apiKey).toBe('ant-key');
    expect(config.providers['kimi']?.apiKey).toBe('kimi-key');
  });

  it('throws ConfigError for invalid TOML in global config', () => {
    writeToml(globalDir, '[[[invalid');
    expect(() => loadConfig({ pathConfig: new PathConfig({ home: globalDir }) })).toThrow(
      ConfigError,
    );
  });

  it('handles empty TOML files gracefully', () => {
    writeToml(globalDir, '');
    const config = loadConfig({
      pathConfig: new PathConfig({ home: globalDir }),
    });
    expect(config.providers).toEqual({});
  });
});

// ── Environment variable injection ──────────────────────────────────────

describe('loadConfig env var injection', () => {
  let globalDir: string;

  const envKeys = [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'KIMI_API_KEY',
    'GOOGLE_AI_API_KEY',
    'KIMI_DEFAULT_MODEL',
    'KIMI_YOLO',
  ] as const;

  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    globalDir = makeTmpDir();
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      const val = savedEnv[key];
      if (val !== undefined) process.env[key] = val;
      else delete process.env[key];
    }
    rmSync(globalDir, { recursive: true, force: true });
  });

  it('injects ANTHROPIC_API_KEY when provider declared without apiKey', () => {
    writeToml(
      globalDir,
      `
[providers.anthropic]
type = "anthropic"
`,
    );
    process.env['ANTHROPIC_API_KEY'] = 'env-ant-key';
    const config = loadConfig({
      pathConfig: new PathConfig({ home: globalDir }),
    });
    expect(config.providers['anthropic']?.apiKey).toBe('env-ant-key');
  });

  it('injects OPENAI_API_KEY', () => {
    writeToml(
      globalDir,
      `
[providers.openai]
type = "openai"
`,
    );
    process.env['OPENAI_API_KEY'] = 'env-oai-key';
    const config = loadConfig({
      pathConfig: new PathConfig({ home: globalDir }),
    });
    expect(config.providers['openai']?.apiKey).toBe('env-oai-key');
  });

  it('injects KIMI_API_KEY', () => {
    writeToml(
      globalDir,
      `
[providers.kimi]
type = "kimi"
`,
    );
    process.env['KIMI_API_KEY'] = 'env-kimi-key';
    const config = loadConfig({
      pathConfig: new PathConfig({ home: globalDir }),
    });
    expect(config.providers['kimi']?.apiKey).toBe('env-kimi-key');
  });

  it('injects GOOGLE_AI_API_KEY', () => {
    writeToml(
      globalDir,
      `
[providers.google]
type = "google-genai"
`,
    );
    process.env['GOOGLE_AI_API_KEY'] = 'env-google-key';
    const config = loadConfig({
      pathConfig: new PathConfig({ home: globalDir }),
    });
    expect(config.providers['google']?.apiKey).toBe('env-google-key');
  });

  it('does NOT override explicit apiKey with env var', () => {
    writeToml(
      globalDir,
      `
[providers.anthropic]
type = "anthropic"
apiKey = "explicit-key"
`,
    );
    process.env['ANTHROPIC_API_KEY'] = 'env-key';
    const config = loadConfig({
      pathConfig: new PathConfig({ home: globalDir }),
    });
    expect(config.providers['anthropic']?.apiKey).toBe('explicit-key');
  });

  it('injects KIMI_DEFAULT_MODEL', () => {
    writeToml(globalDir, '');
    process.env['KIMI_DEFAULT_MODEL'] = 'env-model';
    const config = loadConfig({
      pathConfig: new PathConfig({ home: globalDir }),
    });
    expect(config.defaultModel).toBe('env-model');
  });

  it('does NOT override explicit defaultModel with env var', () => {
    writeToml(globalDir, 'defaultModel = "explicit-model"');
    process.env['KIMI_DEFAULT_MODEL'] = 'env-model';
    const config = loadConfig({
      pathConfig: new PathConfig({ home: globalDir }),
    });
    expect(config.defaultModel).toBe('explicit-model');
  });

  it('injects KIMI_YOLO=1 as true', () => {
    writeToml(globalDir, '');
    process.env['KIMI_YOLO'] = '1';
    const config = loadConfig({
      pathConfig: new PathConfig({ home: globalDir }),
    });
    expect(config.yolo).toBe(true);
  });

  it('KIMI_YOLO=false does not enable yolo', () => {
    writeToml(globalDir, '');
    process.env['KIMI_YOLO'] = 'false';
    const config = loadConfig({
      pathConfig: new PathConfig({ home: globalDir }),
    });
    expect(config.yolo).toBeUndefined();
  });

  it('KIMI_YOLO=0 does not enable yolo', () => {
    writeToml(globalDir, '');
    process.env['KIMI_YOLO'] = '0';
    const config = loadConfig({
      pathConfig: new PathConfig({ home: globalDir }),
    });
    expect(config.yolo).toBeUndefined();
  });
});

// ── snake_case → camelCase transform ──────────────────────────────────

describe('snakeToCamel', () => {
  it('converts snake_case to camelCase', () => {
    expect(snakeToCamel('api_key')).toBe('apiKey');
    expect(snakeToCamel('base_url')).toBe('baseUrl');
    expect(snakeToCamel('default_model')).toBe('defaultModel');
    expect(snakeToCamel('max_context_size')).toBe('maxContextSize');
    expect(snakeToCamel('merge_all_available_skills')).toBe('mergeAllAvailableSkills');
    expect(snakeToCamel('show_thinking_stream')).toBe('showThinkingStream');
  });

  it('preserves already-camelCase keys', () => {
    expect(snakeToCamel('apiKey')).toBe('apiKey');
    expect(snakeToCamel('baseUrl')).toBe('baseUrl');
    expect(snakeToCamel('defaultModel')).toBe('defaultModel');
  });

  it('preserves keys without underscores', () => {
    expect(snakeToCamel('type')).toBe('type');
    expect(snakeToCamel('model')).toBe('model');
    expect(snakeToCamel('provider')).toBe('provider');
    expect(snakeToCamel('theme')).toBe('theme');
  });

  it('handles underscore followed by digit', () => {
    expect(snakeToCamel('field_1_name')).toBe('field1Name');
    expect(snakeToCamel('v_2')).toBe('v2');
  });

  it('handles underscore followed by uppercase', () => {
    expect(snakeToCamel('my_URL')).toBe('myURL');
  });

  it('handles consecutive underscores', () => {
    expect(snakeToCamel('a__b')).toBe('a_B');
  });
});

describe('transformTomlData', () => {
  it('preserves provider record keys while transforming field keys', () => {
    const data = {
      providers: {
        'anthropic-kimi': { type: 'anthropic', base_url: 'https://example.com', api_key: 'sk-xxx' },
        'managed:moonshot-cn': {
          type: 'kimi',
          base_url: 'https://api.moonshot.cn/v1',
          api_key: 'sk-yyy',
        },
      },
    };
    const result = transformTomlData(data);
    const providers = result['providers'] as Record<string, Record<string, unknown>>;
    expect(providers['anthropic-kimi']).toBeDefined();
    expect(providers['managed:moonshot-cn']).toBeDefined();
    expect(providers['anthropic-kimi']!['baseUrl']).toBe('https://example.com');
    expect(providers['anthropic-kimi']!['apiKey']).toBe('sk-xxx');
    expect(providers['managed:moonshot-cn']!['baseUrl']).toBe('https://api.moonshot.cn/v1');
  });

  it('preserves model record keys while transforming field keys', () => {
    const data = {
      models: {
        'kimi-k2-5': { provider: 'kimi', model: 'kimi-k2.5', max_context_size: 250000 },
        'moonshot-cn/kimi-k2.5': {
          provider: 'managed:moonshot-cn',
          model: 'kimi-k2.5',
          max_context_size: 262144,
          capabilities: ['thinking'],
        },
      },
    };
    const result = transformTomlData(data);
    const models = result['models'] as Record<string, Record<string, unknown>>;
    expect(models['kimi-k2-5']).toBeDefined();
    expect(models['moonshot-cn/kimi-k2.5']).toBeDefined();
    expect(models['kimi-k2-5']!['maxContextSize']).toBe(250000);
    expect(models['moonshot-cn/kimi-k2.5']!['maxContextSize']).toBe(262144);
  });

  it('transforms top-level snake_case keys', () => {
    const data = {
      default_model: 'test-model',
      default_thinking: true,
      show_thinking_stream: true,
      merge_all_available_skills: false,
    };
    const result = transformTomlData(data);
    expect(result['defaultModel']).toBe('test-model');
    expect(result['defaultThinking']).toBe(true);
    expect(result['showThinkingStream']).toBe(true);
    expect(result['mergeAllAvailableSkills']).toBe(false);
  });

  it('transforms nested oauth fields in providers', () => {
    const data = {
      providers: {
        test: { type: 'kimi', oauth: { storage: 'file', key: 'oauth/test' } },
      },
    };
    const result = transformTomlData(data);
    const providers = result['providers'] as Record<string, Record<string, unknown>>;
    const oauth = providers['test']!['oauth'] as Record<string, unknown>;
    expect(oauth['storage']).toBe('file');
    expect(oauth['key']).toBe('oauth/test');
  });
});

// ── Full Python config format ─────────────────────────────────────────

const PYTHON_FORMAT_TOML = `
default_model = "kimi-code/kimi-for-coding"
default_thinking = true
default_yolo = false
default_plan_mode = false
default_editor = "code --wait"
theme = "dark"
hooks = []
merge_all_available_skills = false
show_thinking_stream = true

[models.gpt-4]
provider = "codex"
model = "gpt-5.4"
max_context_size = 1000000
capabilities = ["thinking", "image_in"]

[models.kimi-k2-5]
provider = "kimi-internal"
model = "kimi-k2.5"
max_context_size = 250000
capabilities = ["image_in", "thinking", "video_in"]

[models."moonshot-cn/kimi-k2.5"]
provider = "managed:moonshot-cn"
model = "kimi-k2.5"
max_context_size = 262144
capabilities = ["image_in", "thinking", "video_in"]

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 262144
capabilities = ["image_in", "thinking", "video_in"]

[providers.anthropic-kimi]
type = "anthropic"
base_url = "https://api.kimi.com/coding"
api_key = "sk-test-anthropic"

[providers.kimi-internal]
type = "kimi"
base_url = "https://api.msh.team/v1"
api_key = "sk-test-kimi"

[providers.qianxun-responses]
type = "openai_responses"
base_url = "https://openai.app.msh.team/raw/x/v1"
api_key = "sk-test-responses"

[providers.qianxun-vertexai]
type = "vertexai"
base_url = "https://openai.app.msh.team/raw/x/"
api_key = "sk-test-vertexai"

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
api_key = ""

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code"

[providers."managed:moonshot-cn"]
type = "kimi"
base_url = "https://api.moonshot.cn/v1"
api_key = "sk-test-moonshot"

[providers.codex]
type = "openai_responses"
base_url = "https://openproxy.to/codex/v1"
api_key = "sk-test-codex"

[loop_control]
max_steps_per_turn = 100
max_retries_per_step = 3
reserved_context_size = 50000
compaction_trigger_ratio = 0.85

[background]
max_running_tasks = 4

[notifications]
claim_stale_after_ms = 15000

[services.moonshot_search]
base_url = "https://api.kimi.com/coding/v1/search"
api_key = ""

[services.moonshot_search.oauth]
storage = "file"
key = "oauth/kimi-code"

[mcp.client]
tool_call_timeout_ms = 60000
`;

describe('parseConfigString — Python config format', () => {
  it('parses all top-level fields', () => {
    const config = parseConfigString(PYTHON_FORMAT_TOML);
    expect(config.defaultModel).toBe('kimi-code/kimi-for-coding');
    expect(config.defaultThinking).toBe(true);
    expect(config.defaultYolo).toBe(false);
    expect(config.defaultPlanMode).toBe(false);
    expect(config.defaultEditor).toBe('code --wait');
    expect(config.theme).toBe('dark');
    expect(config.hooks).toEqual([]);
    expect(config.mergeAllAvailableSkills).toBe(false);
    expect(config.showThinkingStream).toBe(true);
  });

  it('parses providers with snake_case → camelCase mapping', () => {
    const config = parseConfigString(PYTHON_FORMAT_TOML);
    const anthropic = config.providers['anthropic-kimi'];
    expect(anthropic).toBeDefined();
    expect(anthropic!.type).toBe('anthropic');
    expect(anthropic!.baseUrl).toBe('https://api.kimi.com/coding');
    expect(anthropic!.apiKey).toBe('sk-test-anthropic');

    const kimi = config.providers['kimi-internal'];
    expect(kimi).toBeDefined();
    expect(kimi!.type).toBe('kimi');
    expect(kimi!.baseUrl).toBe('https://api.msh.team/v1');
    expect(kimi!.apiKey).toBe('sk-test-kimi');
  });

  it('parses openai_responses provider type', () => {
    const config = parseConfigString(PYTHON_FORMAT_TOML);
    const provider = config.providers['qianxun-responses'];
    expect(provider).toBeDefined();
    expect(provider!.type).toBe('openai_responses');
    expect(provider!.baseUrl).toBe('https://openai.app.msh.team/raw/x/v1');
  });

  it('parses vertexai provider type', () => {
    const config = parseConfigString(PYTHON_FORMAT_TOML);
    const provider = config.providers['qianxun-vertexai'];
    expect(provider).toBeDefined();
    expect(provider!.type).toBe('vertexai');
  });

  it('parses managed: prefix provider names', () => {
    const config = parseConfigString(PYTHON_FORMAT_TOML);
    const kimiCode = config.providers['managed:kimi-code'];
    expect(kimiCode).toBeDefined();
    expect(kimiCode!.type).toBe('kimi');
    expect(kimiCode!.baseUrl).toBe('https://api.kimi.com/coding/v1');
    expect(kimiCode!.apiKey).toBe('');

    const moonshot = config.providers['managed:moonshot-cn'];
    expect(moonshot).toBeDefined();
    expect(moonshot!.type).toBe('kimi');
    expect(moonshot!.apiKey).toBe('sk-test-moonshot');
  });

  it('parses OAuth fields on providers', () => {
    const config = parseConfigString(PYTHON_FORMAT_TOML);
    const kimiCode = config.providers['managed:kimi-code'];
    expect(kimiCode!.oauth).toBeDefined();
    expect(kimiCode!.oauth!.storage).toBe('file');
    expect(kimiCode!.oauth!.key).toBe('oauth/kimi-code');

    const moonshot = config.providers['managed:moonshot-cn'];
    expect(moonshot!.oauth).toBeUndefined();
  });

  it('parses model aliases with maxContextSize and capabilities', () => {
    const config = parseConfigString(PYTHON_FORMAT_TOML);
    const gpt4 = config.models?.['gpt-4'];
    expect(gpt4).toBeDefined();
    expect(gpt4!.provider).toBe('codex');
    expect(gpt4!.model).toBe('gpt-5.4');
    expect(gpt4!.maxContextSize).toBe(1000000);
    expect(gpt4!.capabilities).toEqual(['thinking', 'image_in']);
  });

  it('parses complex model names with special characters', () => {
    const config = parseConfigString(PYTHON_FORMAT_TOML);

    const slashModel = config.models?.['moonshot-cn/kimi-k2.5'];
    expect(slashModel).toBeDefined();
    expect(slashModel!.provider).toBe('managed:moonshot-cn');
    expect(slashModel!.maxContextSize).toBe(262144);
    expect(slashModel!.capabilities).toEqual(['image_in', 'thinking', 'video_in']);

    const kimiCode = config.models?.['kimi-code/kimi-for-coding'];
    expect(kimiCode).toBeDefined();
    expect(kimiCode!.provider).toBe('managed:kimi-code');

    const hyphenModel = config.models?.['kimi-k2-5'];
    expect(hyphenModel).toBeDefined();
    expect(hyphenModel!.model).toBe('kimi-k2.5');
  });

  it('stores non-provider sections in raw', () => {
    const config = parseConfigString(PYTHON_FORMAT_TOML);
    expect(config.raw).toBeDefined();

    const raw = config.raw!;
    const loopControl = raw['loop_control'] as Record<string, unknown>;
    expect(loopControl).toBeDefined();
    expect(loopControl['max_steps_per_turn']).toBe(100);
    expect(loopControl['max_retries_per_step']).toBe(3);
    expect(loopControl['reserved_context_size']).toBe(50000);
    expect(loopControl['compaction_trigger_ratio']).toBe(0.85);

    const background = raw['background'] as Record<string, unknown>;
    expect(background).toBeDefined();
    expect(background['max_running_tasks']).toBe(4);

    const notifications = raw['notifications'] as Record<string, unknown>;
    expect(notifications).toBeDefined();
    expect(notifications['claim_stale_after_ms']).toBe(15000);

    const mcp = raw['mcp'] as Record<string, unknown>;
    expect(mcp).toBeDefined();
    const mcpClient = mcp['client'] as Record<string, unknown>;
    expect(mcpClient['tool_call_timeout_ms']).toBe(60000);

    const services = raw['services'] as Record<string, unknown>;
    expect(services).toBeDefined();
    const search = services['moonshot_search'] as Record<string, unknown>;
    expect(search['base_url']).toBe('https://api.kimi.com/coding/v1/search');
  });

  it('raw preserves original snake_case keys', () => {
    const config = parseConfigString(PYTHON_FORMAT_TOML);
    const raw = config.raw!;
    expect(raw['default_model']).toBe('kimi-code/kimi-for-coding');
    expect(raw['default_thinking']).toBe(true);
    expect(raw['show_thinking_stream']).toBe(true);
    expect(raw['merge_all_available_skills']).toBe(false);

    const providers = raw['providers'] as Record<string, Record<string, unknown>>;
    expect(providers['anthropic-kimi']!['api_key']).toBe('sk-test-anthropic');
    expect(providers['anthropic-kimi']!['base_url']).toBe('https://api.kimi.com/coding');
  });
});

// ── loadConfig with Python-format config ──────────────────────────────

describe('loadConfig — Python config format via file', () => {
  let globalDir: string;

  beforeEach(() => {
    globalDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(globalDir, { recursive: true, force: true });
  });

  it('loads full Python-format config from file', () => {
    writeToml(globalDir, PYTHON_FORMAT_TOML);
    const config = loadConfig({
      pathConfig: new PathConfig({ home: globalDir }),
    });

    expect(config.defaultModel).toBe('kimi-code/kimi-for-coding');
    expect(config.defaultThinking).toBe(true);
    expect(config.providers['kimi-internal']?.type).toBe('kimi');
    expect(config.providers['kimi-internal']?.baseUrl).toBe('https://api.msh.team/v1');
    expect(config.models?.['gpt-4']?.maxContextSize).toBe(1000000);
    expect(config.raw).toBeDefined();
    expect(config.raw!['loop_control']).toBeDefined();
  });

  it('snake_case fields in file merge with camelCase overrides', () => {
    writeToml(
      globalDir,
      `
default_model = "from-file"

[providers.kimi-internal]
type = "kimi"
base_url = "https://api.msh.team/v1"
api_key = "file-key"
`,
    );
    const config = loadConfig({
      pathConfig: new PathConfig({ home: globalDir }),
      overrides: { defaultModel: 'from-override' },
    });
    expect(config.defaultModel).toBe('from-override');
    expect(config.providers['kimi-internal']?.baseUrl).toBe('https://api.msh.team/v1');
    expect(config.providers['kimi-internal']?.apiKey).toBe('file-key');
  });

  it('raw field is not polluted by camelCase overrides', () => {
    writeToml(
      globalDir,
      `
default_model = "from-file"
default_thinking = true
`,
    );
    const config = loadConfig({
      pathConfig: new PathConfig({ home: globalDir }),
      overrides: { defaultModel: 'from-override' },
    });
    const raw = config.raw!;
    expect(raw['default_model']).toBe('from-file');
    expect(raw['default_thinking']).toBe(true);
    expect(raw['defaultModel']).toBeUndefined();
  });
});
