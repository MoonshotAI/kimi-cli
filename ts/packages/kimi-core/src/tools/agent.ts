/**
 * AgentTool — collaboration tool for spawning task subagents (v2 §7.2).
 *
 * This is a "collaboration tool" (v2 §9-F.5), distinct from builtin tools
 * (Read/Write/Edit/Bash/Grep/Glob). It uses `SubagentHost` (injected via
 * constructor, NOT via Runtime — to create same-process
 * subagent Soul instances.
 *
 * Two modes:
 *   - **Foreground** (default): blocks the parent turn, `await handle.completion`
 *   - **Background**: returns immediately with agent id, result delivered
 *     via notification
 *
 * Slice 5.3 — foreground + background execution paths implemented.
 * Python parity: `kimi_cli.tools.agent.__init__.AgentTool` (text-form
 * `ToolResult.content`; structured output via `AgentToolOutputSchema` is
 * drift-guard only, not consumed at runtime — see TD1).
 */

import { z } from 'zod';

import type { AgentTypeRegistry } from '../soul-plus/agent-type-registry.js';
import type { SpawnRequest, SubagentHost } from '../soul-plus/subagent-types.js';
import type { ToolResult, ToolUpdate } from '../soul/types.js';
import type { BackgroundProcessManager } from './background/manager.js';

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
    private readonly backgroundManager?: BackgroundProcessManager | undefined,
    private readonly typeRegistry?: AgentTypeRegistry | undefined,
  ) {}

  async execute(
    toolCallId: string,
    args: AgentToolInput,
    signal: AbortSignal,
    _onUpdate?: (update: ToolUpdate) => void,
  ): Promise<ToolResult> {
    try {
      const agentName = args.agentName ?? 'coder';

      // Guard: reject background execution if the agent type does not support it
      if (args.runInBackground && this.typeRegistry?.has(agentName)) {
        const typeDef = this.typeRegistry.resolve(agentName);
        if (typeDef.supportsBackground === false) {
          return {
            content: `Agent type "${agentName}" does not support background execution. ` +
              'Run it in foreground instead.',
            isError: true,
          };
        }
      }

      const request: SpawnRequest = {
        parentAgentId: this.parentAgentId,
        parentToolCallId: toolCallId,
        agentName,
        prompt: args.prompt,
        description: args.description,
        runInBackground: args.runInBackground ?? false,
        model: args.model,
        signal,
      };

      const handle = await this.subagentHost.spawn(request);

      if (args.runInBackground) {
        // Background: register with BPM if available, else fire-and-forget
        let taskId = 'none';
        if (this.backgroundManager !== undefined) {
          taskId = this.backgroundManager.registerAgentTask(
            handle.completion,
            args.description,
          );
        } else {
          void handle.completion.catch(() => {});
        }
        const lines = [
          `task_id: ${taskId}`,
          'status: running',
          `agent_id: ${handle.agentId}`,
          'automatic_notification: true',
          '',
          `description: ${args.description}`,
        ];
        return { content: lines.join('\n') };
      }

      // Foreground: await completion, format Python-parity output
      const result = await handle.completion;
      const lines = [
        `agent_id: ${handle.agentId}`,
        'resumed: false',
        `actual_subagent_type: ${request.agentName}`,
        'status: completed',
        '',
        '[summary]',
        result.result,
      ];
      return { content: lines.join('\n') };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: `subagent error: ${message}`, isError: true };
    }
  }
}
