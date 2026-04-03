/**
 * Agent tool — spawn subagent instances.
 * Corresponds to Python tools/agent/__init__.py
 */

import { z } from "zod/v4";
import { CallableTool } from "../base.ts";
import type { ToolContext, ToolResult } from "../types.ts";
import { ToolError, ToolOk } from "../types.ts";
import type { Runtime } from "../../soul/agent.ts";
import type { AgentTypeDefinition } from "../../subagents/models.ts";
import {
  ForegroundSubagentRunner,
  type ForegroundRunRequest,
} from "../../subagents/runner.ts";
import { logger } from "../../utils/logging.ts";

const MAX_FOREGROUND_TIMEOUT = 60 * 60; // 1 hour
const MAX_BACKGROUND_TIMEOUT = 60 * 60; // 1 hour

const DESCRIPTION = `Start a subagent instance to work on a focused task.

**Usage:**
- Always provide a short \`description\` (3-5 words).
- Use \`subagent_type\` to select a built-in agent type. If omitted, \`coder\` is used.
- Use \`model\` when you need to override the default model.
- Default to foreground execution. Use \`run_in_background=true\` only when needed.
- Be explicit about whether the subagent should write code or only do research.
- The subagent result is only visible to you. If the user should see it, summarize it yourself.`;

const ParamsSchema = z.object({
  description: z
    .string()
    .describe("A short (3-5 word) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z
    .string()
    .default("coder")
    .describe("The built-in agent type to use. Defaults to `coder`."),
  model: z
    .string()
    .nullish()
    .describe(
      "Optional model override. Selection priority is: this parameter, then the built-in " +
        "type default model, then the parent agent's current model.",
    ),
  resume: z
    .string()
    .nullish()
    .describe(
      "Optional agent ID to resume instead of creating a new instance.",
    ),
  run_in_background: z
    .boolean()
    .default(false)
    .describe(
      "Whether to run the agent in the background. Prefer false unless the task can " +
        "continue independently and there is a clear benefit to returning control before " +
        "the result is needed.",
    ),
  timeout: z
    .number()
    .int()
    .min(30)
    .max(MAX_BACKGROUND_TIMEOUT)
    .nullish()
    .describe(
      "Timeout in seconds for the agent task. " +
        "Foreground: no default timeout (runs until completion), max 3600s (1hr). " +
        "Background: default from config (15min), max 3600s (1hr). " +
        "The agent is stopped if it exceeds this limit.",
    ),
});

type Params = z.infer<typeof ParamsSchema>;

export class AgentTool extends CallableTool<typeof ParamsSchema> {
  readonly name = "Agent";
  readonly schema = ParamsSchema;
  private _description: string;

  get description(): string {
    return this._description;
  }

  constructor() {
    super();
    this._description = DESCRIPTION;
  }

  /**
   * Build the full description including available builtin types.
   * Should be called after the tool is registered and runtime is available.
   */
  buildDescription(runtime: Runtime): void {
    const typeLines = AgentTool._builtinTypeLines(runtime);
    if (typeLines) {
      this._description =
        DESCRIPTION + "\n\n**Available subagent types:**\n" + typeLines;
    }
  }

  private static _builtinTypeLines(runtime: Runtime): string {
    if (!runtime.laborMarket) return "";
    const lines: string[] = [];
    for (const [name, typeDef] of runtime.laborMarket.builtinTypes) {
      const toolNames = AgentTool._toolSummary(typeDef);
      const model = typeDef.defaultModel ?? "inherit";
      const suffix = typeDef.whenToUse
        ? ` When to use: ${AgentTool._normalizeSummary(typeDef.whenToUse)}`
        : "";
      const background = typeDef.supportsBackground ? "yes" : "no";
      lines.push(
        `- \`${name}\`: ${typeDef.description} ` +
          `(Tools: ${toolNames}, Model: ${model}, Background: ${background}).${suffix}`,
      );
    }
    return lines.join("\n");
  }

  private static _normalizeSummary(text: string): string {
    return text.split(/\s+/).join(" ");
  }

  private static _toolSummary(typeDef: AgentTypeDefinition): string {
    if (typeDef.toolPolicy.mode !== "allowlist") return "*";
    if (typeDef.toolPolicy.tools.length === 0) return "(none)";
    return AgentTool._uniqueToolNames(typeDef.toolPolicy.tools).join(", ");
  }

  private static _uniqueToolNames(toolPaths: readonly string[]): string[] {
    const names: string[] = [];
    for (const path of toolPaths) {
      const name = path.split(":").pop() ?? path;
      if (!names.includes(name)) {
        names.push(name);
      }
    }
    return names;
  }

  async execute(params: Params, ctx: ToolContext): Promise<ToolResult> {
    const runtime = ctx.runtime;
    if (!runtime) {
      return ToolError("Agent tool requires runtime context.");
    }

    if (runtime.role !== "root") {
      return ToolError("Subagents cannot launch other subagents.");
    }

    if (params.model != null && params.model !== "") {
      // Validate model alias exists in config
      if (
        runtime.config.models &&
        !(params.model in runtime.config.models)
      ) {
        return ToolError(`Unknown model alias: ${params.model}`);
      }
    }

    if (params.run_in_background) {
      return this._runInBackground(params, runtime);
    }

    return this._runForeground(params, runtime);
  }

  private async _runForeground(
    params: Params,
    runtime: Runtime,
  ): Promise<ToolResult> {
    const timeout = params.timeout ?? undefined;
    try {
      const runner = new ForegroundSubagentRunner(runtime);
      const req: ForegroundRunRequest = {
        description: params.description,
        prompt: params.prompt,
        requestedType: params.subagent_type || "coder",
        model: params.model ?? undefined,
        resume: params.resume ?? undefined,
      };

      if (timeout != null) {
        // Run with timeout
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout * 1000);
        try {
          return await runner.run(req);
        } finally {
          clearTimeout(timer);
        }
      }

      return await runner.run(req);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        logger.warn(`Foreground agent timed out after ${timeout}s`);
        return ToolError(`Agent timed out after ${timeout}s.`);
      }
      logger.error(`Foreground agent run failed: ${err}`);
      return ToolError(`Failed to run agent: ${err}`);
    }
  }

  private async _runInBackground(
    params: Params,
    _runtime: Runtime,
  ): Promise<ToolResult> {
    // Background agent execution requires the background task system
    // which will be implemented as part of the background runner migration.
    return ToolError(
      "Background subagent execution is not yet implemented in this version.",
    );
  }
}
