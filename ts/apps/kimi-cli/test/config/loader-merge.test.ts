/**
 * Phase 21 Slice C.2.1 — `--config` / `--config-file` loader + merge.
 *
 * Covers `loadCliConfig` (apps/kimi-cli/src/config/loader.ts) and
 * `mergeConfig` (apps/kimi-cli/src/config/merge.ts). Together they let
 * the CLI overlay inline TOML/JSON or a file on top of the disk config
 * loaded by `kimi-core`.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { KimiConfig } from '@moonshot-ai/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigLoadError, loadCliConfig } from '../../src/config/loader.js';
import { mergeConfig } from '../../src/config/merge.js';

let testDir: string;

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `kimi-loader-merge-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('loadCliConfig + mergeConfig', () => {
  it('parses --config inline TOML and merges over the base KimiConfig', () => {
    const base: KimiConfig = {
      providers: {
        kimi: { type: 'kimi', apiKey: 'disk-key', baseUrl: 'https://disk' },
      },
      defaultModel: 'disk-model',
      theme: 'dark',
    };

    const cli = loadCliConfig({
      config: 'default_model = "cli-model"\ntheme = "light"',
    });

    expect(cli.source).toBe('inline');
    expect(cli.config.defaultModel).toBe('cli-model');

    const merged = mergeConfig(base, cli.config);
    expect(merged.defaultModel).toBe('cli-model');
    expect(merged.theme).toBe('light');
    // Disk-only providers preserved.
    expect(merged.providers['kimi']?.apiKey).toBe('disk-key');
  });

  it('parses --config-file (TOML on disk) and CLI overrides win for nested provider fields', () => {
    const file = join(testDir, 'override.toml');
    writeFileSync(
      file,
      [
        '[providers.kimi]',
        'type = "kimi"',
        'api_key = "cli-key"',
      ].join('\n'),
      'utf-8',
    );

    const base: KimiConfig = {
      providers: {
        kimi: { type: 'kimi', apiKey: 'disk-key', baseUrl: 'https://disk' },
        anthropic: { type: 'anthropic', apiKey: 'disk-anthropic' },
      },
    };

    const cli = loadCliConfig({ configFile: file });
    expect(cli.source).toBe('file');
    expect(cli.filePath).toBe(file);

    const merged = mergeConfig(base, cli.config);
    expect(merged.providers['kimi']?.apiKey).toBe('cli-key');
    // baseUrl from disk preserved (deep merge into the same provider entry).
    expect(merged.providers['kimi']?.baseUrl).toBe('https://disk');
    // Sibling provider untouched.
    expect(merged.providers['anthropic']?.apiKey).toBe('disk-anthropic');
  });

  it('throws ConfigLoadError when --config-file points at a missing path', () => {
    const missing = join(testDir, 'does-not-exist.toml');
    expect(() => loadCliConfig({ configFile: missing })).toThrow(ConfigLoadError);
    expect(() => loadCliConfig({ configFile: missing })).toThrow(/Config file not found/);
  });
});
