/**
 * Phase 21 §D.3 — `/changelog` + changelog helpers.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  loadLatestChangelog,
  parseLatestChangelogSection,
} from '../../src/slash/changelog.js';

describe('parseLatestChangelogSection', () => {
  it('returns the first `## ...` section', () => {
    const body = [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '### Added',
      '',
      '- new feature',
      '',
      '## [0.1.0] - 2025-01-01',
      '',
      '- initial',
    ].join('\n');

    const section = parseLatestChangelogSection(body);

    expect(section).not.toBeNull();
    expect(section!.split('\n')[0]).toBe('## [Unreleased]');
    expect(section!).toContain('- new feature');
    expect(section!).not.toContain('[0.1.0]');
  });

  it('returns null when there is no `## ` heading', () => {
    expect(parseLatestChangelogSection('# Changelog\n\nonly a preamble.\n')).toBeNull();
  });

  it('returns a trimmed section even when the only entry is at EOF', () => {
    const body = '# Changelog\n\n## [Unreleased]\n\n- lone entry\n';
    const section = parseLatestChangelogSection(body);
    expect(section).toBe('## [Unreleased]\n\n- lone entry');
  });
});

describe('loadLatestChangelog', () => {
  it('reads the file returned by findPath and extracts the latest section', async () => {
    const findPath = vi.fn(async () => '/fake/CHANGELOG.md');
    const readFile = vi.fn(async () => '## [Unreleased]\n\n- hello\n');

    const result = await loadLatestChangelog({ startDir: '/anywhere', findPath, readFile });

    expect(findPath).toHaveBeenCalledWith('/anywhere');
    expect(readFile).toHaveBeenCalledWith('/fake/CHANGELOG.md');
    expect(result).toEqual({ ok: true, section: '## [Unreleased]\n\n- hello' });
  });

  it('returns a friendly error when no CHANGELOG.md is found', async () => {
    const result = await loadLatestChangelog({
      startDir: '/anywhere',
      findPath: async () => null,
      readFile: async () => {
        throw new Error('unreachable');
      },
    });

    expect(result).toEqual({ ok: false, message: 'No CHANGELOG.md found.' });
  });

  it('returns an error when the file exists but has no sections', async () => {
    const result = await loadLatestChangelog({
      startDir: '/anywhere',
      findPath: async () => '/fake/CHANGELOG.md',
      readFile: async () => '# header only\n',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('no sections');
    }
  });
});
