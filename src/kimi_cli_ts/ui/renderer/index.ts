/**
 * Optimized Ink renderer.
 *
 * Two layers of protection for text selection:
 *
 * 1. Shell removes minHeight={termHeight} so Ink uses incremental diff
 *    (eraseLines + overwrite changed lines) instead of clearTerminal.
 *    Static messages stay in scrollback untouched.
 *
 * 2. As a safety net, if \x1b[2J (erase screen) still appears in output
 *    (e.g., resize, edge cases), strip it to prevent selection destruction.
 *
 * 3. On terminals supporting DEC 2026, buffer BSU/ESU sequences into
 *    a single atomic stdout.write() call.
 *
 * Usage:
 *   import { patchInkLogUpdate } from '../ui/renderer';
 *   patchInkLogUpdate(); // Call before ink.render()
 */

import { BSU, ESU, SYNC_SUPPORTED } from "./terminal-detect.ts";

import { writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

// ── Debug File Logger ───────────────────────────────────

const LOG_FILE = join(process.cwd(), "renderer-debug.log");
let logReady = false;
let writeCounter = 0;
let frameCounter = 0;

function initLog(): void {
  if (logReady) return;
  logReady = true;
  try {
    writeFileSync(LOG_FILE, [
      `=== Renderer Debug Log ===`,
      `pid: ${process.pid}`,
      `cwd: ${process.cwd()}`,
      `TERM_PROGRAM: ${process.env.TERM_PROGRAM ?? "(unset)"}`,
      `TERM: ${process.env.TERM ?? "(unset)"}`,
      `TMUX: ${process.env.TMUX ?? "(unset)"}`,
      `SYNC_SUPPORTED: ${SYNC_SUPPORTED}`,
      `stdout.columns: ${process.stdout.columns}`,
      `stdout.rows: ${process.stdout.rows}`,
      `stdout.isTTY: ${process.stdout.isTTY}`,
      ``,
    ].join("\n") + "\n");
  } catch { /* ignore */ }
}

function log(msg: string): void {
  if (!logReady) initLog();
  try {
    appendFileSync(LOG_FILE, `[${Date.now()}] ${msg}\n`);
  } catch { /* ignore */ }
}

function esc(s: string, maxLen = 300): string {
  return s.slice(0, maxLen)
    .replace(/\x1b\[(\??)(\d+(?:;\d+)*)([A-Za-z])/g, (_, q, p, c) => `<CSI${q}${p}${c}>`)
    .replace(/\x1b\]([^\x07\x1b]*)\x07/g, (_, p) => `<OSC${p}>`)
    .replace(/\x1b/g, "<ESC>")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

function analyzeAnsi(s: string): string {
  const f: string[] = [];
  if (s.includes("\x1b[2J")) f.push("ERASE_SCREEN!");
  if (s.includes("\x1b[3J")) f.push("ERASE_SCROLLBACK!");
  if (s.includes("\x1b[J"))  f.push("ERASE_BELOW");
  if (s.includes("\x1b[H"))  f.push("HOME");
  if (s.includes("\x1b[?2026h")) f.push("BSU");
  if (s.includes("\x1b[?2026l")) f.push("ESU");
  if (s.includes("\x1b[?25l")) f.push("HIDE");
  if (s.includes("\x1b[?25h")) f.push("SHOW");
  const el = (s.match(/\x1b\[2K/g) || []).length;
  if (el) f.push(`eraseLn*${el}`);
  const eol = (s.match(/\x1b\[K/g) || []).length;
  if (eol) f.push(`eraseEol*${eol}`);
  const cu = (s.match(/\x1b\[\d+A/g) || []).length;
  if (cu) f.push(`up*${cu}`);
  const nl = (s.match(/\n/g) || []).length;
  f.push(`nl*${nl}`);
  f.push(`${s.length}b`);
  return f.join("|");
}

// ── Safety: strip erase-screen sequences ────────────────

const ERASE_SCREEN = "\x1b[2J";
const ERASE_SCROLLBACK = "\x1b[3J";

const ERASE_EOL = "\x1b[K";
const ERASE_BELOW = "\x1b[J";
const CURSOR_HOME = "\x1b[H";

/**
 * When we strip clearTerminal, Ink's log.sync() sets previousLineCount to the
 * current content height. On the next frame with smaller content, eraseLines()
 * won't erase enough lines. We track the max height we've rendered and emit
 * extra ERASE_BELOW when content shrinks.
 */
let maxRenderedLines = 0;

/**
 * Rewrite a clearTerminal frame into CUP-positioned lines.
 *
 * When Ink hits the clearTerminal path, it emits:
 *   \x1b[2J \x1b[3J \x1b[H  fullStaticOutput + output
 *
 * fullStaticOutput = completed messages (already in scrollback via <Static>)
 * output = dynamic part (streaming msg, spinner, prompt, statusbar)
 *
 * We rewrite this as CUP-positioned lines showing only the LAST `rows` lines
 * (the dynamic viewport). The static history is already in scrollback from
 * earlier <Static> writes — no need to re-emit it.
 *
 * This means: no \x1b[2J (no erase), no \x1b[3J (scrollback preserved),
 * no \n (no scroll pollution). Just CUP overwrite of the visible viewport.
 */
function rewriteClearFrame(s: string, termRows: number): string {
  // Strip all destructive/positioning sequences
  let body = s;
  body = body.replaceAll(ERASE_SCREEN, "");
  body = body.replaceAll(ERASE_SCROLLBACK, "");
  body = body.replaceAll(CURSOR_HOME, "");

  const lines = body.split("\n");
  // Remove trailing empty line from split
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const totalLines = lines.length;
  const rows = termRows || 24;

  // Show the LAST `rows` lines — this keeps statusbar/input visible
  // and drops the static history (which is already in scrollback)
  const startLine = totalLines > rows ? totalLines - rows : 0;
  const visibleCount = Math.min(totalLines - startLine, rows);

  const parts: string[] = [];
  for (let i = 0; i < visibleCount; i++) {
    parts.push(`\x1b[${i + 1};1H`);
    parts.push(lines[startLine + i]!);
    parts.push(ERASE_EOL);
  }
  // Clear any lines below content (in case previous frame was taller)
  if (visibleCount < rows) {
    parts.push(ERASE_BELOW);
  }

  return parts.join("");
}

function hasEraseScreen(s: string): boolean {
  return s.includes(ERASE_SCREEN);
}

// ── stdout.write Wrapper ────────────────────────────────

function installWrapper(stream: NodeJS.WriteStream): void {
  if (!stream.isTTY) {
    log("wrapper: skip (not TTY)");
    return;
  }

  const originalWrite = stream.write.bind(stream) as typeof stream.write;
  let buffer: string[] = [];
  let inSyncBlock = false;
  let syncWriteCount = 0;
  let lastFlushTime = 0;

  log(`wrapper: installing (SYNC_SUPPORTED=${SYNC_SUPPORTED})`);

  const wrappedWrite: typeof stream.write = function (
    this: NodeJS.WriteStream,
    chunk: any,
    encodingOrCb?: BufferEncoding | ((error?: Error | null) => void),
    cb?: (error?: Error | null) => void,
  ): boolean {
    const str = typeof chunk === "string" ? chunk : chunk.toString();
    const encoding = typeof encodingOrCb === "string" ? encodingOrCb : undefined;
    const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;

    writeCounter++;
    const wn = writeCounter;
    const now = Date.now();

    // ── BSU/ESU buffering (only when DEC 2026 is supported) ──

    if (SYNC_SUPPORTED) {
      if (str === BSU) {
        inSyncBlock = true;
        syncWriteCount = 0;
        buffer.push(str);
        callback?.();
        return true;
      }

      if (str === ESU) {
        buffer.push(str);
        let merged = buffer.join("");
        buffer = [];
        inSyncBlock = false;
        frameCounter++;

        // Safety: strip erase-screen if present
        const hadClear = hasEraseScreen(merged);
        if (hadClear) {
          // Unwrap BSU/ESU, rewrite as CUP, re-wrap
          let inner = merged;
          const hadBSU = inner.startsWith(BSU);
          const hadESU = inner.endsWith(ESU);
          if (hadBSU) inner = inner.slice(BSU.length);
          if (hadESU) inner = inner.slice(0, -ESU.length);
          inner = rewriteClearFrame(inner, stream.rows || 24);
          merged = (hadBSU ? BSU : "") + inner + (hadESU ? ESU : "");
          // Update maxRenderedLines
          const lines = inner.split("\n").length;
          maxRenderedLines = Math.min(lines, stream.rows || 24);
        } else {
          // Check for content shrinking and add ERASE_BELOW if needed
          const nlCount = (merged.match(/\n/g) || []).length;
          if (maxRenderedLines > 0 && nlCount + 1 < maxRenderedLines) {
            // Unwrap ESU, add ERASE_BELOW, re-add ESU
            const hasTrailingESU = merged.endsWith(ESU);
            if (hasTrailingESU) {
              merged = merged.slice(0, -ESU.length) + ERASE_BELOW + ESU;
            } else {
              merged = merged + ERASE_BELOW;
            }
            log(`FRAME#${frameCounter}: SHRINK ${nlCount + 1}<${maxRenderedLines} +ERASE_BELOW`);
          } else if (nlCount + 1 > maxRenderedLines) {
            maxRenderedLines = nlCount + 1;
          }
        }

        const gap = lastFlushTime ? now - lastFlushTime : 0;
        lastFlushTime = now;

        log(`FRAME#${frameCounter} w#${wn}: ${syncWriteCount}inner ${merged.length}b gap=${gap}ms${hadClear ? " STRIP!" : ""} | ${analyzeAnsi(merged)}`);

        if (frameCounter <= 10 || frameCounter % 100 === 0) {
          log(`  content: ${esc(merged, 500)}`);
        }

        return originalWrite(merged, encoding as any, callback as any);
      }

      if (inSyncBlock) {
        buffer.push(str);
        syncWriteCount++;
        if (frameCounter < 5) {
          log(`  inner#${syncWriteCount} w#${wn}: +${str.length}b | ${analyzeAnsi(str)}`);
        }
        callback?.();
        return true;
      }
    }

    // ── Non-sync writes ──

    let output = str;
    const hadClear = hasEraseScreen(output);
    if (hadClear) {
      output = rewriteClearFrame(output, stream.rows || 24);
      // rewriteClearFrame already includes ERASE_BELOW, and positions content
      // at top of screen. Update maxRenderedLines to the visible count.
      const lines = str.split("\n").length;
      maxRenderedLines = Math.min(lines, stream.rows || 24);
      log(`NOSYNC w#${wn}: STRIP! ${str.length}b→${output.length}b maxLines=${maxRenderedLines} | ${analyzeAnsi(output)}`);
    } else {
      // Count newlines in this frame
      const nlCount = (str.match(/\n/g) || []).length;
      
      // Check if content shrank below our max rendered height
      // If so, we need to erase the orphaned lines at the bottom
      if (maxRenderedLines > 0 && nlCount + 1 < maxRenderedLines) {
        // After Ink writes, cursor is at bottom of new content.
        // Add ERASE_BELOW to clear any orphaned lines below it.
        output = str + ERASE_BELOW;
        log(`NOSYNC w#${wn}: SHRINK ${nlCount + 1}<${maxRenderedLines} +ERASE_BELOW | ${analyzeAnsi(output)}`);
        // Keep maxRenderedLines at current level until next clearTerminal
      } else {
        // Update max if we rendered more lines
        if (nlCount + 1 > maxRenderedLines) {
          maxRenderedLines = nlCount + 1;
        }
        if (wn <= 20 || wn % 200 === 0) {
          log(`NOSYNC w#${wn}: ${str.length}b maxLines=${maxRenderedLines} | ${analyzeAnsi(str)}`);
        }
      }
    }

    if (output !== str) {
      return originalWrite(output, encoding as any, callback as any);
    }
    return originalWrite(chunk, encoding as any, callback as any);
  } as typeof stream.write;

  stream.write = wrappedWrite;
  log("wrapper: installed");
}

// ── Public API ──────────────────────────────────────────

export function patchInkLogUpdate(): void {
  initLog();
  log("patch: starting");

  installWrapper(process.stdout);

  log(`patch: done — log at ${LOG_FILE}`);
  process.stderr.write(`[renderer] patched, log: ${LOG_FILE}\n`);
}

// ── Re-exports ──────────────────────────────────────────

export { BSU, ESU, SYNC_SUPPORTED } from "./terminal-detect.ts";
export { createScreen, resetScreen } from "./screen.ts";
export { parseAnsiToScreen } from "./ansi-parser.ts";
export { computeDiff, screensEqual } from "./diff.ts";
export { buildPatch, buildFrameOutput } from "./patch-writer.ts";
export type { Screen, Viewport, CursorPosition } from "./types.ts";
