/**
 * Slice 4.5 headless E2E smoke test.
 *
 * Verifies the core provider → session → turn pipeline by sending a
 * real prompt to the Kimi API and observing wire events. This is NOT a
 * full-parity replica of `bootstrapCoreShell` — it omits MCP loading,
 * session resume/continue branches, and some host-injected tools
 * (Agent, background task control). Its purpose is to confirm that a
 * real LLM call round-trips through the kimi-core turn machinery.
 *
 * Run with:
 *   pnpm --filter @moonshot-ai/cli exec tsx scripts/e2e-smoke.ts
 *
 * CLI flags (optional):
 *   --model <alias>    override model alias (default: kimi-k2-5)
 *   --prompt <text>    prompt to send (default: greet only)
 *   --workdir <dir>    workspace directory (default: /tmp/kimi-e2e)
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import {
  AgentRegistry,
  BackgroundProcessManager,
  BashTool,
  DefaultSkillManager,
  EditTool,
  ExitPlanModeTool,
  FetchURLTool,
  GlobTool,
  GrepTool,
  InMemoryTodoStore,
  PathConfig,
  ReadMediaFileTool,
  ReadTool,
  SessionManager,
  SetTodoListTool,
  TaskListTool,
  TaskOutputTool,
  TaskStopTool,
  ThinkTool,
  WebSearchTool,
  WriteTool,
  assembleSystemPrompt,
  createKosongAdapter,
  createKosongCompactionProvider,
  createProviderFromConfig,
  createRuntime,
  createStubJournalCapability,
  extendWorkspaceWithSkillRoots,
  loadConfig as loadKimiCoreConfig,
  resolveSkillRoots,
} from '@moonshot-ai/core';
import type { Runtime, Tool, WorkspaceConfig } from '@moonshot-ai/core';
import { localKaos } from '@moonshot-ai/kaos';

import { StubUrlFetcher } from '../src/providers/stub-fetch-url.js';
import { StubWebSearchProvider } from '../src/providers/stub-web-search.js';
import { KimiCoreClient } from '../src/wire/kimi-core-client.js';
import type { PerSessionToolContext } from '../src/wire/kimi-core-client.js';

// ── CLI parsing ─────────────────────────────────────────────────────────

interface SmokeArgs {
  model: string;
  prompt: string;
  workDir: string;
}

function parseArgs(): SmokeArgs {
  const argv = process.argv.slice(2);
  let model = 'kimi-k2-5';
  let prompt = 'Reply with a single word: hi';
  let workDir = '/tmp/kimi-e2e';
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--model' && i + 1 < argv.length) {
      model = argv[i + 1]!;
      i += 1;
    } else if (a === '--prompt' && i + 1 < argv.length) {
      prompt = argv[i + 1]!;
      i += 1;
    } else if (a === '--workdir' && i + 1 < argv.length) {
      workDir = argv[i + 1]!;
      i += 1;
    }
  }
  return { model, prompt, workDir };
}

// ── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  mkdirSync(args.workDir, { recursive: true });

  process.stderr.write(
    `[smoke] model=${args.model} workDir=${args.workDir}\n[smoke] prompt=${JSON.stringify(args.prompt)}\n`,
  );

  // 1. Load config
  const pathConfig = new PathConfig();
  const kimiConfig = loadKimiCoreConfig({ pathConfig, workspaceDir: args.workDir });
  process.stderr.write(`[smoke] config loaded, defaultModel=${String(kimiConfig.defaultModel)}\n`);

  // 2. Provider
  const provider = await createProviderFromConfig(kimiConfig, args.model);
  process.stderr.write(`[smoke] provider created: ${provider.constructor.name}\n`);

  // 3. Agent / skills / system prompt
  const agentRegistry = new AgentRegistry();
  const agentSpec = agentRegistry.resolve('default');
  const skillManager = new DefaultSkillManager({
    onWarning: (msg) => process.stderr.write(`[smoke][skill] ${msg}\n`),
  });
  const skillRoots = await resolveSkillRoots({ workDir: args.workDir });
  await skillManager.init(skillRoots);
  const systemPrompt = assembleSystemPrompt(agentSpec, {
    workspaceDir: args.workDir,
    kimiHome: pathConfig.home,
    kimiSkills: skillManager.getKimiSkillsDescription(),
  });

  // 4. Runtime
  const runtime: Runtime = createRuntime({
    kosong: createKosongAdapter({ provider }),
    compactionProvider: createKosongCompactionProvider(provider),
    lifecycle: {
      transitionTo: async () => {
        throw new Error('lifecycle placeholder');
      },
    },
    journal: createStubJournalCapability(),
  });

  // 5. SessionManager + tools
  const sessionManager = new SessionManager(pathConfig);
  const baseWorkspace: WorkspaceConfig = {
    workspaceDir: args.workDir,
    additionalDirs: [],
  };
  const workspace = extendWorkspaceWithSkillRoots(baseWorkspace, skillManager.getSkillRoots());

  const backgroundManager = new BackgroundProcessManager();
  const todoStore = new InMemoryTodoStore();
  const stubWebSearch = new StubWebSearchProvider();
  const stubUrlFetcher = new StubUrlFetcher();

  const buildTools = (ctx: PerSessionToolContext): Tool[] => [
    new ReadTool(localKaos, workspace),
    new WriteTool(localKaos, workspace),
    new EditTool(localKaos, workspace),
    new GrepTool(localKaos, workspace),
    new GlobTool(localKaos, workspace),
    new BashTool(localKaos, args.workDir, backgroundManager),
    new ReadMediaFileTool(localKaos, workspace),
    new ThinkTool(),
    new SetTodoListTool(todoStore),
    new ExitPlanModeTool({
      isPlanModeActive: ctx.isPlanModeActive,
      setPlanMode: ctx.setPlanMode,
    }),
    new TaskListTool(backgroundManager),
    new TaskOutputTool(backgroundManager),
    new TaskStopTool(backgroundManager),
    new WebSearchTool(stubWebSearch),
    new FetchURLTool(stubUrlFetcher),
  ];

  // 6. Client + session
  const client = new KimiCoreClient({
    sessionManager,
    runtime,
    model: args.model,
    systemPrompt,
    buildTools,
    skillManager,
  });

  const { session_id: sessionId } = await client.createSession(args.workDir);
  process.stderr.write(`[smoke] session created: ${sessionId}\n`);

  // 7. Subscribe + prompt
  const iterable = client.subscribe(sessionId);
  const consumer = (async (): Promise<void> => {
    for await (const msg of iterable) {
      const label = msg.type === 'event' ? `event:${msg.method}` : msg.type;
      const payload = 'data' in msg ? msg.data : undefined;
      process.stdout.write(`[smoke][${label}] ${JSON.stringify(payload).slice(0, 500)}\n`);
      if (msg.type === 'event' && msg.method === 'turn.end') {
        return;
      }
    }
  })();

  // 8. Kick off the prompt
  const { turn_id: turnId } = await client.prompt(sessionId, args.prompt);
  process.stderr.write(`[smoke] prompt dispatched, turn_id=${turnId}\n`);

  // 9. Wait for the turn to finish
  const timeoutMs = 60_000;
  const timeout = new Promise<'timeout'>((resolve) => {
    setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const result = await Promise.race([consumer.then(() => 'ok' as const), timeout]);

  if (result === 'timeout') {
    process.stderr.write(`[smoke] ⚠️ timed out after ${timeoutMs}ms\n`);
  } else {
    process.stderr.write('[smoke] ✅ turn.end observed\n');
  }

  await client.dispose();
  process.stderr.write(`[smoke] session dir: ${join(pathConfig.sessionsDir, sessionId)}\n`);
  process.exit(result === 'timeout' ? 2 : 0);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[smoke] FATAL: ${err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)}\n`,
  );
  process.exit(1);
});
