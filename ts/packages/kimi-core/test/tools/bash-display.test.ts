/**
 * Slice 5 / 决策 #98: BashTool display-hook demonstration path.
 *
 * BashTool is the reference implementation the Phase 5 Implementer wires
 * end-to-end so Wire / approval / transcript can render `command` /
 * `command_output` kinds without hardcoding `input.command` field names.
 *
 * Pins:
 *   - `BashTool.display.getInputDisplay(args)` returns `{ kind: 'command',
 *     command: args.command, cwd?: args.cwd }`.
 *   - `BashTool.display.getResultDisplay(args, result)` returns
 *     `{ kind: 'command_output', exitCode, stdout?, stderr? }` and threads
 *     `result.output.exitCode` / `.stdout` / `.stderr`.
 *   - `display.getUserFacingName` may be absent (defaults to `tool.name`),
 *     but when present must return `'Bash'`.
 *
 * Expected to FAIL before Phase 5: current BashTool (see src/tools/bash.ts)
 * only defines `getActivityDescription` directly on the class — no
 * `display` field exists yet.
 */

import { describe, expect, it } from 'vitest';

import { BashTool } from '../../src/tools/index.js';
import type { BashInput, BashOutput } from '../../src/tools/index.js';
import type { ToolInputDisplay, ToolResult, ToolResultDisplay } from '../../src/soul/types.js';
import { createFakeKaos } from './fixtures/fake-kaos.js';

function makeBashTool(): BashTool {
  // kaos is never invoked in display-only tests — display hooks are pure
  // functions over `input` / `result`. Pass a minimal fake so the class
  // instantiates.
  const kaos = createFakeKaos();
  return new BashTool(kaos, '/workspace');
}

describe('BashTool.display (决策 #98 demo path)', () => {
  it('getInputDisplay maps args.command → { kind: "command", command }', () => {
    const tool = makeBashTool();
    const display = tool.display;
    expect(display).toBeDefined();
    expect(display?.getInputDisplay).toBeTypeOf('function');

    const args: BashInput = { command: 'ls -la' };
    const hint = display!.getInputDisplay!(args) as ToolInputDisplay;
    expect(hint.kind).toBe('command');
    if (hint.kind === 'command') {
      expect(hint.command).toBe('ls -la');
    }
  });

  it('getInputDisplay threads args.cwd into the `cwd` field when present', () => {
    const tool = makeBashTool();
    const args: BashInput = { command: 'pwd', cwd: '/tmp/here' };
    const hint = tool.display!.getInputDisplay!(args) as ToolInputDisplay;
    if (hint.kind !== 'command') throw new Error(`expected command, got ${hint.kind}`);
    expect(hint.cwd).toBe('/tmp/here');
  });

  it('getResultDisplay threads exit_code / stdout / stderr from result.output (v2 §10.7.3 snake_case)', () => {
    const tool = makeBashTool();
    const args: BashInput = { command: 'echo hi' };
    const result: ToolResult<BashOutput> = {
      content: 'hi\n',
      output: { exitCode: 0, stdout: 'hi\n', stderr: '' },
    };
    const hint = tool.display!.getResultDisplay!(args, result) as ToolResultDisplay;
    expect(hint.kind).toBe('command_output');
    if (hint.kind === 'command_output') {
      expect(hint.exit_code).toBe(0);
      expect(hint.stdout).toBe('hi\n');
      expect(hint.stderr ?? '').toBe('');
    }
  });

  it('getResultDisplay preserves non-zero exit_code for error results', () => {
    const tool = makeBashTool();
    const args: BashInput = { command: 'false' };
    const result: ToolResult<BashOutput> = {
      content: '',
      isError: true,
      output: { exitCode: 1, stdout: '', stderr: 'fail' },
    };
    const hint = tool.display!.getResultDisplay!(args, result) as ToolResultDisplay;
    if (hint.kind !== 'command_output') throw new Error(`expected command_output`);
    expect(hint.exit_code).toBe(1);
    expect(hint.stderr).toBe('fail');
  });

  it('when getUserFacingName is present, it returns "Bash"', () => {
    const tool = makeBashTool();
    const hook = tool.display?.getUserFacingName;
    if (hook === undefined) return; // allowed; fallback to tool.name is fine.
    expect(hook(undefined)).toBe('Bash');
  });

  // Phase 14 §1.1 — language field pins the UI dialect hint so the
  // renderer can pick between bash and powershell highlighting.
  it("getInputDisplay returns language='bash' on a POSIX environment", () => {
    const tool = makeBashTool();
    const hint = tool.display!.getInputDisplay!({ command: 'ls' }) as ToolInputDisplay;
    if (hint.kind !== 'command') throw new Error('expected command');
    expect(hint.language).toBe('bash');
  });

  it("getInputDisplay returns language='powershell' when shellName is Windows PowerShell", () => {
    const kaos = createFakeKaos();
    const env = {
      osKind: 'Windows' as const,
      osArch: 'x64',
      osVersion: '10',
      shellName: 'Windows PowerShell' as const,
      shellPath: 'C:\\\\powershell.exe',
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tool = new (BashTool as any)(kaos, '/workspace', env) as BashTool;
    const hint = tool.display!.getInputDisplay!({ command: 'dir' }) as ToolInputDisplay;
    if (hint.kind !== 'command') throw new Error('expected command');
    expect(hint.language).toBe('powershell');
  });
});
