/**
 * Covers: describeApprovalAction + actionToRulePattern (Slice 2.3).
 *
 * Pins:
 *   - Override wins over derivation
 *   - ApprovalDisplay.kind drives the common case
 *   - Generic display falls back to the tool-name table
 *   - Unknown tool → `call <toolName>`
 *   - actionToRulePattern has inverse entries + falls back to toolName
 */

import { describe, expect, it } from 'vitest';

import {
  actionToRulePattern,
  describeApprovalAction,
} from '../../../src/soul-plus/permission/action-label.js';
import type { ApprovalDisplay } from '../../../src/storage/wire-record.js';

describe('describeApprovalAction', () => {
  it('uses the explicit override when provided', () => {
    const display: ApprovalDisplay = { kind: 'generic', title: 'x', body: 'y' };
    expect(describeApprovalAction('Bash', {}, display, 'custom label')).toBe('custom label');
  });

  it('maps command display to "run command"', () => {
    expect(
      describeApprovalAction('Bash', { command: 'ls' }, { kind: 'command', command: 'ls' }),
    ).toBe('run command');
  });

  it('maps diff display to "edit file"', () => {
    expect(describeApprovalAction('Edit', {}, { kind: 'diff', path: '/x', diff: '' })).toBe(
      'edit file',
    );
  });

  it('maps file_write display to "write file"', () => {
    expect(
      describeApprovalAction('Write', {}, { kind: 'file_write', path: '/x', content: '' }),
    ).toBe('write file');
  });

  it('maps task_stop display to "stop background task"', () => {
    expect(
      describeApprovalAction(
        'BackgroundStop',
        {},
        { kind: 'task_stop', task_id: 't', task_description: 'x' },
      ),
    ).toBe('stop background task');
  });

  it('falls back to tool-name table for generic display', () => {
    const display: ApprovalDisplay = { kind: 'generic', title: 'x', body: 'y' };
    expect(describeApprovalAction('BackgroundRun', {}, display)).toBe('run background command');
    expect(describeApprovalAction('Edit', {}, display)).toBe('edit file');
  });

  it('last-resort label is `call <toolName>`', () => {
    expect(
      describeApprovalAction('UnknownTool', {}, { kind: 'generic', title: 'x', body: 'y' }),
    ).toBe('call UnknownTool');
  });

  it('MCP tools collapse to a per-inner-tool label so approve_for_session groups calls', () => {
    const display: ApprovalDisplay = { kind: 'generic', title: 'x', body: 'y' };
    expect(describeApprovalAction('mcp__files__get_files', {}, display)).toBe(
      'call MCP tool: get_files',
    );
    expect(describeApprovalAction('mcp__other__get_files', {}, display)).toBe(
      'call MCP tool: get_files',
    );
  });

  it('MCP name without a separator falls back to generic `call <toolName>`', () => {
    const display: ApprovalDisplay = { kind: 'generic', title: 'x', body: 'y' };
    expect(describeApprovalAction('mcp__onlyserver', {}, display)).toBe('call mcp__onlyserver');
  });
});

describe('actionToRulePattern', () => {
  it('maps known actions to canonical tool patterns', () => {
    expect(actionToRulePattern('run command', 'Bash')).toBe('Bash');
    expect(actionToRulePattern('edit file', 'Write')).toBe('Write');
    expect(actionToRulePattern('stop background task', 'BackgroundStop')).toBe('BackgroundStop');
  });

  it('falls back to the provided tool name for unknown actions', () => {
    expect(actionToRulePattern('call MyCustomTool', 'MyCustomTool')).toBe('MyCustomTool');
  });
});
