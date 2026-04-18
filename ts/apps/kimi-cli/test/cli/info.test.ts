/**
 * `kimi info` — Phase 21 Slice E.1.
 *
 * Drives the command through Commander with a fake `InfoDeps` so we
 * capture stdout precisely without touching `~/.kimi`.
 */

import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { collectInfo, registerInfoCommand, renderInfoText } from '../../src/cli/sub/info.js';

function makeCaptureStdout(): { write(chunk: string): boolean; text(): string } {
  const chunks: string[] = [];
  return {
    write(chunk) {
      chunks.push(chunk);
      return true;
    },
    text() {
      return chunks.join('');
    },
  };
}

function buildProgram(opts: {
  getVersion: () => string;
  stdout: { write(chunk: string): boolean };
}): Command {
  const program = new Command('kimi').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerInfoCommand(program, opts);
  return program;
}

describe('kimi info', () => {
  it('renders the default five-field text format', async () => {
    const stdout = makeCaptureStdout();
    const program = buildProgram({ getVersion: () => '1.27.0', stdout });
    await program.parseAsync(['node', 'kimi', 'info']);

    const text = stdout.text();
    expect(text).toContain('kimi-cli version:    1.27.0');
    expect(text).toMatch(/wire protocol:\s+\d+\.\d+/);
    expect(text).toContain('nodejs version:');
    expect(text).toMatch(/agent spec versions:\s+1/);
    expect(text).toContain('config:');
  });

  it('renders --json as a single-line JSON object', async () => {
    const stdout = makeCaptureStdout();
    const program = buildProgram({ getVersion: () => '1.27.0', stdout });
    await program.parseAsync(['node', 'kimi', 'info', '--json']);

    const text = stdout.text().trim();
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed['kimi_cli_version']).toBe('1.27.0');
    expect(typeof parsed['wire_protocol_version']).toBe('string');
    expect(typeof parsed['nodejs_version']).toBe('string');
    expect(Array.isArray(parsed['agent_spec_versions'])).toBe(true);
    expect((parsed['agent_spec_versions'] as string[]).length).toBeGreaterThanOrEqual(1);
    expect(typeof parsed['config_path']).toBe('string');
  });

  it('does not crash when the version lookup returns a falsy-ish placeholder', () => {
    // collectInfo is the data-gathering seam — a misbehaving getVersion
    // must not throw, it must surface whatever the caller returned.
    const info = collectInfo({ getVersion: () => '0.0.0' });
    expect(info.kimi_cli_version).toBe('0.0.0');
    expect(renderInfoText(info)).toContain('0.0.0');
  });
});
