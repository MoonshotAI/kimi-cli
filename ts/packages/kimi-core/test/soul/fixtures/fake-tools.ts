/**
 * Test fixtures — minimal v2 Tool implementations used by the run-turn /
 * before-tool-call / after-tool-call / overrides / event-sink tests.
 *
 * Every tool is deterministic: it records invocations in its own `calls`
 * array, so tests can assert "this tool was called N times with these
 * args" and "this tool was NOT called" interchangeably.
 */

import { z } from 'zod';

import type { Tool, ToolResult, ToolUpdate } from '../../../src/soul/index.js';

// ── Echo tool: always succeeds, returns `content = args.text` ──────────

export interface EchoInput {
  text: string;
}

export class EchoTool implements Tool<EchoInput> {
  readonly name: string = 'echo';
  readonly description: string = 'Return the input text unchanged.';
  readonly inputSchema: z.ZodType<EchoInput> = z.object({ text: z.string() });
  readonly calls: { id: string; args: EchoInput }[] = [];

  async execute(
    toolCallId: string,
    args: EchoInput,
    _signal: AbortSignal,
    _onUpdate?: (update: ToolUpdate) => void,
  ): Promise<ToolResult> {
    this.calls.push({ id: toolCallId, args });
    return { content: args.text };
  }
}

// ── Failing tool: always throws a non-abort Error ──────────────────────

export type FailingInput = Record<string, unknown>;

export class FailingTool implements Tool<FailingInput> {
  readonly name: string = 'fail';
  readonly description: string = 'Always throws.';
  readonly inputSchema: z.ZodType<FailingInput> = z.record(z.string(), z.unknown());
  readonly calls: { id: string; args: FailingInput }[] = [];
  readonly errorMessage: string;

  constructor(errorMessage = 'tool blew up') {
    this.errorMessage = errorMessage;
  }

  async execute(toolCallId: string, args: FailingInput): Promise<ToolResult> {
    this.calls.push({ id: toolCallId, args });
    throw new Error(this.errorMessage);
  }
}

// ── Slow tool: awaits until signal fires, then throws AbortError ───────

export type SlowInput = Record<string, unknown>;

export class SlowTool implements Tool<SlowInput> {
  readonly name: string = 'slow';
  readonly description: string = 'Blocks until aborted.';
  readonly inputSchema: z.ZodType<SlowInput> = z.record(z.string(), z.unknown());
  readonly calls: { id: string; args: SlowInput }[] = [];

  async execute(toolCallId: string, args: SlowInput, signal: AbortSignal): Promise<ToolResult> {
    this.calls.push({ id: toolCallId, args });
    return new Promise<ToolResult>((_resolve, reject) => {
      const onAbort = (): void => {
        signal.removeEventListener('abort', onAbort);
        const err = new Error('slow tool cancelled');
        err.name = 'AbortError';
        reject(err);
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort);
    });
  }
}

// ── Progress tool: emits two onUpdate chunks then resolves ────────────

export type ProgressInput = Record<string, unknown>;

export class ProgressTool implements Tool<ProgressInput> {
  readonly name: string = 'progress';
  readonly description: string = 'Streams two progress updates before returning.';
  readonly inputSchema: z.ZodType<ProgressInput> = z.record(z.string(), z.unknown());
  readonly calls: { id: string; args: ProgressInput }[] = [];

  async execute(
    toolCallId: string,
    args: ProgressInput,
    _signal: AbortSignal,
    onUpdate?: (update: ToolUpdate) => void,
  ): Promise<ToolResult> {
    this.calls.push({ id: toolCallId, args });
    onUpdate?.({ kind: 'stdout', text: 'working...' });
    onUpdate?.({ kind: 'progress', percent: 50 });
    return { content: 'done' };
  }
}

// ── Strict-args tool: rejects anything not matching { value: number } ─

export interface StrictInput {
  value: number;
}

export class StrictArgsTool implements Tool<StrictInput> {
  readonly name: string = 'strict';
  readonly description: string = 'Requires { value: number }.';
  readonly inputSchema: z.ZodType<StrictInput> = z.object({ value: z.number() });
  readonly calls: { id: string; args: StrictInput }[] = [];

  async execute(toolCallId: string, args: StrictInput): Promise<ToolResult> {
    this.calls.push({ id: toolCallId, args });
    return { content: `value=${String(args.value)}` };
  }
}
