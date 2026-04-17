import { describe, it, expect, beforeAll } from 'vitest';
import chalk from 'chalk';

import { highlightFirstSlashToken } from '../../src/components/CustomEditor.js';

beforeAll(() => {
  // Vitest runs without a TTY so chalk auto-detects colour support as
  // 0 (no colours). Force full colour so the highlighter actually
  // emits the SGR escapes we're asserting on.
  chalk.level = 3;
});

function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('highlightFirstSlashToken', () => {
  it('colours /cmd when line starts with a slash', () => {
    const out = highlightFirstSlashToken('  /help rest of input', '#ff00aa');
    expect(out).toBeDefined();
    // Visible text unchanged
    expect(strip(out!)).toBe('  /help rest of input');
    // SGR escapes surround /help
    expect(out!).toMatch(/\x1b\[.*m\/help\x1b\[/);
  });

  it('returns undefined when the line has no slash', () => {
    expect(highlightFirstSlashToken('hello world', '#ff00aa')).toBeUndefined();
  });

  it('returns undefined when slash is not at the leading position', () => {
    expect(highlightFirstSlashToken('  hello /not-cmd', '#ff00aa')).toBeUndefined();
  });

  it('handles /token at end of line (no trailing whitespace)', () => {
    const out = highlightFirstSlashToken('/exit', '#ff00aa');
    expect(out).toBeDefined();
    expect(strip(out!)).toBe('/exit');
  });

  it('passes through pre-existing ANSI (e.g. cursor inverse) in the tail', () => {
    // Simulate pi-tui Editor inserting an inverse-video cursor marker
    // somewhere after the slash token.
    const line = '/help x\x1b[7m \x1b[0m';
    const out = highlightFirstSlashToken(line, '#ff00aa');
    expect(out).toBeDefined();
    // Stripped visible content unchanged
    expect(strip(out!)).toBe(strip(line));
    // Inverse cursor SGR is still present afterwards
    expect(out!.includes('\x1b[7m')).toBe(true);
  });

  it('only paints the first token, not other slashes further along', () => {
    const out = highlightFirstSlashToken('/a /b', '#ff00aa');
    expect(out).toBeDefined();
    // Count the SGR opens — should be exactly one for /a.
    const opens = (out!.match(/\x1b\[[0-9;]+m/g) ?? []).length;
    expect(opens).toBeGreaterThanOrEqual(2); // chalk hex+bold open and reset(s)
    // /b should remain plain — the substring " /b" exists verbatim.
    expect(out!).toContain(' /b');
  });
});
