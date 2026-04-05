/**
 * CLI router — corresponds to Python cli/__init__.py
 * Uses Commander.js (replaces Typer)
 */

import { Command } from "commander";
import React from "react";
import { render } from "ink";
import { KimiCLI } from "../app.ts";
import type { SoulCallbacks } from "../soul/kimisoul.ts";
import { Shell } from "../ui/shell/Shell.tsx";
import type { WireUIEvent } from "../ui/shell/events.ts";
import type { ApprovalResponseKind } from "../wire/types.ts";
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
          // ── Print mode: callbacks write directly to stdout/stderr ──
          const callbacks: SoulCallbacks = {
            onTextDelta: (text) => process.stdout.write(text),
            onThinkDelta: (text) => process.stderr.write(chalk.dim(text)),
            onError: (err) =>
              process.stderr.write(chalk.red(`[ERROR] ${err.message}\n`)),
            onTurnEnd: () => process.stdout.write("\n"),
            onStatusUpdate: (status) => {
              if (options.verbose && status.tokenUsage) {
                process.stderr.write(
                  chalk.dim(
                    `[tokens] in=${status.tokenUsage.inputTokens} out=${status.tokenUsage.outputTokens}\n`,
                  ),
                );
              }
            },
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
            callbacks,
          });

          // Wire subagent event sink for print mode (output logging only)
          app.agent.runtime.subagentEventSink = () => {};

          if (prompt) await app.runPrint(prompt);
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
            callbacks: {},
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

            // Helper: trigger reload from anywhere (SoulCallbacks or Shell prop)
            const triggerReload = (sessionId: string, prefillText?: string) => {
              pendingReload = { sessionId, prefillText };
              inkUnmountFn?.();
            };

            const callbacks: SoulCallbacks = {
              onTurnBegin: (userInput) => {
                const text =
                  typeof userInput === "string"
                    ? userInput
                    : "[complex input]";
                pushEvent?.({ type: "turn_begin", userInput: text });
              },
              onTurnEnd: () => {
                pushEvent?.({ type: "turn_end" });
              },
              onStepBegin: (n) => {
                pushEvent?.({ type: "step_begin", n });
              },
              onTextDelta: (text) => {
                pushEvent?.({ type: "text_delta", text });
              },
              onThinkDelta: (text) => {
                pushEvent?.({ type: "think_delta", text });
              },
              onToolCall: (tc) => {
                pushEvent?.({
                  type: "tool_call",
                  id: tc.id,
                  name: tc.name,
                  arguments: tc.arguments,
                });
              },
              onToolResult: (toolCallId, result) => {
                // Build display blocks — include brief for rejected-with-feedback
                const display: unknown[] = result.display ?? [];
                if (result.isError && result.message?.includes("User feedback:") && display.length === 0) {
                  const match = result.message.match(/User feedback: (.+)$/);
                  if (match) {
                    display.push({ type: "brief", brief: `Rejected: ${match[1]}` });
                  }
                } else if (result.isError && result.message?.includes("rejected by the user") && display.length === 0) {
                  display.push({ type: "brief", brief: "Rejected by user" });
                }
                pushEvent?.({
                  type: "tool_result",
                  toolCallId,
                  result: {
                    tool_call_id: toolCallId,
                    return_value: {
                      isError: result.isError,
                      output: result.output,
                      message: result.message,
                    },
                    display,
                  },
                });
              },
              onStatusUpdate: (status) => {
                pushEvent?.({
                  type: "status_update",
                  status: {
                    context_usage: status.contextUsage ?? null,
                    context_tokens: status.contextTokens ?? null,
                    max_context_tokens: status.maxContextTokens ?? null,
                    token_usage: status.tokenUsage ?? null,
                    message_id: null,
                    plan_mode: status.planMode ?? null,
                    yolo: status.yoloEnabled ?? null,
                    mcp_status: null,
                  },
                });
              },
              onCompactionBegin: () => {
                pushEvent?.({ type: "compaction_begin" });
              },
              onCompactionEnd: () => {
                pushEvent?.({ type: "compaction_end" });
              },
              onError: (err) => {
                pushEvent?.({ type: "error", message: err.message });
              },
              onNotification: (title, body) => {
                pushEvent?.({ type: "notification", title, body });
              },
              onReload: (sessionId, prefillText) => {
                triggerReload(sessionId, prefillText);
              },
            };

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
              callbacks,
            });

            // Wire subagent event sink so subagent runner can forward events to UI.
            // This bridges the subagent's SoulCallbacks → parent pushEvent as SubagentEvent.
            app.agent.runtime.subagentEventSink = (event) => {
              pushEvent?.(event as any);
            };

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
                onSubmit: (input: string | ContentPart[]) => {
                  app.soul.run(input).catch((err: Error) => {
                    pushEvent?.({ type: "error", message: err.message });
                  });
                },
                onInterrupt: () => {
                  app.soul.abort();
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

            // Start background task to forward RootWireHub events to UI
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
                      // (mirrors Python's _enrich_approval_request_for_ui)
                      const request = msg as any;
                      if (request.agent_id && !request.source_description && app.soul.runtime.subagentStore) {
                        const record = app.soul.runtime.subagentStore.getInstance(request.agent_id);
                        if (record) {
                          request.source_description = record.description;
                        }
                      }
                      pushEvent?.({
                        type: "approval_request",
                        request,
                      });
                    }
                    // NOTE: ApprovalResponse is NOT forwarded here.
                    // Responses flow through handleApprovalResponse → wire.pushEvent
                    // to avoid double-processing.
                  }
                } catch (err) {
                  // Queue shutdown or error
                  if (rootHubQueue) {
                    app.soul.runtime.rootWireHub?.unsubscribe(rootHubQueue);
                  }
                }
              })();
            }

            // Run initial prompt if provided (only on first iteration)
            if (currentPrompt) {
              app.soul.run(currentPrompt).catch((err: Error) => {
                pushEvent?.({ type: "error", message: err.message });
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
              currentSessionId = pendingReload.sessionId;
              currentPrefillText = pendingReload.prefillText;
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
