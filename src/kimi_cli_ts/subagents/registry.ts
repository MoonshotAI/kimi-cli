/**
 * Subagent type registry — corresponds to Python subagents/registry.py
 * LaborMarket holds the available agent type definitions.
 */

import type { AgentTypeDefinition } from "./models.ts";

export class LaborMarket {
	private _builtinTypes = new Map<string, AgentTypeDefinition>();

	get builtinTypes(): ReadonlyMap<string, AgentTypeDefinition> {
		return this._builtinTypes;
	}

	addBuiltinType(typeDef: AgentTypeDefinition): void {
		this._builtinTypes.set(typeDef.name, typeDef);
	}

	getBuiltinType(name: string): AgentTypeDefinition | undefined {
		return this._builtinTypes.get(name);
	}

	requireBuiltinType(name: string): AgentTypeDefinition {
		const typeDef = this._builtinTypes.get(name);
		if (!typeDef) {
			throw new Error(`Builtin subagent type not found: ${name}`);
		}
		return typeDef;
	}
}
