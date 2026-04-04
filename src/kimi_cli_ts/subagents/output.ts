/**
 * Subagent output writer — corresponds to Python subagents/output.py
 * Appends human-readable transcript lines to output files.
 */

import { appendFileSync } from "node:fs";

export class SubagentOutputWriter {
  private _path: string;
  private _extraPaths: string[];

  constructor(path: string, extraPaths: string[] = []) {
    this._path = path;
    this._extraPaths = extraPaths;
  }

  stage(name: string): void {
    this.append(`[stage] ${name}\n`);
  }

  toolCall(name: string): void {
    this.append(`[tool] ${name}\n`);
  }

  toolResult(status: "success" | "error", brief?: string): void {
    if (brief) {
      this.append(`[tool_result] ${status}: ${brief}\n`);
    } else {
      this.append(`[tool_result] ${status}\n`);
    }
  }

  text(text: string): void {
    if (text) this.append(text);
  }

  summary(text: string): void {
    if (text) this.append(`\n[summary]\n${text}\n`);
  }

  error(message: string): void {
    this.append(`[error] ${message}\n`);
  }

  private append(text: string): void {
    try {
      appendFileSync(this._path, text, "utf-8");
    } catch {
      // Ignore write errors
    }
    for (const p of this._extraPaths) {
      try {
        appendFileSync(p, text, "utf-8");
      } catch {
        // Best-effort tee
      }
    }
  }
}
