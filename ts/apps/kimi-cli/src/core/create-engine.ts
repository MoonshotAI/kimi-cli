/**
 * Engine factory — assembles a SoulPlus instance from CLI config.
 *
 * Reads providers/models from the loaded Config, creates the matching
 * kosong ChatProvider, registers built-in tools with LocalKaos, loads
 * the system prompt, and wires up SoulPlus with all dependencies.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';

import {
  InMemoryContextState,
  InMemorySessionJournalImpl,
  SoulPlus,
} from '@moonshot-ai/core';
import type { Tool, Runtime } from '@moonshot-ai/core';

import { SessionEventBus } from '../../../../packages/kimi-core/src/soul-plus/session-event-bus.js';
import { createKosongAdapter } from '../../../../packages/kimi-core/src/soul-plus/kosong-adapter.js';
import {
  createStubCompactionProvider,
  createStubJournalCapability,
} from '../../../../packages/kimi-core/src/soul-plus/runtime-factory.js';

// Tools
import { ReadTool } from '../../../../packages/kimi-core/src/tools/read.js';
import { WriteTool } from '../../../../packages/kimi-core/src/tools/write.js';
import { EditTool } from '../../../../packages/kimi-core/src/tools/edit.js';
import { BashTool } from '../../../../packages/kimi-core/src/tools/bash.js';
import { GrepTool } from '../../../../packages/kimi-core/src/tools/grep.js';
import { GlobTool } from '../../../../packages/kimi-core/src/tools/glob.js';
import { LocalKaos } from '@moonshot-ai/kaos';

import type { ChatProvider } from '@moonshot-ai/kosong';
import { MockChatProvider } from '@moonshot-ai/kosong';
import { KimiChatProvider } from '@moonshot-ai/kosong/providers/kimi';
import { AnthropicChatProvider } from '@moonshot-ai/kosong/providers/anthropic';
import { OpenAILegacyChatProvider } from '@moonshot-ai/kosong/providers/openai-legacy';
import { OpenAIResponsesChatProvider } from '@moonshot-ai/kosong/providers/openai-responses';
import { GoogleGenAIChatProvider } from '@moonshot-ai/kosong/providers/google-genai';

import type { Config, LLMProvider, LLMModel } from '../config/schema.js';

// ── Public types ────────────────────────────────────────────────────

export interface CreateEngineOptions {
  sessionId: string;
  model: string;
  workDir: string;
  config: Config;
  systemPrompt?: string;
}

export interface Engine {
  soulPlus: SoulPlus;
  eventBus: SessionEventBus;
}

// ── System prompt ───────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadSystemPrompt(workDir: string): string {
  // Read the template from the Python agent's system.md
  const templatePath = resolve(__dirname, '../../../../..', 'src/kimi_cli/agents/default/system.md');
  let template: string;
  try {
    template = readFileSync(templatePath, 'utf-8');
  } catch {
    // Fallback if the Python source isn't available
    return 'You are Kimi Code CLI, an interactive AI coding assistant. Help users with software engineering tasks by using the tools available to you.';
  }

  // Simple variable substitution (not full Jinja — just the key ones)
  const osName = platform() === 'darwin' ? 'macOS' : platform() === 'win32' ? 'Windows' : 'Linux';
  const shell = process.env['SHELL'] ?? (platform() === 'win32' ? 'PowerShell' : '/bin/bash');
  const now = new Date().toISOString();

  let dirListing: string;
  try {
    const entries = readdirSync(workDir).slice(0, 50);
    dirListing = entries.join('\n');
  } catch {
    dirListing = '(unable to list directory)';
  }

  return template
    .replace(/\$\{ROLE_ADDITIONAL\}/g, '')
    .replace(/\$\{KIMI_OS\}/g, osName)
    .replace(/\$\{KIMI_SHELL\}/g, shell)
    .replace(/\$\{KIMI_NOW\}/g, now)
    .replace(/\$\{KIMI_WORK_DIR\}/g, workDir)
    .replace(/\$\{KIMI_WORK_DIR_LS\}/g, dirListing)
    .replace(/\$\{KIMI_AGENTS_MD\}/g, '(no AGENTS.md found)')
    .replace(/\$\{KIMI_SKILLS\}/g, '(no skills configured)')
    .replace(/\$\{KIMI_ADDITIONAL_DIRS_INFO\}/g, '')
    // Strip Jinja conditionals ({% if ... %} ... {% endif %})
    .replace(/\{%.*?%\}/gs, '')
    .trim();
}

// ── Provider factory ────────────────────────────────────────────────

function createChatProvider(
  model: string,
  config: Config,
): ChatProvider {
  const modelConfig = config.models[model] as LLMModel | undefined;
  const providerName = modelConfig?.provider;

  if (providerName) {
    const providerConfig = config.providers[providerName] as LLMProvider | undefined;
    if (providerConfig) {
      return createProviderFromConfig(providerConfig, modelConfig.model);
    }
  }

  // Fallback: try environment variables
  if (process.env['KIMI_API_KEY']) {
    return new KimiChatProvider({
      model,
      apiKey: process.env['KIMI_API_KEY'],
      baseUrl: process.env['KIMI_BASE_URL'],
      defaultHeaders: { 'User-Agent': 'KimiCLI/0.1.0-ts' },
    });
  }
  if (process.env['ANTHROPIC_API_KEY']) {
    return new AnthropicChatProvider({ model, apiKey: process.env['ANTHROPIC_API_KEY'] });
  }
  if (process.env['OPENAI_API_KEY']) {
    return new OpenAIResponsesChatProvider({ model, apiKey: process.env['OPENAI_API_KEY'], baseUrl: process.env['OPENAI_BASE_URL'] });
  }
  if (process.env['GOOGLE_API_KEY']) {
    return new GoogleGenAIChatProvider({ model, apiKey: process.env['GOOGLE_API_KEY'] });
  }

  process.stderr.write(
    'Warning: No API key found. Using mock provider.\n' +
    'Set KIMI_API_KEY or configure providers in ~/.kimi/config.toml.\n',
  );
  return new MockChatProvider([
    { type: 'text', text: 'No API key configured. Set KIMI_API_KEY or configure providers in config.toml.' },
  ]);
}

function createProviderFromConfig(provider: LLMProvider, modelName: string): ChatProvider {
  const apiKey = provider.api_key || undefined;

  switch (provider.type) {
    case 'kimi':
      return new KimiChatProvider({
        model: modelName,
        apiKey,
        baseUrl: provider.base_url || undefined,
        defaultHeaders: {
          'User-Agent': 'KimiCLI/0.1.0-ts',
          ...(provider.custom_headers ?? {}),
        },
      });
    case 'anthropic':
      return new AnthropicChatProvider({ model: modelName, apiKey });
    case 'openai_legacy':
      return new OpenAILegacyChatProvider({ model: modelName, apiKey, baseUrl: provider.base_url || undefined });
    case 'openai_responses':
      return new OpenAIResponsesChatProvider({ model: modelName, apiKey, baseUrl: provider.base_url || undefined });
    case 'google_genai':
    case 'gemini':
      return new GoogleGenAIChatProvider({ model: modelName, apiKey });
    default:
      return new MockChatProvider([
        { type: 'text', text: `Unsupported provider type: ${provider.type}` },
      ]);
  }
}

// ── Built-in tools ──────────────────────────────────────────────────

function createBuiltinTools(workDir: string): Tool[] {
  const kaos = new LocalKaos();
  return [
    new ReadTool(kaos),
    new WriteTool(kaos),
    new EditTool(kaos),
    new BashTool(kaos, workDir),
    new GrepTool(kaos, workDir),
    new GlobTool(kaos, workDir),
  ];
}

// ── Engine factory ──────────────────────────────────────────────────

export function createEngine(opts: CreateEngineOptions): Engine {
  const eventBus = new SessionEventBus();

  // System prompt
  const systemPrompt = opts.systemPrompt ?? loadSystemPrompt(opts.workDir);

  // Tools
  const tools = createBuiltinTools(opts.workDir);
  const toolNames = new Set(tools.map((t) => t.name));

  // Context state
  const contextState = new InMemoryContextState({
    initialModel: opts.model,
    initialSystemPrompt: systemPrompt,
    initialActiveTools: toolNames,
  });

  // Session journal (in-memory)
  const sessionJournal = new InMemorySessionJournalImpl();

  // LLM adapter
  const chatProvider = createChatProvider(opts.model, opts.config);
  const kosongAdapter = createKosongAdapter({ provider: chatProvider });

  // Runtime — SoulPlus creates its own LifecycleGateFacade internally
  const dummyLifecycle = { async transitionTo() {} };
  const runtime: Runtime = {
    kosong: kosongAdapter,
    compactionProvider: createStubCompactionProvider(),
    lifecycle: dummyLifecycle,
    journal: createStubJournalCapability(),
  };

  // SoulPlus
  const soulPlus = new SoulPlus({
    sessionId: opts.sessionId,
    contextState,
    sessionJournal,
    runtime,
    eventBus,
    tools,
  });

  return { soulPlus, eventBus };
}
