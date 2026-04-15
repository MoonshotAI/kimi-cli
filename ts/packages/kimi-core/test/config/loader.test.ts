/**
 * Config loader — TOML parsing, three-layer merge, and env var injection tests.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigError, loadConfig, parseConfigString } from '../../src/config/loader.js';
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
