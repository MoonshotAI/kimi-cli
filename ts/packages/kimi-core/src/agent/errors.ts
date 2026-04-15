/**
 * Agent module errors — Slice 3.1.
 */

export class AgentSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentSpecError';
  }
}

export class AgentInheritanceCycleError extends AgentSpecError {
  readonly chain: readonly string[];

  constructor(chain: readonly string[]) {
    super(`Agent inheritance cycle detected: ${chain.join(' → ')}`);
    this.name = 'AgentInheritanceCycleError';
    this.chain = chain;
  }
}

export class AgentNotFoundError extends AgentSpecError {
  readonly agentName: string;

  constructor(name: string) {
    super(`Agent not found: ${name}`);
    this.name = 'AgentNotFoundError';
    this.agentName = name;
  }
}

export class AgentYamlError extends AgentSpecError {
  constructor(message: string) {
    super(message);
    this.name = 'AgentYamlError';
  }
}
