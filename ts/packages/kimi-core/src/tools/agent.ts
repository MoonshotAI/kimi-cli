/**
 * AgentTool — collaboration tool for spawning task subagents (v2 §7.2).
 *
 * This is a "collaboration tool" (v2 §9-F.5), distinct from builtin tools
 * (Read/Write/Edit/Bash/Grep/Glob). It uses `SubagentHost` (injected via
 * constructor, NOT via Runtime — CLAUDE.md §7) to create same-process
 * subagent Soul instances.
 *
 * Two modes:
 *   - **Foreground** (default): blocks the parent turn, `await handle.completion`
 *   - **Background**: returns immediately with agent id, result delivered
 *     via notification
 *
 * Slice 7 stub: `execute()` throws — the implementer fills it in.
 */

import { z } from 'zod';

import type { SpawnRequest, SubagentHost } from '../soul-plus/subagent-types.js';
import type { ToolResult, ToolUpdate } from '../soul/types.js';

// ── Drift-guard utility ──────────────────────────────────────────────

type AssertEqual<T, U> = [T] extends [U] ? ([U] extends [T] ? true : false) : false;

// ── AgentTool input (v2 附录 E / §7.2) ──────────────────────────────

export interface AgentToolInput {
  prompt: string;
  description: string;
  agentName?: string | undefined;
  runInBackground?: boolean | undefined;
  model?: string | undefined;
}

const _rawAgentToolInputSchema = z.object({
  prompt: z.string().describe('Full task prompt for the subagent'),
  description: z.string().describe('Short task description (3-5 words) for UI display'),
  agentName: z.string().optional().describe('Subagent type from the agent registry'),
  runInBackground: z
    .boolean()
    .optional()
    .describe('If true, return immediately without waiting for completion'),
  model: z.string().optional().describe('Model override for the subagent'),
});

export const AgentToolInputSchema: z.ZodType<AgentToolInput> = _rawAgentToolInputSchema;

const _dg_AgentToolInput: AssertEqual<
  z.infer<typeof _rawAgentToolInputSchema>,
  AgentToolInput
> = true;
void _dg_AgentToolInput;

// ── AgentTool output (v2 附录 E) ─────────────────────────────────────

export interface AgentToolOutput {
  result: string;
  usage: {
    input: number;
    output: number;
    cache_read?: number | undefined;
    cache_write?: number | undefined;
  };
}

const _rawAgentToolOutputSchema = z.object({
  result: z.string().describe('Aggregated text output from the subagent'),
  usage: z
    .object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
      cache_read: z.number().int().nonnegative().optional(),
      cache_write: z.number().int().nonnegative().optional(),
    })
    .describe('Cumulative token usage'),
});

export const AgentToolOutputSchema: z.ZodType<AgentToolOutput> = _rawAgentToolOutputSchema;

const _dg_AgentToolOutput: AssertEqual<
  z.infer<typeof _rawAgentToolOutputSchema>,
  AgentToolOutput
> = true;
void _dg_AgentToolOutput;

// ── AgentTool class ──────────────────────────────────────────────────

export class AgentTool {
  readonly name: string = 'Agent';
  readonly description: string =
    'Launch a subagent to handle a task. The subagent runs as a same-process ' +
    'Soul instance with its own context and wire file.';
  readonly inputSchema: z.ZodType<AgentToolInput> = AgentToolInputSchema;

  constructor(
    private readonly subagentHost: SubagentHost,
    private readonly parentAgentId: string,
  ) {}

  async execute(
    _toolCallId: string,
    args: AgentToolInput,
    _signal: AbortSignal,
    _onUpdate?: (update: ToolUpdate) => void,
  ): Promise<ToolResult> {
    try {
      const request: SpawnRequest = {
        parentAgentId: this.parentAgentId,
        agentName: args.agentName ?? 'general-purpose',
        prompt: args.prompt,
        description: args.description,
        runInBackground: args.runInBackground ?? false,
        model: args.model,
      };

      const handle = await this.subagentHost.spawn(request);

      if (args.runInBackground) {
        void handle.completion.catch(() => {});
        return { content: `subagent ${handle.agentId} started` };
      }

      const result = await handle.completion;
      return { content: result.result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: `subagent error: ${message}`, isError: true };
    }
  }
}
