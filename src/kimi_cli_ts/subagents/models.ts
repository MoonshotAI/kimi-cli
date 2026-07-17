/**
 * Subagent models — corresponds to Python subagents/models.py
 */

export type ToolPolicyMode = "inherit" | "allowlist";
export type SubagentStatus =
	| "idle"
	| "running_foreground"
	| "running_background"
	| "completed"
	| "failed"
	| "killed";

export interface ToolPolicy {
	readonly mode: ToolPolicyMode;
	readonly tools: readonly string[];
}

export interface AgentTypeDefinition {
	readonly name: string;
	readonly description: string;
	readonly agentFile: string;
	readonly whenToUse: string;
	readonly defaultModel?: string;
	readonly toolPolicy: ToolPolicy;
	readonly supportsBackground: boolean;
}

export interface AgentLaunchSpec {
	readonly agentId: string;
	readonly subagentType: string;
	readonly modelOverride?: string;
	readonly effectiveModel?: string;
	readonly createdAt: number;
}

export interface AgentInstanceRecord {
	readonly agentId: string;
	readonly subagentType: string;
	readonly status: SubagentStatus;
	readonly description: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly lastTaskId?: string;
	readonly launchSpec: AgentLaunchSpec;
}

// ── Defaults ──

export function defaultToolPolicy(): ToolPolicy {
	return { mode: "inherit", tools: [] };
}
