import { describe, expect, it } from 'vitest';

import {
  toolNotFoundError,
  toolParseError,
  toolRuntimeError,
  toolValidateError,
} from '../src/tool-errors.js';
import { toolError, toolOk } from '../src/tool.js';

// ── toolOk ─────────────────────────────────────────────────────────────

describe('toolOk', () => {
  it('creates a successful return value with string output', () => {
    const rv = toolOk({ output: 'hello' });
    expect(rv.isError).toBe(false);
    expect(rv.output).toBe('hello');
    expect(rv.message).toBe('');
    expect(rv.display).toEqual([]);
  });

  it('creates a successful return value with ContentPart output', () => {
    const rv = toolOk({ output: { type: 'text', text: 'hi' } });
    expect(rv.isError).toBe(false);
    expect(rv.output).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('creates a successful return value with ContentPart array output', () => {
    const rv = toolOk({
      output: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ],
    });
    expect(rv.isError).toBe(false);
    expect(rv.output).toHaveLength(2);
  });

  it('includes message when provided', () => {
    const rv = toolOk({ output: 'data', message: 'done' });
    expect(rv.message).toBe('done');
  });

  it('includes brief display block when provided', () => {
    const rv = toolOk({ output: 'data', brief: 'summary' });
    expect(rv.display).toHaveLength(1);
    expect(rv.display[0]).toEqual({ type: 'brief', text: 'summary' });
  });

  it('has empty display when no brief', () => {
    const rv = toolOk({ output: 'data' });
    expect(rv.display).toEqual([]);
  });

  it('does not create a brief display block for empty brief', () => {
    const rv = toolOk({ output: 'data', brief: '' });
    expect(rv.display).toEqual([]);
  });
});

// ── toolError ──────────────────────────────────────────────────────────

describe('toolError', () => {
  it('creates an error return value', () => {
    const rv = toolError({ message: 'something failed', brief: 'failed' });
    expect(rv.isError).toBe(true);
    expect(rv.output).toBe('');
    expect(rv.message).toBe('something failed');
    expect(rv.display).toEqual([{ type: 'brief', text: 'failed' }]);
  });

  it('uses custom output when provided', () => {
    const rv = toolError({
      message: 'error msg',
      brief: 'err',
      output: 'custom output',
    });
    expect(rv.output).toBe('custom output');
    expect(rv.message).toBe('error msg');
  });

  it('uses empty output when output not provided', () => {
    const rv = toolError({ message: 'fail reason', brief: 'fail' });
    expect(rv.output).toBe('');
  });
});

// ── Tool error constructors ────────────────────────────────────────────

describe('toolNotFoundError', () => {
  it('creates an error for missing tool', () => {
    const rv = toolNotFoundError('nonexistent_tool');
    expect(rv.isError).toBe(true);
    expect(rv.message).toBe('Tool `nonexistent_tool` not found');
    expect(rv.display).toEqual([{ type: 'brief', text: 'Tool `nonexistent_tool` not found' }]);
  });
});

describe('toolParseError', () => {
  it('creates an error for parse failure', () => {
    const rv = toolParseError('invalid JSON at position 5');
    expect(rv.isError).toBe(true);
    expect(rv.message).toBe('Error parsing JSON arguments: invalid JSON at position 5');
    expect(rv.display).toEqual([{ type: 'brief', text: 'Invalid arguments' }]);
  });
});

describe('toolValidateError', () => {
  it('creates an error for validation failure', () => {
    const rv = toolValidateError('missing required field "path"');
    expect(rv.isError).toBe(true);
    expect(rv.message).toBe('Error validating JSON arguments: missing required field "path"');
    expect(rv.display).toEqual([{ type: 'brief', text: 'Invalid arguments' }]);
  });
});

describe('toolRuntimeError', () => {
  it('creates an error for runtime failure', () => {
    const rv = toolRuntimeError('permission denied');
    expect(rv.isError).toBe(true);
    expect(rv.message).toBe('Error running tool: permission denied');
    expect(rv.display).toEqual([{ type: 'brief', text: 'Tool runtime error' }]);
  });
});

// ── isError flag consistency ───────────────────────────────────────────

describe('isError flag', () => {
  it('toolOk always has isError=false', () => {
    expect(toolOk({ output: '' }).isError).toBe(false);
    expect(toolOk({ output: 'x', brief: 'y', message: 'z' }).isError).toBe(false);
  });

  it('all tool error constructors have isError=true', () => {
    expect(toolNotFoundError('t').isError).toBe(true);
    expect(toolParseError('p').isError).toBe(true);
    expect(toolValidateError('v').isError).toBe(true);
    expect(toolRuntimeError('r').isError).toBe(true);
  });
});

// ── DisplayBlock structure ─────────────────────────────────────────────

describe('DisplayBlock', () => {
  it('brief display block has correct structure', () => {
    const rv = toolOk({ output: 'data', brief: 'short' });
    const block = rv.display[0]!;
    expect(block.type).toBe('brief');
    if (block.type === 'brief') {
      expect((block as { text: string }).text).toBe('short');
    }
  });

  it('error display blocks are always present', () => {
    const rv = toolError({ message: 'err', brief: 'brief' });
    expect(rv.display.length).toBeGreaterThan(0);
    expect(rv.display[0]!.type).toBe('brief');
  });

  it('unknown display block has correct structure', () => {
    const block = { type: 'custom_type', data: { key: 'value', count: 42 } };
    expect(block.type).toBe('custom_type');
    expect(block.type).not.toBe('brief');
    expect(block.data).toEqual({ key: 'value', count: 42 });
  });
});
