/**
 * WriteFile tool — write content to a file.
 * Corresponds to Python tools/file/write.py
 */

import { resolve, dirname } from "node:path";
import { z } from "zod/v4";
import { CallableTool } from "../base.ts";
import type { ToolContext, ToolResult } from "../types.ts";
import { ToolError } from "../types.ts";
import { inspectPlanEditTarget } from "./plan_mode.ts";
import type { DiffDisplayBlock } from "../display.ts";

const DESCRIPTION = `Write content to a file.

**Tips:**
- When \`mode\` is not specified, it defaults to \`overwrite\`. Always write with caution.
- When the content to write is too long (e.g. > 100 lines), use this tool multiple times instead of a single call. Use \`overwrite\` mode at the first time, then use \`append\` mode after the first write.`;

const ParamsSchema = z.object({
  path: z.string().describe(
    "The path to the file to write. Absolute paths are required when writing files outside the working directory.",
  ),
  content: z.string().describe("The content to write to the file"),
  mode: z
    .enum(["overwrite", "append"])
    .default("overwrite")
    .describe("The mode to use: `overwrite` or `append`."),
});

type Params = z.infer<typeof ParamsSchema>;

function resolvePath(filePath: string, workingDir: string): string {
  if (filePath.startsWith("/") || filePath.startsWith("~")) {
    if (filePath.startsWith("~")) {
      const home = process.env.HOME || process.env.USERPROFILE || "";
      return filePath.replace(/^~/, home);
    }
    return filePath;
  }
  return resolve(workingDir, filePath);
}

/** Build a simple unified diff for display. */
function buildSimpleDiff(oldContent: string, newContent: string, path: string): string {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const maxPreview = 50;
  const diffLines: string[] = [`--- a/${path}`, `+++ b/${path}`];

  let shown = 0;
  const maxLen = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLen && shown < maxPreview; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];
    if (oldLine !== newLine) {
      if (oldLine !== undefined) {
        diffLines.push(`-${oldLine}`);
        shown++;
      }
      if (newLine !== undefined) {
        diffLines.push(`+${newLine}`);
        shown++;
      }
    }
  }

  if (shown >= maxPreview) {
    diffLines.push(`... (diff truncated, ${maxLen} total lines)`);
  }

  return diffLines.join("\n");
}

export class WriteFile extends CallableTool<typeof ParamsSchema> {
  readonly name = "WriteFile";
  readonly description = DESCRIPTION;
  readonly schema = ParamsSchema;

  /** Optional plan mode bindings. */
  private _planModeChecker?: () => boolean;
  private _planFilePathGetter?: () => string | null;

  /** Bind plan mode state checker and plan file path getter. */
  bindPlanMode(checker: () => boolean, pathGetter: () => string | null): void {
    this._planModeChecker = checker;
    this._planFilePathGetter = pathGetter;
  }

  async execute(params: Params, ctx: ToolContext): Promise<ToolResult> {
    if (!params.path) {
      return ToolError("File path cannot be empty.");
    }

    try {
      const resolvedPath = resolvePath(params.path, ctx.workingDir);

      // Check plan mode restrictions
      const planTarget = inspectPlanEditTarget(resolvedPath, {
        planModeChecker: this._planModeChecker ?? ctx.getPlanMode,
        planFilePathGetter: this._planFilePathGetter,
      });
      if ("isError" in planTarget && planTarget.isError) {
        return planTarget;
      }
      const isPlanFileWrite = !("isError" in planTarget) && planTarget.isPlanTarget;

      // Ensure parent directory for plan file writes
      if (isPlanFileWrite && !("isError" in planTarget) && planTarget.planPath) {
        const { mkdirSync } = await import("node:fs");
        mkdirSync(dirname(planTarget.planPath), { recursive: true });
      }

      // Check if parent directory exists
      const parentDir = dirname(resolvedPath);
      const { stat: fsStat, mkdir } = await import("node:fs/promises");
      try {
        const parentInfo = await fsStat(parentDir);
        if (!parentInfo.isDirectory()) {
          return ToolError(`Parent path \`${parentDir}\` exists but is not a directory.`);
        }
      } catch (err: any) {
        if (err?.code === "ENOENT") {
          await mkdir(parentDir, { recursive: true });
        } else {
          return ToolError(`Cannot access parent directory \`${parentDir}\`: ${err?.message}`);
        }
      }

      const file = Bun.file(resolvedPath);
      const fileExisted = await file.exists();

      // Build diff for approval display
      let diffPreview = "";
      if (fileExisted) {
        try {
          const oldContent = await file.text();
          const newContent = params.mode === "append" ? oldContent + params.content : params.content;
          diffPreview = buildSimpleDiff(oldContent, newContent, params.path);
        } catch {
          // Can't read old file — skip diff
        }
      }

      // Plan file writes are auto-approved; other writes need approval
      if (!isPlanFileWrite) {
        const approvalSummary = fileExisted
          ? `${params.mode === "append" ? "Append to" : "Overwrite"} file \`${params.path}\`${diffPreview ? `\n${diffPreview}` : ""}`
          : `Create file \`${params.path}\` (${params.content.length} chars)`;

        const decision = await ctx.approval(
          "WriteFile",
          fileExisted ? "edit" : "create",
          approvalSummary,
        );
        if (decision === "reject") {
          return ToolError(
            "The tool call is rejected by the user. Stop what you are doing and wait for the user to tell you how to proceed.",
          );
        }
      }

      if (params.mode === "append" && fileExisted) {
        const { appendFile } = await import("node:fs/promises");
        await appendFile(resolvedPath, params.content, "utf-8");
      } else {
        await Bun.write(resolvedPath, params.content);
      }

      const newFile = Bun.file(resolvedPath);
      const fileSize = newFile.size;
      const action =
        params.mode === "overwrite"
          ? (fileExisted ? "overwritten" : "created")
          : "appended to";
      return {
        isError: false,
        output: "",
        message: `File successfully ${action}. Current size: ${fileSize} bytes.`,
      };
    } catch (e) {
      return ToolError(`Failed to write to ${params.path}. Error: ${e}`);
    }
  }
}
