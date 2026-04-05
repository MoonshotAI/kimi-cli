/**
 * Subagent run spec and prepare_soul pipeline — corresponds to Python subagents/core.py
 */

import { writeFileSync } from "node:fs";

import type { Runtime } from "../soul/agent.ts";
import { Agent } from "../soul/agent.ts";
import { KimiSoul } from "../soul/kimisoul.ts";
import { Context } from "../soul/context.ts";
import type { AgentLaunchSpec, AgentTypeDefinition } from "./models.ts";
import type { SubagentBuilder } from "./builder.ts";
import type { SubagentStore } from "./store.ts";
import { collectGitContext } from "./git_context.ts";

export interface SubagentRunSpec {
	readonly agentId: string;
	readonly typeDef: AgentTypeDefinition;
	readonly launchSpec: AgentLaunchSpec;
	readonly prompt: string;
	readonly resumed: boolean;
}

/**
 * Build agent, restore context, handle system prompt, write prompt file.
 * Returns [soul, finalPrompt] ready for execution.
 * Corresponds to Python subagents/core.py:prepare_soul.
 */
export async function prepareSoul(
	spec: SubagentRunSpec,
	runtime: Runtime,
	builder: SubagentBuilder,
	store: SubagentStore,
	onStage?: (name: string) => void,
): Promise<[KimiSoul, string]> {
	// 1. Build agent from type definition
	let agent = await builder.buildBuiltinInstance({
		agentId: spec.agentId,
		typeDef: spec.typeDef,
		launchSpec: spec.launchSpec,
	});
	onStage?.("agent_built");

	// 2. Restore conversation context
	const context = new Context(store.contextPath(spec.agentId));
	await context.restore();
	onStage?.("context_restored");

	// 3. System prompt: reuse persisted prompt on resume, persist on first run
	if (context.systemPrompt !== null) {
		// On resume, override the agent's system prompt with the persisted one.
		agent = new Agent({
			name: agent.name,
			systemPrompt: context.systemPrompt,
			toolset: agent.toolset,
			runtime: agent.runtime,
			slashCommands: agent.slashCommands,
		});
	} else {
		await context.writeSystemPrompt(agent.systemPrompt);
	}
	onStage?.("context_ready");

	// 4. For new (non-resumed) explore agents, prepend git context
	let prompt = spec.prompt;
	if (spec.typeDef.name === "explore" && !spec.resumed) {
		const gitCtx = await collectGitContext(runtime.builtinArgs.KIMI_WORK_DIR);
		if (gitCtx) {
			prompt = `${gitCtx}\n\n${prompt}`;
		}
	}

	// 5. Write prompt snapshot (debugging aid)
	try {
		writeFileSync(store.promptPath(spec.agentId), prompt, "utf-8");
	} catch {
		// Best effort
	}

	// 6. Create soul
	const soul = new KimiSoul({ agent, context });
	return [soul, prompt];
}
