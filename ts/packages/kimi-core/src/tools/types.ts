/**
 * Tool system — shared type definitions (Slice 4 scope, §9-F / Appendix E).
 *
 * Uses the Slice 1 three-stage pattern for schema exports:
 *   1. Private `_raw*Schema` — zod-inferred type (no explicit annotation)
 *   2. Public `*Schema: z.ZodType<T>` — explicit interface as type param
 *   3. `AssertEqual` drift guard — compile-time proof that (1) and (2) agree
 */

import { z } from 'zod';

import type { Tool, ToolResult, ToolUpdate } from '../soul/types.js';

// ── Drift-guard utility (same pattern as Slice 1 wire-record.ts) ───────

type AssertEqual<T, U> = [T] extends [U] ? ([U] extends [T] ? true : false) : false;

// ── BuiltinTool extension ──────────────────────────────────────────────

export interface BuiltinTool<Input = unknown, Output = unknown> extends Tool<Input, Output> {
  getActivityDescription(args: Input): string;
}

// Re-export base types for convenience
export type { Tool, ToolResult, ToolUpdate };

// ── Read (Appendix E.1) ───────────────────────────────────────────────

export interface ReadInput {
  path: string;
  offset?: number | undefined;
  limit?: number | undefined;
}

export interface ReadOutput {
  content: string;
  lineCount: number;
}

const _rawReadInputSchema = z.object({
  path: z.string(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
});

const _rawReadOutputSchema = z.object({
  content: z.string(),
  lineCount: z.number().int().nonnegative(),
});

export const ReadInputSchema: z.ZodType<ReadInput> = _rawReadInputSchema;
export const ReadOutputSchema: z.ZodType<ReadOutput> = _rawReadOutputSchema;

const _dg_ReadInput: AssertEqual<z.infer<typeof _rawReadInputSchema>, ReadInput> = true;
const _dg_ReadOutput: AssertEqual<z.infer<typeof _rawReadOutputSchema>, ReadOutput> = true;
void _dg_ReadInput;
void _dg_ReadOutput;

// ── Write (Appendix E.2) ──────────────────────────────────────────────

export interface WriteInput {
  path: string;
  content: string;
}

export interface WriteOutput {
  bytesWritten: number;
}

const _rawWriteInputSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const _rawWriteOutputSchema = z.object({
  bytesWritten: z.number().int().nonnegative(),
});

export const WriteInputSchema: z.ZodType<WriteInput> = _rawWriteInputSchema;
export const WriteOutputSchema: z.ZodType<WriteOutput> = _rawWriteOutputSchema;

const _dg_WriteInput: AssertEqual<z.infer<typeof _rawWriteInputSchema>, WriteInput> = true;
const _dg_WriteOutput: AssertEqual<z.infer<typeof _rawWriteOutputSchema>, WriteOutput> = true;
void _dg_WriteInput;
void _dg_WriteOutput;

// ── Edit (Appendix E.3) ───────────────────────────────────────────────

export interface EditInput {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean | undefined;
}

export interface EditOutput {
  replacementCount: number;
}

// `old_string` must be non-empty: the non-replace_all branch walks
// occurrences with `content.indexOf("", pos)`, which would loop forever
// on an empty search string (Slice 4 audit M7).
const _rawEditInputSchema = z.object({
  path: z.string(),
  old_string: z.string().min(1),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});

const _rawEditOutputSchema = z.object({
  replacementCount: z.number().int().nonnegative(),
});

export const EditInputSchema: z.ZodType<EditInput> = _rawEditInputSchema;
export const EditOutputSchema: z.ZodType<EditOutput> = _rawEditOutputSchema;

const _dg_EditInput: AssertEqual<z.infer<typeof _rawEditInputSchema>, EditInput> = true;
const _dg_EditOutput: AssertEqual<z.infer<typeof _rawEditOutputSchema>, EditOutput> = true;
void _dg_EditInput;
void _dg_EditOutput;

// ── Bash (Appendix E.4) ───────────────────────────────────────────────

export interface BashInput {
  command: string;
  cwd?: string | undefined;
  timeout?: number | undefined;
  description?: string | undefined;
  run_in_background?: boolean | undefined;
}

export interface BashOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// Phase 14 §1.5 — foreground timeout capped at 5 min; background up to 24h.
// Mirrors the runtime clamps (`bash.ts:37-38`) and pushes validation to the
// schema level so Tool callers can't sneak past with oversized values.
export const MAX_FG_TIMEOUT_SEC: number = 5 * 60;
export const MAX_BG_TIMEOUT_SEC: number = 24 * 60 * 60;

const _rawBashInputSchema = z
  .object({
    command: z.string(),
    cwd: z.string().optional(),
    timeout: z.number().int().positive().optional(),
    description: z.string().optional(),
    run_in_background: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.timeout === undefined) return;
    const cap = val.run_in_background ? MAX_BG_TIMEOUT_SEC : MAX_FG_TIMEOUT_SEC;
    if (val.timeout > cap) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['timeout'],
        message: `timeout must be ≤ ${String(cap)}s (${val.run_in_background ? 'background' : 'foreground'})`,
      });
    }
  });

const _rawBashOutputSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
});

export const BashInputSchema: z.ZodType<BashInput> = _rawBashInputSchema;
export const BashOutputSchema: z.ZodType<BashOutput> = _rawBashOutputSchema;

const _dg_BashInput: AssertEqual<z.infer<typeof _rawBashInputSchema>, BashInput> = true;
const _dg_BashOutput: AssertEqual<z.infer<typeof _rawBashOutputSchema>, BashOutput> = true;
void _dg_BashInput;
void _dg_BashOutput;

// ── Grep (Appendix E.5) ───────────────────────────────────────────────

export interface GrepInput {
  pattern: string;
  path?: string | undefined;
  glob?: string | undefined;
  type?: string | undefined;
  output_mode?: 'content' | 'files_with_matches' | 'count' | undefined;
  '-i'?: boolean | undefined;
  '-n'?: boolean | undefined;
  '-A'?: number | undefined;
  '-B'?: number | undefined;
  '-C'?: number | undefined;
  head_limit?: number | undefined;
  offset?: number | undefined;
  multiline?: boolean | undefined;
  include_ignored?: boolean | undefined;
}

export interface GrepOutput {
  mode: 'content' | 'files_with_matches' | 'count';
  numFiles: number;
  filenames: string[];
  content?: string | undefined;
  numLines?: number | undefined;
  numMatches?: number | undefined;
  appliedLimit?: number | undefined;
}

const _rawGrepInputSchema = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  glob: z.string().optional(),
  type: z.string().optional(),
  output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
  '-i': z.boolean().optional(),
  '-n': z.boolean().optional(),
  '-A': z.number().int().nonnegative().optional(),
  '-B': z.number().int().nonnegative().optional(),
  '-C': z.number().int().nonnegative().optional(),
  head_limit: z.number().int().nonnegative().optional(),
  offset: z.number().int().nonnegative().optional(),
  multiline: z.boolean().optional(),
  include_ignored: z.boolean().optional(),
});

const _rawGrepOutputSchema = z.object({
  mode: z.enum(['content', 'files_with_matches', 'count']),
  numFiles: z.number().int().nonnegative(),
  filenames: z.array(z.string()),
  content: z.string().optional(),
  numLines: z.number().int().nonnegative().optional(),
  numMatches: z.number().int().nonnegative().optional(),
  appliedLimit: z.number().int().nonnegative().optional(),
});

export const GrepInputSchema: z.ZodType<GrepInput> = _rawGrepInputSchema;
export const GrepOutputSchema: z.ZodType<GrepOutput> = _rawGrepOutputSchema;

const _dg_GrepInput: AssertEqual<z.infer<typeof _rawGrepInputSchema>, GrepInput> = true;
const _dg_GrepOutput: AssertEqual<z.infer<typeof _rawGrepOutputSchema>, GrepOutput> = true;
void _dg_GrepInput;
void _dg_GrepOutput;

// ── Glob (Appendix E.6) ───────────────────────────────────────────────

export interface GlobInput {
  pattern: string;
  path?: string | undefined;
}

export interface GlobOutput {
  paths: string[];
}

const _rawGlobInputSchema = z.object({
  pattern: z.string(),
  path: z.string().optional(),
});

const _rawGlobOutputSchema = z.object({
  paths: z.array(z.string()),
});

export const GlobInputSchema: z.ZodType<GlobInput> = _rawGlobInputSchema;
export const GlobOutputSchema: z.ZodType<GlobOutput> = _rawGlobOutputSchema;

const _dg_GlobInput: AssertEqual<z.infer<typeof _rawGlobInputSchema>, GlobInput> = true;
const _dg_GlobOutput: AssertEqual<z.infer<typeof _rawGlobOutputSchema>, GlobOutput> = true;
void _dg_GlobInput;
void _dg_GlobOutput;
