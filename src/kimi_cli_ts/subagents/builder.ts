/**
 * Subagent builder — corresponds to Python subagents/builder.py
 * Constructs subagent instances from type definitions.
 */

import { type Runtime, type Agent, loadAgent } from "../soul/agent.ts";
import type { AgentLaunchSpec, AgentTypeDefinition } from "./models.ts";

export class SubagentBuilder {
  private _rootRuntime: Runtime;

  constructor(rootRuntime: Runtime) {
    this._rootRuntime = rootRuntime;
  }

  /**
   * Build a subagent Agent instance from a type definition and launch spec.
   * Corresponds to Python SubagentBuilder.build_builtin_instance().
   */
  async buildBuiltinInstance(opts: {
    agentId: string;
    typeDef: AgentTypeDefinition;
    launchSpec: AgentLaunchSpec;
  }): Promise<Agent> {
    const _effectiveModel = SubagentBuilder.resolveEffectiveModel({
      typeDef: opts.typeDef,
      launchSpec: opts.launchSpec,
    });

    // Create a subagent runtime copy
    const runtime = this._rootRuntime.copyForSubagent();

    // TODO: If effectiveModel differs from root, clone LLM with model alias.
    // For now, subagents inherit the root LLM.

    return await loadAgent({
      runtime,
      agentName: opts.typeDef.agentFile,
    });
  }

  /**
   * Determine the effective model for a subagent launch.
   * Priority: launch spec override > launch spec effective > type definition default.
   */
  static resolveEffectiveModel(opts: {
    typeDef: AgentTypeDefinition;
    launchSpec: AgentLaunchSpec;
  }): string | undefined {
    return (
      opts.launchSpec.modelOverride ??
      opts.launchSpec.effectiveModel ??
      opts.typeDef.defaultModel
    );
  }
}
