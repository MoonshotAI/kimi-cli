/**
 * Tool system barrel (Slice 4) — NOT re-exported from `src/index.ts`.
 *
 * Direct import: `import { ToolRegistry, ReadTool } from '../../src/tools/index.js';`
 */

// ── Type definitions + schemas ─────────────────────────────────────────

export type {
  BuiltinTool,
  ReadInput,
  ReadOutput,
  WriteInput,
  WriteOutput,
  EditInput,
  EditOutput,
  BashInput,
  BashOutput,
  GrepInput,
  GrepOutput,
  GlobInput,
  GlobOutput,
} from './types.js';

export {
  ReadInputSchema,
  ReadOutputSchema,
  WriteInputSchema,
  WriteOutputSchema,
  EditInputSchema,
  EditOutputSchema,
  BashInputSchema,
  BashOutputSchema,
  GrepInputSchema,
  GrepOutputSchema,
  GlobInputSchema,
  GlobOutputSchema,
} from './types.js';

// ── Registry ───────────────────────────────────────────────────────────

export { ToolRegistry } from './registry.js';
export type { ToolSource, ToolConflict, ToolRegistryOptions } from './registry.js';

// ── Workspace + path safety (§14.3 D11) ────────────────────────────────

export type { WorkspaceConfig } from './workspace.js';
export {
  PathSecurityError,
  assertPathAllowed,
  canonicalizePath,
  isWithinDirectory,
  isWithinWorkspace,
} from './path-guard.js';
export type { PathSecurityCode, AssertPathOptions } from './path-guard.js';
export { isSensitiveFile } from './sensitive.js';

// ── Built-in tools ─────────────────────────────────────────────────────

export { ReadTool } from './read.js';
export { WriteTool } from './write.js';
export { EditTool } from './edit.js';
export { BashTool } from './bash.js';
export { GrepTool } from './grep.js';
export { GlobTool, MAX_MATCHES as GLOB_MAX_MATCHES } from './glob.js';

// ── Collaboration tools (Slice 7) ─────────────────────────────────────

export { AgentTool, AgentToolInputSchema, AgentToolOutputSchema } from './agent.js';
export type { AgentToolInput, AgentToolOutput } from './agent.js';
