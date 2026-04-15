/**
 * Template expansion tests — Slice 3.1.
 */

import { describe, expect, it } from 'vitest';

import { expandTemplate } from '../../src/agent/template.js';
import type { TemplateContext } from '../../src/agent/types.js';

const baseContext: TemplateContext = {
  workspaceDir: '/home/user/project',
  userName: 'alice',
  os: 'linux',
  date: '2025-01-15',
  kimiSkills: '- commit\n- review',
  kimiHome: '/home/user/.kimi',
};

describe('expandTemplate', () => {
  it('expands SCREAMING_SNAKE variables to context values', () => {
    const tpl = 'Dir: ${WORKSPACE_DIR}, User: ${USER_NAME}';
    expect(expandTemplate(tpl, baseContext)).toBe('Dir: /home/user/project, User: alice');
  });

  it('expands ${KIMI_SKILLS}', () => {
    const tpl = 'Skills:\n${KIMI_SKILLS}';
    expect(expandTemplate(tpl, baseContext)).toBe('Skills:\n- commit\n- review');
  });

  it('expands ${OS} and ${DATE}', () => {
    const tpl = 'OS: ${OS}, Date: ${DATE}';
    expect(expandTemplate(tpl, baseContext)).toBe('OS: linux, Date: 2025-01-15');
  });

  it('expands ${KIMI_HOME}', () => {
    const tpl = 'Home: ${KIMI_HOME}';
    expect(expandTemplate(tpl, baseContext)).toBe('Home: /home/user/.kimi');
  });

  it('preserves unknown variables as-is', () => {
    const tpl = 'Hello ${UNKNOWN_VAR}!';
    expect(expandTemplate(tpl, baseContext)).toBe('Hello ${UNKNOWN_VAR}!');
  });

  it('preserves known variable placeholder when context value is undefined', () => {
    const sparseContext: TemplateContext = { workspaceDir: '/tmp' };
    const tpl = 'User: ${USER_NAME}';
    expect(expandTemplate(tpl, sparseContext)).toBe('User: ${USER_NAME}');
  });

  it('handles template with no variables', () => {
    const tpl = 'No variables here.';
    expect(expandTemplate(tpl, baseContext)).toBe('No variables here.');
  });

  it('handles empty template', () => {
    expect(expandTemplate('', baseContext)).toBe('');
  });

  it('handles multiple occurrences of the same variable', () => {
    const tpl = '${OS} and ${OS}';
    expect(expandTemplate(tpl, baseContext)).toBe('linux and linux');
  });

  it('supports direct camelCase key lookup', () => {
    const ctx: TemplateContext = {
      workspaceDir: '/tmp',
      customVar: 'hello',
    };
    const tpl = '${customVar}';
    expect(expandTemplate(tpl, ctx)).toBe('hello');
  });
});
