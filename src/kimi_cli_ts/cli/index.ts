/**
 * CLI router — corresponds to Python cli/__init__.py
 * Uses Commander.js (replaces Typer)
 */

import { Command } from "commander";
import React from "react";
import { render } from "ink";
import { KimiCLI } from "../app.ts";
import { runSoul, type UILoopFn } from "../soul/index.ts";
import type { ContentPart } from "../types.ts";
import { WireFile } from "../wire/file.ts";
import { Shell } from "../ui/shell/Shell.tsx";
import type { WireUIEvent } from "../ui/shell/events.ts";
import type { ApprovalResponseKind } from "../wire/types.ts";
import { QueueShutDown } from "../utils/queue.ts";
import chalk from "chalk";
import { patchInkLogUpdate } from "../ui/renderer/index.ts";

// ── Re-exports from Python cli/__init__.py ──────────────

export class Reload extends Error {
  sessionId: string | null;
  prefillText: string | null;
  constructor(sessionId: string | null = null, prefillText: string | null = null) {
    super("reload");
    this.name = "Reload";
    this.sessionId = sessionId;
    this.prefillText = prefillText;
  }
}

/** Return true if an unknown value is a Reload sentinel. */
function isReload(err: unknown): err is Reload {
  return err instanceof Reload || (err instanceof Error && err.name === "Reload");
}

export class SwitchToWeb extends Error {
  sessionId: string | null;
  constructor(sessionId: string | null = null) {
    super("switch_to_web");
    this.name = "SwitchToWeb";
    this.sessionId = sessionId;
  }
}

export class SwitchToVis extends Error {
  sessionId: string | null;
  constructor(sessionId: string | null = null) {
    super("switch_to_vis");
    this.name = "SwitchToVis";
    this.sessionId = sessionId;
  }
}

export type UIMode = "shell" | "print" | "acp" | "wire";
export type InputFormat = "text" | "stream-json";
export type OutputFormat = "text" | "stream-json";

export const ExitCode = {
  SUCCESS: 0,
  FAILURE: 1,
  RETRYABLE: 75, // EX_TEMPFAIL from sysexits.h
} as const;

// ── Helpers ─────────────────────────────────────────

/**
 * Remove the trailing ` (session_id)` suffix from a session title, if present.
 */
function stripSessionIdSuffix(title: string, sessionId: string): string {
  const suffix = ` (${sessionId})`;
  return title.endsWith(suffix) ? title.slice(0, -suffix.length) : title;
}

/**
 * Print a hint for resuming the session after exit.
 */
function printResumeHint(session: { id: string; isEmpty?: () => Promise<boolean> }): void {
  console.error(chalk.dim(`\nTo resume this session: kimi -r ${session.id}`));
}

// ── Subcommands ──────────────────────────────────────────

import { loginCommand } from "./login.ts";
import { logoutCommand } from "./logout.ts";
import { infoCommand } from "./info.ts";
import { exportCommand } from "./export.ts";
import { mcpCommand } from "./mcp.ts";
import { pluginCommand } from "./plugin.ts";
import { visCommand } from "./vis.ts";
import { webCommand } from "./web.ts";

// ── Version callback ─────────────────────────────────────

function getVersionString(): string {
  try {
    const { getVersion } = require("../constant.ts");
    return getVersion();
  } catch {
    return "0.0.0";
  }
}

// ── Program ──────────────────────────────────────────────

const program = new Command()
  .name("kimi")
  .description("Kimi, your next CLI agent.")
  .version(getVersionString(), "-V, --version")
  .addCommand(loginCommand)
  .addCommand(logoutCommand)
  .addCommand(infoCommand)
  .addCommand(exportCommand)
  .addCommand(mcpCommand)
  .addCommand(pluginCommand)
  .addCommand(visCommand)
  .addCommand(webCommand);

// Main chat command (default)
program
  .argument("[prompt...]", "Initial prompt to send")
  .option("-m, --model <model>", "Model to use")
  .option("--thinking", "Enable thinking mode")
  .option("--no-thinking", "Disable thinking mode")
  .option("--yolo", "Auto-approve all tool calls")
  .option("-y, --yes", "Alias for --yolo (auto-approve all tool calls)")
  .option("--plan", "Start in plan mode")
  .option("--print", "Print mode (non-interactive)")
  .option("-w, --work-dir <dir>", "Working directory")
  .option("--add-dir <dir...>", "Add additional directories to the workspace")
  .option("--max-steps-per-turn <n>", "Max steps per turn", parseInt)
  .option("--max-retries-per-step <n>", "Max retries per step", parseInt)
  .option("--config-file <path>", "Config TOML/JSON file to load")
  .option("--config <string>", "Config TOML/JSON string to load")
  .option(
    "-S, --session [id]",
    "Resume a session. With ID: resume that session. Without ID: interactively pick a session.",
  )
  .option("-r, --resume [id]", "Alias for --session")
  .option("-C, --continue", "Continue the most recent session")
  .option("--input-format <format>", "Input format (text, stream-json). Print mode only.")
  .option("--output-format <format>", "Output format (text, stream-json). Print mode only.")
  .option("--quiet", "Alias for --print --output-format text --final-message-only")
  .option("--final-message-only", "Only print the final assistant message (print UI)")
  .option("-p, --prompt <text>", "User prompt to the agent")
  .option("--verbose", "Verbose output")
  .option("--debug", "Debug mode")
  .option("--wire", "Run as Wire server (experimental)")
  .option("--agent <name>", "Builtin agent specification to use")
  .option("--agent-file <path>", "Custom agent specification file")
  .option("--mcp-config-file <path...>", "MCP config file(s) to load")
  .option("--mcp-config <json...>", "MCP config JSON to load")
  .option("--command <cmd>", "Run a single shell command and exit")
  .option("--skills-dir <dir...>", "Custom skills directories (repeatable)")
  .option("--max-ralph-iterations <n>", "Max ralph loop iterations", parseInt)
  .action(
    async (
      promptParts: string[],
      options: {
        model?: string;
        thinking?: boolean;
        yolo?: boolean;
        yes?: boolean;
        plan?: boolean;
        print?: boolean;
        workDir?: string;
        addDir?: string[];
        maxStepsPerTurn?: number;
        maxRetriesPerStep?: number;
        configFile?: string;
        config?: string;
        session?: string | true;
        resume?: string | true;
        continue?: boolean;
        inputFormat?: string;
        outputFormat?: string;
        quiet?: boolean;
        finalMessageOnly?: boolean;
        prompt?: string;
        verbose?: boolean;
        debug?: boolean;
        wire?: boolean;
        agent?: string;
        agentFile?: string;
        mcpConfigFile?: string[];
        mcpConfig?: string[];
        command?: string;
        skillsDir?: string[];
        maxRalphIterations?: number;
      },
    ) => {
      // Handle --yes alias for --yolo
      if (options.yes) options.yolo = true;

      // Merge --resume into --session (they are aliases)
      if (options.resume !== undefined && options.session === undefined) {
        options.session = options.resume;
      }

      // session states:
      //   undefined → not provided (new session)
      //   true      → --session/--resume without value (picker mode)
      //   "ID"      → --session ID (resume specific session)
      const pickerMode = options.session === true;
      let resolvedSessionId: string | undefined = pickerMode
        ? undefined
        : (options.session as string | undefined);

      // Handle --quiet alias
      if (options.quiet) {
        options.print = true;
        options.outputFormat = "text";
        options.finalMessageOnly = true;
      }

      // Resolve prompt from either positional args or --prompt option
      const prompt =
        promptParts.length > 0
          ? promptParts.join(" ")
          : options.prompt ?? undefined;

      // Determine config source: --config-file takes precedence over legacy --config as path
      const configFile = options.configFile ?? undefined;

      // Validate: picker mode only works in shell (interactive) mode
      if (pickerMode && options.print) {
        console.error(
          "Error: --session without a session ID is only supported for shell UI",
        );
        process.exit(2);
      }

      // If picker mode, run interactive session picker before starting the app
      if (pickerMode) {
        const { Session } = await import("../session.ts");
        const workDir = options.workDir ?? process.cwd();
        const allSessions = await Session.list(workDir);
        if (allSessions.length === 0) {
          console.error("No sessions found for the working directory.");
          process.exit(0);
        }

        // Use simple numbered list for session picking
        console.log("Select a session to resume:\n");
        for (let i = 0; i < allSessions.length; i++) {
          const s = allSessions[i]!;
          const shortId = s.id.slice(0, 8);
          const name = stripSessionIdSuffix(s.title, s.id);
          console.log(`  ${i + 1}. ${name} (${shortId})`);
        }
        console.log("");

        // Read user selection
        const readline = await import("node:readline");
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        const answer = await new Promise<string>((resolve) => {
          rl.question("Enter number (or Ctrl+C to cancel): ", resolve);
        });
        rl.close();

        const idx = parseInt(answer, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= allSessions.length) {
          console.error("Invalid selection.");
          process.exit(1);
        }
        resolvedSessionId = allSessions[idx]!.id;
      }

      // Ink unmount function — captured in interactive mode for error-path cleanup
      let unmount: (() => void) | undefined;
      // pushEvent — hoisted so the outer catch block can push errors to the UI
      let pushEvent: ((event: WireUIEvent) => void) | null = null;
      // disableBracketedPaste — hoisted so the outer catch block can cleanup bracketed paste mode
      let disableBracketedPaste: (() => void) | undefined;

      try {
        if (options.print) {
          // ── Print mode: UILoopFn writes directly to stdout/stderr ──
          const printUILoopFn: UILoopFn = async (wire) => {
            const uiSide = wire.uiSide(true);
            while (true) {
              let msg: any;
              try {
                msg = await uiSide.receive();
              } catch (err) {
                if (err instanceof QueueShutDown) break;
                throw err;
              }
              const t = msg.__wireType ?? "";
              if (t === "TextPart") {
                process.stdout.write(msg.text);
              } else if (t === "ThinkPart") {
                process.stderr.write(chalk.dim(msg.text));
              } else if (t === "TurnEnd") {
                process.stdout.write("\n");
              } else if (t === "StatusUpdate") {
                if (options.verbose && msg.token_usage) {
                  process.stderr.write(
                    chalk.dim(
                      `[tokens] in=${msg.token_usage.inputTokens} out=${msg.token_usage.outputTokens}\n`,
                    ),
                  );
                }
              }
            }
          };

          const app = await KimiCLI.create({
            workDir: options.workDir,
            additionalDirs: options.addDir,
            configFile,
            modelName: options.model,
            thinking: options.thinking,
            yolo: options.yolo ?? true, // print mode implies yolo
            planMode: options.plan,
            sessionId: resolvedSessionId,
            continueSession: options.continue,
            maxStepsPerTurn: options.maxStepsPerTurn ?? options.maxRetriesPerStep,
          });

          if (prompt) {
            const wireFile = app.session.wireFile ? new WireFile(app.session.wireFile) : undefined;
            const cancelController = new AbortController();
            await runSoul(app.soul, prompt, printUILoopFn, cancelController, {
              wireFile,
              runtime: app.soul.runtime,
            });
          }
          printResumeHint(app.session);
          await app.shutdown();
        } else if (options.wire) {
          // ── Wire mode ──
          const app = await KimiCLI.create({
            workDir: options.workDir,
            additionalDirs: options.addDir,
            configFile,
            modelName: options.model,
            thinking: options.thinking,
            yolo: options.yolo,
            planMode: options.plan,
            sessionId: resolvedSessionId,
            continueSession: options.continue,
            maxStepsPerTurn: options.maxStepsPerTurn ?? options.maxRetriesPerStep,
          });
          // Wire mode not yet implemented
          console.error("Wire mode is not yet implemented.");
          await app.shutdown();
          process.exit(1);
        } else {
          // ── Interactive mode with reload loop ──
          // /undo and /fork trigger a reload by storing the new session info
          // and unmounting Ink, which causes waitUntilExit() to resolve.
          let currentSessionId: string | undefined = resolvedSessionId;
          let currentPrefillText: string | undefined = undefined;
          let currentPrompt: string | undefined = prompt;

          // eslint-disable-next-line no-constant-condition
          while (true) {
            // Pending reload info — set by onReload, checked after waitUntilExit
            let pendingReload: { sessionId: string; prefillText?: string } | null = null;

            // pushEvent will be set by Shell's onWireReady callback
            pushEvent = null;

            // inkUnmount will be set after render() — captured here so callbacks can trigger reload
            let inkUnmountFn: (() => void) | null = null;

            // Helper: trigger reload from anywhere (UILoopFn or Shell prop)
            const triggerReload = (sessionId: string, prefillText?: string) => {
              pendingReload = { sessionId, prefillText };
              inkUnmountFn?.();
            };

            // Create a UILoopFn that translates Wire messages → WireUIEvent for Shell.
            // Uses the outer `pushEvent` variable (not a parameter) so that event
            // routing stays correct across Shell lifecycle changes.
            const createShellUILoopFn = (): UILoopFn => {
              return async (wire) => {
                const uiSide = wire.uiSide(true);
                while (true) {
                  let msg: any;
                  try {
                    msg = await uiSide.receive();
                  } catch (err) {
                    if (err instanceof QueueShutDown) break;
                    throw err;
                  }
                  const pe = pushEvent;
                  if (!pe) continue;
                  const t = msg.__wireType ?? "";
                  if (t === "TurnBegin") {
                    const raw = msg.user_input;
                    let userInput: string;
                    if (typeof raw === "string") {
                      userInput = raw;
                    } else if (Array.isArray(raw)) {
                      userInput = (raw as any[])
                        .filter((p: any) => p?.type === "text" && typeof p.text === "string")
                        .map((p: any) => p.text)
                        .join("") || "[complex input]";
                    } else {
                      userInput = "[complex input]";
                    }
                    // Slash commands: skip user input echo (matches Python — visualize.py
                    // only does flush_content() for TurnBegin, never renders user message).
                    // Pass empty string so useWire still creates assistant message container.
                    pe({ type: "turn_begin", userInput: userInput.startsWith("/") ? "" : userInput });
                  } else if (t === "TurnEnd") {
                    pe({ type: "turn_end" });
                  } else if (t === "StepBegin") {
                    pe({ type: "step_begin", n: msg.n });
                  } else if (t === "TextPart") {
                    pe({ type: "text_delta", text: msg.text });
                  } else if (t === "ThinkPart") {
                    pe({ type: "think_delta", text: msg.text });
                  } else if (t === "ToolCall") {
                    pe({ type: "tool_call", id: msg.id, name: msg.name, arguments: msg.arguments });
                  } else if (t === "ToolResult") {
                    pe({ type: "tool_result", toolCallId: msg.tool_call_id, result: msg });
                  } else if (t === "StatusUpdate") {
                    pe({ type: "status_update", status: msg });
                  } else if (t === "CompactionBegin") {
                    pe({ type: "compaction_begin" });
                  } else if (t === "CompactionEnd") {
                    pe({ type: "compaction_end" });
                  } else if (t === "Notification") {
                    pe({ type: "notification", title: msg.title, body: msg.body });
                  } else if (t === "SubagentEvent") {
                    pe({ type: "subagent_event", parentToolCallId: msg.parent_tool_call_id, agentId: msg.agent_id, subagentType: msg.subagent_type, event: msg.event });
                  } else if (t === "ApprovalRequest") {
                    pe({ type: "approval_request", request: msg });
                  } else if (t === "QuestionRequest") {
                    pe({ type: "question_request", request: msg });
                  } else if (t === "StepInterrupted") {
                    pe({ type: "step_interrupted" });
                  }
                }
              };
            };

            // Cancel controller for the current soul run — shared between onSubmit and onInterrupt
            let currentCancelController: AbortController | null = null;

            const app = await KimiCLI.create({
              workDir: options.workDir,
              additionalDirs: options.addDir,
              configFile,
              modelName: options.model,
              thinking: options.thinking,
              yolo: options.yolo,
              sessionId: currentSessionId,
              continueSession: !currentSessionId ? options.continue : undefined,
              resumed: !!currentSessionId,
              maxStepsPerTurn: options.maxStepsPerTurn ?? options.maxRetriesPerStep,
            });

            // Patch Ink's log-update with our cell-level diffing renderer.
            // This must happen before render() creates the Ink instance.
            patchInkLogUpdate();

            // Enable bracketed paste mode so terminal doesn't show paste warning.
            // This tells the terminal (e.g., VSCode) that we handle large pastes.
            process.stdout.write("\x1b[?2004h");
            disableBracketedPaste = () => {
              process.stdout.write("\x1b[?2004l");
            };

            // Check if stdin is a proper TTY for Ink's raw mode support
            const isRawModeSupported = process.stdin.isTTY === true;
            if (!isRawModeSupported) {
              console.error("Error: Kimi CLI requires an interactive terminal.");
              console.error("Raw mode is not supported on stdin. Make sure you're running:");
              console.error("  bun run start");
              console.error("(not piping stdin from another command)");
              process.exit(1);
            }

            const { waitUntilExit, unmount: inkUnmount } = render(
              React.createElement(Shell, {
                modelName: app.soul.modelName,
                workDir: options.workDir ?? process.cwd(),
                sessionId: app.session.id,
                sessionDir: app.session.dir,
                sessionTitle: app.session.title,
                thinking: app.soul.thinking,
                yolo: options.yolo ?? false,
                prefillText: currentPrefillText,
                onSubmit: async (input: string | ContentPart[]) => {
                  const cancelController = new AbortController();
                  currentCancelController = cancelController;
                  const wireFile = app.session.wireFile ? new WireFile(app.session.wireFile) : undefined;
                  try {
                    await runSoul(app.soul, input, createShellUILoopFn(), cancelController, {
                      wireFile,
                      runtime: app.soul.runtime,
                    });
                  } catch (err) {
                    if (err instanceof Reload) {
                      // Soul handler requested reload (e.g., /model, /sessions panel)
                      // Translate to shell-level triggerReload, matching Python pattern
                      triggerReload(err.sessionId ?? app.session.id, err.prefillText ?? undefined);
                      return;
                    }
                    pushEvent?.({ type: "error", message: err instanceof Error ? err.message : String(err) });
                  }
                },
                onInterrupt: () => {
                  currentCancelController?.abort();
                },
                onPlanModeToggle: async () => {
                  return app.soul.togglePlanModeFromManual();
                },
                onApprovalResponse: (requestId: string, decision: ApprovalResponseKind, feedback?: string) => {
                  if (app.soul.runtime.approvalRuntime) {
                    app.soul.runtime.approvalRuntime.resolve(requestId, decision, feedback);
                  }
                },
                onWireReady: (pe) => {
                  pushEvent = pe;
                  // Emit initial status so StatusBar shows context tokens at startup
                  const initStatus = app.soul.status;
                  pe({
                    type: "status_update",
                    status: {
                      context_usage: initStatus.contextUsage ?? null,
                      context_tokens: initStatus.contextTokens ?? null,
                      max_context_tokens: initStatus.maxContextTokens ?? null,
                      token_usage: initStatus.tokenUsage ?? null,
                      message_id: null,
                      plan_mode: initStatus.planMode ?? null,
                      yolo: initStatus.yoloEnabled ?? null,
                      mcp_status: null,
                    },
                  });
                },
                onReload: (newSessionId: string, prefill?: string) => {
                  triggerReload(newSessionId, prefill);
                },
                extraSlashCommands: app.soul.availableSlashCommands,
              }),
              { exitOnCtrlC: false },
            );
            unmount = inkUnmount;
            inkUnmountFn = inkUnmount;

            // Start background task to forward RootWireHub events to UI.
            // ApprovalRequests flow through ApprovalRuntime → RootWireHub,
            // NOT through the soul's Wire, so we need a separate subscriber.
            let rootHubQueue: any = null;
            if (app.soul.runtime.rootWireHub) {
              rootHubQueue = app.soul.runtime.rootWireHub.subscribe();
              (async () => {
                try {
                  while (true) {
                    const msg = await rootHubQueue.get();
                    if (
                      msg &&
                      typeof msg === "object" &&
                      "id" in msg &&
                      "tool_call_id" in msg &&
                      "sender" in msg
                    ) {
                      // ApprovalRequest — enrich with source_description from subagent store
                      const request = msg as any;
                      if (request.agent_id && !request.source_description && app.soul.runtime.subagentStore) {
                        const record = app.soul.runtime.subagentStore.getInstance(request.agent_id);
                        if (record) {
                          request.source_description = record.description;
                        }
                      }
                      (pushEvent as ((e: WireUIEvent) => void) | null)?.({
                        type: "approval_request",
                        request,
                      });
                    }
                  }
                } catch {
                  // Queue shutdown or error
                  if (rootHubQueue) {
                    app.soul.runtime.rootWireHub?.unsubscribe(rootHubQueue);
                  }
                }
              })();
            }

            // Run initial prompt if provided (only on first iteration)
            if (currentPrompt) {
              const cancelController = new AbortController();
              currentCancelController = cancelController;
              const wireFile = app.session.wireFile ? new WireFile(app.session.wireFile) : undefined;
              runSoul(app.soul, currentPrompt, createShellUILoopFn(), cancelController, {
                wireFile,
                runtime: app.soul.runtime,
              }).catch((err) => {
                pushEvent?.({ type: "error", message: err instanceof Error ? err.message : String(err) });
              });
            }

            await waitUntilExit();
            disableBracketedPaste();
            if (rootHubQueue && app.soul.runtime.rootWireHub) {
              app.soul.runtime.rootWireHub.unsubscribe(rootHubQueue);
            }
            await app.shutdown();

            // Check if this was a reload (/undo or /fork)
            if (pendingReload) {
              currentSessionId = (pendingReload as { sessionId: string; prefillText?: string }).sessionId;
              currentPrefillText = (pendingReload as { sessionId: string; prefillText?: string }).prefillText;
              currentPrompt = undefined; // Don't re-run the initial prompt
              continue;
            }

            // Normal exit
            printResumeHint(app.session);
            break;
          }
        }
      } catch (err) {
        // Clean up bracketed paste mode on error
        disableBracketedPaste?.();
        if (isReload(err)) {
          // Shouldn't happen with the new loop, but handle gracefully
          console.error("Unexpected reload — restarting is not supported here.");
          process.exit(ExitCode.FAILURE);
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        // Push error to UI so the user can see it — don't crash the app
        const push = pushEvent as ((event: WireUIEvent) => void) | null;
        if (push) {
          push({ type: "error", message: errMsg });
        } else {
          // No UI available (e.g. during startup) — fall back to stderr + exit
          if (typeof unmount === "function") unmount();
          console.error("Error:", errMsg);
          process.exit(ExitCode.FAILURE);
        }
      }
    },
  );

export async function cli(argv: string[]): Promise<number> {
  try {
    await program.parseAsync(argv);
    return ExitCode.SUCCESS;
  } catch (error) {
    console.error("Fatal error:", error);
    return ExitCode.FAILURE;
  }
}
