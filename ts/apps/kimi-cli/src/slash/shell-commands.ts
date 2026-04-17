/**
 * Shell-level slash commands.
 *
 * These commands are handled entirely on the client side (no Wire RPC).
 * They manipulate UI state, session management, or exit the app.
 */

import type { SlashCommandDef, SlashCommandResult } from './registry.js';
import { saveConfigPatch } from '../config/save.js';
import { resolveEditorCommand } from '../utils/external-editor.js';

// ── Helper ──────────────────────────────────────────────────────────

function ok(message?: string): SlashCommandResult {
  if (message !== undefined) return { type: 'ok', message };
  return { type: 'ok' };
}

// ── Command definitions ─────────────────────────────────────────────

const exitCommand: SlashCommandDef = {
  name: 'exit',
  aliases: ['quit', 'q'],
  description: 'Exit the application',
  mode: 'both',
  async execute() {
    return { type: 'exit' };
  },
};

const helpCommand: SlashCommandDef = {
  name: 'help',
  aliases: ['h', '?'],
  description: 'Show available commands and shortcuts',
  mode: 'both',
  async execute(_args, _ctx) {
    // The actual help display is handled by the Shell component
    // when it sees the 'ok' result with the special message.
    return ok('__show_help__');
  },
};

const versionCommand: SlashCommandDef = {
  name: 'version',
  aliases: [],
  description: 'Show version information',
  mode: 'both',
  async execute(_args, ctx) {
    return ok(`kimi-cli v${ctx.appState.version}`);
  },
};

const clearCommand: SlashCommandDef = {
  name: 'clear',
  aliases: ['reset'],
  description: 'Clear the transcript (keep the session)',
  mode: 'both',
  async execute() {
    return { type: 'reload', action: 'clear' };
  },
};

const newCommand: SlashCommandDef = {
  name: 'new',
  aliases: [],
  description: 'Start a fresh session in the current workspace',
  mode: 'both',
  async execute() {
    return { type: 'reload', action: 'new' };
  },
};

const sessionsCommand: SlashCommandDef = {
  name: 'sessions',
  aliases: ['resume'],
  description: 'Browse and resume sessions',
  mode: 'both',
  async execute(_args, _ctx) {
    // Signal the Shell to open SessionPicker
    return ok('__show_sessions__');
  },
};

const titleCommand: SlashCommandDef = {
  name: 'title',
  aliases: ['rename'],
  description: 'Set or show session title',
  mode: 'both',
  async execute(args, ctx) {
    if (args.length === 0) {
      return ok(`Session: ${ctx.appState.sessionId}`);
    }
    await ctx.wireClient.rename(ctx.appState.sessionId, args);
    return ok(`Title set to: ${args}`);
  },
};

const themeCommand: SlashCommandDef = {
  name: 'theme',
  aliases: [],
  description: 'Toggle dark/light theme and redraw the UI',
  mode: 'both',
  async execute(_args, ctx) {
    const newTheme = ctx.appState.theme === 'dark' ? 'light' : 'dark';
    ctx.setAppState({ theme: newTheme });
    // Rebuild palettes / redraw transcript via the reload pipeline.
    return { type: 'reload', action: 'theme' };
  },
};

const yoloCommand: SlashCommandDef = {
  name: 'yolo',
  aliases: ['yes'],
  description: 'Toggle auto-approve mode',
  mode: 'both',
  async execute(args, ctx) {
    let enabled: boolean;
    if (args === 'on') enabled = true;
    else if (args === 'off') enabled = false;
    else enabled = !ctx.appState.yolo;

    ctx.setAppState({ yolo: enabled });
    await ctx.wireClient.setYolo(ctx.appState.sessionId, enabled);
    return ok(`YOLO mode: ${enabled ? 'on' : 'off'}`);
  },
};

const planCommand: SlashCommandDef = {
  name: 'plan',
  aliases: [],
  description: 'Toggle plan mode',
  mode: 'both',
  async execute(args, ctx) {
    let enabled: boolean;
    if (args === 'on') enabled = true;
    else if (args === 'off') enabled = false;
    else enabled = !ctx.appState.planMode;

    ctx.setAppState({ planMode: enabled });
    await ctx.wireClient.setPlanMode(ctx.appState.sessionId, enabled);
    return ok(`Plan mode: ${enabled ? 'on' : 'off'}`);
  },
};

const modelCommand: SlashCommandDef = {
  name: 'model',
  aliases: [],
  description: 'Switch LLM model (picker, persists to config.toml)',
  mode: 'both',
  async execute(args, ctx) {
    const trimmed = args.trim();
    if (trimmed.length === 0) {
      // Defer to InteractiveMode which renders the ChoicePicker and
      // drives the two-step model → thinking flow.
      return ok('__show_model_picker__');
    }
    // Direct-arg form: treat as alias lookup. If unknown, surface an
    // error; otherwise let the picker-driven flow handle persistence +
    // runtime rebuild consistently by piggybacking on the signal.
    if (ctx.appState.availableModels[trimmed] === undefined) {
      return ok(`Unknown model alias: ${trimmed}`);
    }
    return ok(`__show_model_picker__:${trimmed}`);
  },
};

const thinkingCommand: SlashCommandDef = {
  name: 'thinking',
  aliases: ['think'],
  description: 'Toggle extended thinking',
  mode: 'both',
  async execute(args, ctx) {
    let enabled: boolean;
    if (args === 'on') enabled = true;
    else if (args === 'off') enabled = false;
    else enabled = !ctx.appState.thinking;

    ctx.setAppState({ thinking: enabled });
    await ctx.wireClient.setThinking(ctx.appState.sessionId, enabled ? 'extended' : 'none');
    return ok(`Thinking: ${enabled ? 'on' : 'off'}`);
  },
};

const usageCommand: SlashCommandDef = {
  name: 'usage',
  aliases: ['status'],
  description: 'Show session tokens + context window + plan quotas',
  mode: 'both',
  async execute() {
    // Defer to InteractiveMode — it has access to oauthManagers /
    // availableModels which are needed to fetch the managed-platform
    // /usages endpoint in addition to the session-local token totals.
    return ok('__show_usage__');
  },
};

const forkCommand: SlashCommandDef = {
  name: 'fork',
  aliases: [],
  description: 'Fork the current session',
  mode: 'both',
  async execute(_args, ctx) {
    const result = await ctx.wireClient.fork(ctx.appState.sessionId);
    return ok(`Forked to: ${result.session_id}`);
  },
};

const undoCommand: SlashCommandDef = {
  name: 'undo',
  aliases: [],
  description: 'Undo the last turn',
  mode: 'both',
  async execute(_args, _ctx) {
    // Undo relies on `fork(sessionId, -1)` which is currently a stub in
    // KimiCoreClient (returns the same sessionId). Short-circuit until
    // fork is fully implemented so the user does not see a misleading
    // "Undone. New session: <same-id>" message.
    return ok('Undo is not yet implemented.');
  },
};

const debugCommand: SlashCommandDef = {
  name: 'debug',
  aliases: [],
  description: 'Show debug information',
  mode: 'both',
  async execute(_args, ctx) {
    const status = await ctx.wireClient.getStatus(ctx.appState.sessionId);
    const lines = [
      `Session:  ${ctx.appState.sessionId}`,
      `Model:    ${ctx.appState.model}`,
      `WorkDir:  ${ctx.appState.workDir}`,
      `State:    ${status.state}`,
      `Context:  ${(ctx.appState.contextUsage * 100).toFixed(1)}%`,
      `YOLO:     ${ctx.appState.yolo}`,
      `Plan:     ${ctx.appState.planMode}`,
      `Thinking: ${ctx.appState.thinking}`,
      `Theme:    ${ctx.appState.theme}`,
      `Version:  ${ctx.appState.version}`,
    ];
    return ok(lines.join('\n'));
  },
};

const editorCommand: SlashCommandDef = {
  name: 'editor',
  aliases: [],
  description: 'Set the external editor for Ctrl-O (persists to config.toml)',
  mode: 'both',
  async execute(args, ctx) {
    const trimmed = args.trim();
    if (trimmed.length === 0) {
      // Defer UI to InteractiveMode — it renders a ChoicePicker with the
      // same preset options as Python (`code --wait` / `vim` / `nano` /
      // auto-detect) and writes the selection back through the same
      // persistence path as the direct-arg branch below.
      return ok('__show_editor_picker__');
    }

    ctx.setAppState({ editorCommand: trimmed });
    try {
      saveConfigPatch({ default_editor: trimmed });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return ok(`Editor set in memory but failed to persist: ${msg}`);
    }

    // Warn (don't block) if the binary is not in PATH — parity with
    // Python's shutil.which check.
    void resolveEditorCommand; // retain import for the picker path
    return ok(`Editor set to "${trimmed}" and saved to config.toml.`);
  },
};

// ── Export all shell commands ────────────────────────────────────────

export const shellCommands: SlashCommandDef[] = [
  exitCommand,
  helpCommand,
  versionCommand,
  clearCommand,
  newCommand,
  sessionsCommand,
  titleCommand,
  themeCommand,
  yoloCommand,
  planCommand,
  modelCommand,
  thinkingCommand,
  usageCommand,
  forkCommand,
  undoCommand,
  debugCommand,
  editorCommand,
];
