import { describe, expect, it } from 'vitest';

import { createProgram } from '../../src/cli/commands.js';
import type { CLIOptions } from '../../src/cli/options.js';
import { OptionConflictError, validateOptions } from '../../src/cli/options.js';

function parse(argv: string[]): CLIOptions {
  let captured: CLIOptions | undefined;
  const program = createProgram('0.0.0-test', (opts) => {
    captured = opts;
  });
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  program.parse(['node', 'kimi', ...argv]);
  if (captured === undefined) {
    throw new Error('Main action handler was not called');
  }
  return captured;
}

describe('Phase 21 Slice F — --session / -r / -S picker routing', () => {
  describe('argParser: no-arg forms coerce to empty string', () => {
    it('--session with no id → session === ""', () => {
      const opts = parse(['--session']);
      expect(opts.session).toBe('');
    });

    it('-S with no id → session === ""', () => {
      const opts = parse(['-S']);
      expect(opts.session).toBe('');
    });

    it('-r with no id → session === ""', () => {
      const opts = parse(['-r']);
      expect(opts.session).toBe('');
    });
  });

  describe('argParser: id forms keep the id verbatim', () => {
    it('--session foo → session === "foo"', () => {
      const opts = parse(['--session', 'foo']);
      expect(opts.session).toBe('foo');
    });

    it('-S foo → session === "foo"', () => {
      const opts = parse(['-S', 'foo']);
      expect(opts.session).toBe('foo');
    });

    it('-r foo → session === "foo" (hidden alias)', () => {
      const opts = parse(['-r', 'foo']);
      expect(opts.session).toBe('foo');
    });
  });

  describe('validateOptions: empty session vs ui mode', () => {
    it('empty session + shell mode → OK, session stays ""', () => {
      const { options, uiMode } = validateOptions(parse(['--session']));
      expect(uiMode).toBe('shell');
      expect(options.session).toBe('');
    });

    it('empty session + --print → throws "requires shell mode"', () => {
      const opts = parse(['--session', '--print']);
      expect(() => validateOptions(opts)).toThrow(OptionConflictError);
      expect(() => validateOptions(opts)).toThrow(/requires shell mode/);
    });

    it('empty session + --wire → throws "requires shell mode"', () => {
      const opts = parse(['--session', '--wire']);
      expect(() => validateOptions(opts)).toThrow(OptionConflictError);
      expect(() => validateOptions(opts)).toThrow(/requires shell mode/);
    });

    it('-r (no id) + --print → throws "requires shell mode"', () => {
      const opts = parse(['-r', '--print']);
      expect(() => validateOptions(opts)).toThrow(/requires shell mode/);
    });

    it('-S (no id) + --wire → throws "requires shell mode"', () => {
      const opts = parse(['-S', '--wire']);
      expect(() => validateOptions(opts)).toThrow(/requires shell mode/);
    });

    it('--session foo + --print → still errors because --print + --session is fine, but non-empty session passes picker check', () => {
      // non-empty session must NOT trigger the picker-mode guard
      const { options, uiMode } = validateOptions(parse(['--session', 'foo', '--print']));
      expect(uiMode).toBe('print');
      expect(options.session).toBe('foo');
    });
  });
});
