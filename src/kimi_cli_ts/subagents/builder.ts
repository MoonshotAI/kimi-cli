/**
 * Subagent builder — corresponds to Python subagents/builder.py
 * Constructs subagent instances from type definitions.
 */

import { type Runtime, type Agent, loadAgent } from "../soul/agent.ts";
import { cloneLlmWithModelAlias } from "../llm.ts";
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
		const effectiveModel = SubagentBuilder.resolveEffectiveModel({
			typeDef: opts.typeDef,
			launchSpec: opts.launchSpec,
		});

		// Clone LLM with model alias if effective model differs from root
		const llmOverride = cloneLlmWithModelAlias(
			this._rootRuntime.llm,
			this._rootRuntime.config,
			effectiveModel,
			{ sessionId: this._rootRuntime.session.id },
		);

		// Create a subagent runtime copy
		const runtime = this._rootRuntime.copyForSubagent({
			agentId: opts.agentId,
			subagentType: opts.launchSpec.subagentType,
			llmOverride,
		});

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
