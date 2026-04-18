import { describe, expect, it } from 'vitest';

import { createProgram } from '../../src/cli/commands.js';
import type { CLIOptions } from '../../src/cli/options.js';
import { OptionConflictError, validateOptions } from '../../src/cli/options.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse the given argv through a fresh Commander program and capture the
 * CLIOptions that the root action handler receives.
 *
 * Returns the captured options, or throws if Commander itself errors
 * (unknown flag, missing value, etc.).
 */
function parse(argv: string[]): CLIOptions {
  let captured: CLIOptions | undefined;

  const program = createProgram('0.1.0-test', (opts) => {
    captured = opts;
  });

  // exitOverride makes Commander throw instead of calling process.exit,
  // and configureOutput suppresses help/error writes to stderr during tests.
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });

  program.parse(['node', 'kimi', ...argv]);

  if (captured === undefined) {
    throw new Error('Main action handler was not called (sub-command invoked?)');
  }
  return captured;
}

/**
 * Parse and then validate, returning the validated result.
 */
function parseAndValidate(argv: string[]) {
  return validateOptions(parse(argv));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CLI options parsing', () => {
  // -------------------------------------------------------------------------
  // Defaults
  // -------------------------------------------------------------------------
  describe('defaults', () => {
    it('should return correct defaults when no arguments are given', () => {
      const opts = parse([]);

      expect(opts.verbose).toBe(false);
      expect(opts.debug).toBe(false);
      expect(opts.workDir).toBeUndefined();
      expect(opts.addDir).toBeUndefined();
      expect(opts.session).toBeUndefined();
      expect(opts.continue).toBe(false);
      expect(opts.config).toBeUndefined();
      expect(opts.configFile).toBeUndefined();
      expect(opts.model).toBeUndefined();
      expect(opts.thinking).toBeUndefined();
      expect(opts.yolo).toBe(false);
      expect(opts.plan).toBe(false);
      expect(opts.prompt).toBeUndefined();
      expect(opts.print).toBe(false);
      expect(opts.wire).toBe(false);
      expect(opts.inputFormat).toBeUndefined();
      expect(opts.outputFormat).toBeUndefined();
      expect(opts.finalMessageOnly).toBe(false);
      expect(opts.quiet).toBe(false);
      expect(opts.agent).toBeUndefined();
      expect(opts.agentFile).toBeUndefined();
      expect(opts.mcpConfigFile).toBeUndefined();
      expect(opts.mcpConfig).toBeUndefined();
      expect(opts.skillsDir).toBeUndefined();
      expect(opts.maxStepsPerTurn).toBeUndefined();
      expect(opts.maxRetriesPerStep).toBeUndefined();
      expect(opts.maxRalphIterations).toBeUndefined();
    });

    it('should resolve to shell UI mode when no mode flags are given', () => {
      const { uiMode } = parseAndValidate([]);
      expect(uiMode).toBe('shell');
    });
  });

  // -------------------------------------------------------------------------
  // --version
  // -------------------------------------------------------------------------
  describe('--version', () => {
    it('should output the version string and exit', () => {
      let output = '';
      const program = createProgram('1.2.3', () => {});
      program.exitOverride();
      program.configureOutput({ writeOut: (s) => { output += s; } });

      expect(() => program.parse(['node', 'kimi', '--version'])).toThrow();
      expect(output).toContain('1.2.3');
    });

    it('should support -V as a short alias', () => {
      let output = '';
      const program = createProgram('4.5.6', () => {});
      program.exitOverride();
      program.configureOutput({ writeOut: (s) => { output += s; } });

      expect(() => program.parse(['node', 'kimi', '-V'])).toThrow();
      expect(output).toContain('4.5.6');
    });
  });

  // -------------------------------------------------------------------------
  // --model
  // -------------------------------------------------------------------------
  describe('--model', () => {
    it('should parse --model correctly', () => {
      const opts = parse(['--model', 'k2']);
      expect(opts.model).toBe('k2');
    });

    it('should parse -m as a short alias', () => {
      const opts = parse(['-m', 'gpt-4o']);
      expect(opts.model).toBe('gpt-4o');
    });

    it('rawModel defaults to false when --raw-model is absent', () => {
      const opts = parse([]);
      expect(opts.rawModel).toBe(false);
    });

    it('--raw-model sets rawModel: true', () => {
      const opts = parse(['--model', 'zzz', '--raw-model']);
      expect(opts.model).toBe('zzz');
      expect(opts.rawModel).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Mutual-exclusion / conflict detection
  // -------------------------------------------------------------------------
  describe('mutual exclusion', () => {
    it('should error when --print and --wire are combined', () => {
      const opts = parse(['--print', '--wire']);
      expect(() => validateOptions(opts)).toThrow(OptionConflictError);
      expect(() => validateOptions(opts)).toThrow('Cannot combine --print, --wire.');
    });

    it('should error when --continue and --session are combined', () => {
      const opts = parse(['--continue', '--session', 'abc123']);
      expect(() => validateOptions(opts)).toThrow(OptionConflictError);
      expect(() => validateOptions(opts)).toThrow('Cannot combine --continue, --session.');
    });

    it('should error when --agent and --agent-file are combined', () => {
      const opts = parse(['--agent', 'default', '--agent-file', '/path/to/file']);
      expect(() => validateOptions(opts)).toThrow(OptionConflictError);
      expect(() => validateOptions(opts)).toThrow('Cannot combine --agent, --agent-file.');
    });

    it('should error when --config and --config-file are combined', () => {
      const opts = parse(['--config', '{}', '--config-file', '/path/to/file']);
      expect(() => validateOptions(opts)).toThrow(OptionConflictError);
      expect(() => validateOptions(opts)).toThrow('Cannot combine --config, --config-file.');
    });

    it('should allow --print without --wire', () => {
      const { uiMode } = parseAndValidate(['--print']);
      expect(uiMode).toBe('print');
    });

    it('should allow --wire without --print', () => {
      const { uiMode } = parseAndValidate(['--wire']);
      expect(uiMode).toBe('wire');
    });
  });

  // -------------------------------------------------------------------------
  // --quiet
  // -------------------------------------------------------------------------
  describe('--quiet', () => {
    it('should imply --print, --output-format text, and --final-message-only', () => {
      const opts = parse(['--quiet']);
      const { options, uiMode } = validateOptions(opts);

      expect(options.print).toBe(true);
      expect(options.outputFormat).toBe('text');
      expect(options.finalMessageOnly).toBe(true);
      expect(uiMode).toBe('print');
    });

    it('should error when --quiet is combined with --wire', () => {
      const opts = parse(['--quiet', '--wire']);
      expect(() => validateOptions(opts)).toThrow(OptionConflictError);
    });

    it('should error when --quiet is combined with --output-format stream-json', () => {
      const opts = parse(['--quiet', '--output-format', 'stream-json']);
      expect(() => validateOptions(opts)).toThrow(OptionConflictError);
    });
  });

  // -------------------------------------------------------------------------
  // Alias mapping
  // -------------------------------------------------------------------------
  describe('alias mapping', () => {
    it('--yolo should set yolo to true', () => {
      const opts = parse(['--yolo']);
      expect(opts.yolo).toBe(true);
    });

    it('-y should set yolo to true', () => {
      const opts = parse(['-y']);
      expect(opts.yolo).toBe(true);
    });

    it('--yes should set yolo to true', () => {
      const opts = parse(['--yes']);
      expect(opts.yolo).toBe(true);
    });

    it('--auto-approve should set yolo to true', () => {
      const opts = parse(['--auto-approve']);
      expect(opts.yolo).toBe(true);
    });

    it('-p should set prompt', () => {
      const opts = parse(['-p', 'hello world']);
      expect(opts.prompt).toBe('hello world');
    });

    it('-c should set prompt (alias for --command)', () => {
      const opts = parse(['-c', 'fix bug']);
      expect(opts.prompt).toBe('fix bug');
    });

    it('--command should set prompt', () => {
      const opts = parse(['--command', 'refactor code']);
      expect(opts.prompt).toBe('refactor code');
    });

    it('-S should set session', () => {
      const opts = parse(['-S', 'sess-123']);
      expect(opts.session).toBe('sess-123');
    });

    it('-r should set session (alias for --resume)', () => {
      const opts = parse(['-r', 'sess-456']);
      expect(opts.session).toBe('sess-456');
    });

    it('--resume should set session', () => {
      const opts = parse(['--resume', 'sess-789']);
      expect(opts.session).toBe('sess-789');
    });

    it('-C should set continue', () => {
      const opts = parse(['-C']);
      expect(opts.continue).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Format-only flags require print mode
  // -------------------------------------------------------------------------
  describe('format flags require print mode', () => {
    it('should error when --input-format is used without --print', () => {
      const opts = parse(['--input-format', 'text']);
      expect(() => validateOptions(opts)).toThrow(OptionConflictError);
    });

    it('should error when --output-format is used without --print', () => {
      const opts = parse(['--output-format', 'stream-json']);
      expect(() => validateOptions(opts)).toThrow(OptionConflictError);
    });

    it('should error when --final-message-only is used without --print', () => {
      const opts = parse(['--final-message-only']);
      expect(() => validateOptions(opts)).toThrow(OptionConflictError);
    });

    it('should allow --input-format with --print', () => {
      const { options } = parseAndValidate(['--print', '--input-format', 'stream-json']);
      expect(options.inputFormat).toBe('stream-json');
    });
  });

  // -------------------------------------------------------------------------
  // --thinking / --no-thinking
  // -------------------------------------------------------------------------
  describe('--thinking', () => {
    it('should set thinking to true', () => {
      const opts = parse(['--thinking']);
      expect(opts.thinking).toBe(true);
    });

    it('should set thinking to false with --no-thinking', () => {
      const opts = parse(['--no-thinking']);
      expect(opts.thinking).toBe(false);
    });

    it('should leave thinking undefined by default', () => {
      const opts = parse([]);
      expect(opts.thinking).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Loop control options
  // -------------------------------------------------------------------------
  describe('loop control', () => {
    it('should parse --max-steps-per-turn as integer', () => {
      const opts = parse(['--max-steps-per-turn', '50']);
      expect(opts.maxStepsPerTurn).toBe(50);
    });

    it('should parse --max-retries-per-step as integer', () => {
      const opts = parse(['--max-retries-per-step', '5']);
      expect(opts.maxRetriesPerStep).toBe(5);
    });

    it('should parse --max-ralph-iterations as integer (including -1)', () => {
      const opts = parse(['--max-ralph-iterations', '-1']);
      expect(opts.maxRalphIterations).toBe(-1);
    });
  });

  // -------------------------------------------------------------------------
  // Sub-commands existence
  // -------------------------------------------------------------------------
  describe('sub-commands', () => {
    function getSubcommandNames(): string[] {
      const program = createProgram('0.0.0', () => {});
      return program.commands.map((c) => c.name());
    }

    it('should register login sub-command', () => {
      expect(getSubcommandNames()).toContain('login');
    });

    it('should register logout sub-command', () => {
      expect(getSubcommandNames()).toContain('logout');
    });

    it('should register export sub-command', () => {
      expect(getSubcommandNames()).toContain('export');
    });

    it('should register info sub-command', () => {
      expect(getSubcommandNames()).toContain('info');
    });

    it('should register mcp sub-command', () => {
      expect(getSubcommandNames()).toContain('mcp');
    });

    it('mcp should have sub-sub-commands: add, remove, list, auth, reset-auth, test', () => {
      const program = createProgram('0.0.0', () => {});
      const mcp = program.commands.find((c) => c.name() === 'mcp');
      expect(mcp).toBeDefined();
      const subNames = mcp!.commands.map((c) => c.name());
      expect(subNames).toContain('add');
      expect(subNames).toContain('remove');
      expect(subNames).toContain('list');
      expect(subNames).toContain('auth');
      expect(subNames).toContain('reset-auth');
      expect(subNames).toContain('test');
    });
  });

  // -------------------------------------------------------------------------
  // Repeatable options
  // -------------------------------------------------------------------------
  describe('repeatable options', () => {
    it('should parse multiple --add-dir values', () => {
      const opts = parse(['--add-dir', '/path/a', '/path/b']);
      expect(opts.addDir).toEqual(['/path/a', '/path/b']);
    });

    it('should parse multiple --mcp-config-file values', () => {
      const opts = parse(['--mcp-config-file', '/a.json', '/b.json']);
      expect(opts.mcpConfigFile).toEqual(['/a.json', '/b.json']);
    });

    it('should parse multiple --skills-dir values', () => {
      const opts = parse(['--skills-dir', '/skills1', '/skills2']);
      expect(opts.skillsDir).toEqual(['/skills1', '/skills2']);
    });
  });

  // -------------------------------------------------------------------------
  // --agent choices
  // -------------------------------------------------------------------------
  describe('--agent choices', () => {
    it('should accept "default"', () => {
      const opts = parse(['--agent', 'default']);
      expect(opts.agent).toBe('default');
    });

    it('should accept "okabe"', () => {
      const opts = parse(['--agent', 'okabe']);
      expect(opts.agent).toBe('okabe');
    });

    it('should reject invalid agent name', () => {
      const program = createProgram('0.0.0', () => {});
      program.exitOverride();
      program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
      expect(() => program.parse(['node', 'kimi', '--agent', 'invalid'])).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Complex scenarios
  // -------------------------------------------------------------------------
  describe('complex scenarios', () => {
    it('should parse a typical non-interactive invocation', () => {
      const { options, uiMode } = parseAndValidate([
        '--print',
        '--model', 'k2',
        '-p', 'summarize this file',
        '--output-format', 'stream-json',
      ]);
      expect(uiMode).toBe('print');
      expect(options.model).toBe('k2');
      expect(options.prompt).toBe('summarize this file');
      expect(options.outputFormat).toBe('stream-json');
    });

    it('should parse a session resume invocation', () => {
      const { options, uiMode } = parseAndValidate([
        '--session', 'abc-123',
        '--model', 'gpt-4o',
        '--verbose',
      ]);
      expect(uiMode).toBe('shell');
      expect(options.session).toBe('abc-123');
      expect(options.model).toBe('gpt-4o');
      expect(options.verbose).toBe(true);
    });
  });
});
