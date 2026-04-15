/**
 * Agent module — unified entry point (Slice 3.1).
 */

// Types
export type { AgentSpec, SkillFilter, TemplateContext, ToolFilter } from './types.js';

// Errors
export {
  AgentInheritanceCycleError,
  AgentNotFoundError,
  AgentSpecError,
  AgentYamlError,
} from './errors.js';

// YAML parser (for direct usage / testing)
export { parseAgentYaml } from './yaml-parser.js';

// Loader
export { loadAgentFile, loadSystemPromptFile, parseAgentSpec } from './loader.js';

// Inheritance
export { resolveInheritance } from './inherit.js';
export type { AgentLookup } from './inherit.js';

// Template
export { expandTemplate } from './template.js';

// Filter
export { applySkillFilter, applyToolFilter } from './filter.js';

// Registry
export { AgentRegistry } from './registry.js';

// Prompt assembler
export { assembleSystemPrompt } from './prompt-assembler.js';

// Default agent
export { DEFAULT_AGENT, DEFAULT_SYSTEM_PROMPT } from './default-agent.js';
