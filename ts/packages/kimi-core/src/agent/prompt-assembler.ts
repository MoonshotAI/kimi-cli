/**
 * System prompt assembler — Slice 3.1.
 *
 * Assembles the final system prompt string from an AgentSpec:
 *   1. Read system prompt text (from `spec.systemPrompt` or `spec.systemPromptPath`)
 *   2. Expand template variables
 *   3. Return the final string
 *
 * This is the upstream producer for `ChatParams.systemPrompt` (Slice 2.0).
 * The upper-layer app calls this before constructing SoulPlus, then passes
 * the result to ContextState.systemPrompt (host-injected pattern).
 */

import { AgentSpecError } from './errors.js';
import { loadSystemPromptFile } from './loader.js';
import { expandTemplate } from './template.js';
import type { AgentSpec, TemplateContext } from './types.js';

/**
 * Assemble the final system prompt from an agent spec.
 *
 * @param spec     — resolved AgentSpec (inheritance already applied)
 * @param context  — template variable context
 * @returns The final system prompt string with variables expanded.
 */
export function assembleSystemPrompt(spec: AgentSpec, context: TemplateContext): string {
  let raw: string;

  if (spec.systemPrompt !== undefined) {
    raw = spec.systemPrompt;
  } else if (spec.systemPromptPath !== undefined) {
    raw = loadSystemPromptFile(spec.systemPromptPath);
  } else {
    throw new AgentSpecError(`Agent "${spec.name}" has neither systemPrompt nor systemPromptPath`);
  }

  return expandTemplate(raw, context);
}
