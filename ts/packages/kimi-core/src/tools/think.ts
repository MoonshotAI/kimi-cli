/**
 * ThinkTool — no-op reasoning tool (Slice 3.5).
 *
 * Ports Python `kimi_cli/tools/think/__init__.py`. Gives the LLM a
 * structured place to record intermediate reasoning steps — acts as an
 * extended-thinking workaround for models that lack native thinking
 * tokens. The tool produces no side effects and always returns success.
 */

import { z } from 'zod';

import type { ToolResult, ToolUpdate, ToolMetadata } from '../soul/types.js';
import type { BuiltinTool } from './types.js';

// ── Input schema ─────────────────────────────────────────────────────

export interface ThinkInput {
  thought: string;
}

const _rawThinkInputSchema = z.object({
  thought: z.string().describe('Your thought process.'),
});

export const ThinkInputSchema: z.ZodType<ThinkInput> = _rawThinkInputSchema;

// ── Tool description ─────────────────────────────────────────────────

const DESCRIPTION =
  'Use this tool to think about something. It will not produce any output or take any action. ' +
  'Use it when you need to reason through a problem step by step before deciding what to do next.';

// ── Implementation ───────────────────────────────────────────────────

export class ThinkTool implements BuiltinTool<ThinkInput, void> {
  readonly name = 'Think' as const;
  readonly metadata: ToolMetadata = { source: 'builtin' };
  readonly description: string = DESCRIPTION;
  readonly inputSchema: z.ZodType<ThinkInput> = ThinkInputSchema;

  async execute(
    _toolCallId: string,
    _args: ThinkInput,
    _signal: AbortSignal,
    _onUpdate?: (update: ToolUpdate) => void,
  ): Promise<ToolResult<void>> {
    return { content: '', isError: false };
  }

  getActivityDescription(_args: ThinkInput): string {
    return 'Thinking…';
  }
}
