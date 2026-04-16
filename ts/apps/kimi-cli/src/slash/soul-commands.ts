/**
 * Soul-level slash commands.
 *
 * These commands are forwarded to the agent core via Wire RPC.
 * The core handles the actual logic (compaction, init, etc.).
 */

import type { SlashCommandDef, SlashCommandResult } from './registry.js';

function ok(message?: string): SlashCommandResult {
  if (message !== undefined) return { type: 'ok', message };
  return { type: 'ok' };
}

const compactCommand: SlashCommandDef = {
  name: 'compact',
  aliases: [],
  description: 'Compact the conversation context',
  mode: 'both',
  async execute(_args, ctx) {
    await ctx.wireClient.compact(ctx.appState.sessionId);
    return ok('Context compacted.');
  },
};

const initCommand: SlashCommandDef = {
  name: 'init',
  aliases: [],
  description: 'Generate AGENTS.md for the project',
  mode: 'agent',
  async execute(_args, _ctx) {
    // This is sent as a user message that the agent core interprets.
    return ok('__send_as_message__:/init');
  },
};

const addDirCommand: SlashCommandDef = {
  name: 'add-dir',
  aliases: ['adddir'],
  description: 'Add a directory to the workspace',
  mode: 'agent',
  async execute(args, _ctx) {
    if (args.length === 0) {
      return ok('Usage: /add-dir <path>');
    }
    // Sent as a user message for the agent core to handle.
    return ok(`__send_as_message__:/add-dir ${args}`);
  },
};

export const soulCommands: SlashCommandDef[] = [compactCommand, initCommand, addDirCommand];
