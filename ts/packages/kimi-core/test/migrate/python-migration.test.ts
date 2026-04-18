// Slice 2.7 — Python session migration adapter.
//
// Coverage:
//   - End-to-end: Python fixture → migratePythonSession → replayWire 'ok'
//   - Content double-shape (string vs list)
//   - ThinkPart.encrypted → think_signature
//   - TokenUsage four-dim → three-dim (Q1)
//   - Tool name mapping (default + override)
//   - Unsupported content (image/audio/video) → dropped + warning
//   - Notification category fallback
//   - Compaction placeholder synth
//   - Subagent directory presence warning
//   - tool_result.is_error fallback
//   - Empty session
//   - Flattened dir layout preserves source uuid
//   - Legacy wire.jsonl without metadata header

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migratePythonSession } from '../../src/migrate/python/index.js';
import {
  indexWireRecords,
  mapPythonToTsRecords,
  mapTokenUsage,
  parseContent,
} from '../../src/migrate/python/mapper.js';
import { DEFAULT_TOOL_NAME_MAP, mapToolName } from '../../src/migrate/python/tool-name-map.js';
import { replayWire } from '../../src/storage/replay.js';

let workRoot: string;

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'kimi-migrate-'));
});

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

async function makePythonSession(args: {
  readonly md5: string;
  readonly uuid: string;
  readonly context: readonly unknown[];
  readonly wire?: readonly unknown[] | undefined;
  readonly state?: unknown;
  readonly includeKimiJson?: boolean | undefined;
  readonly workDir?: string | undefined;
  readonly withSubagent?: boolean | undefined;
}): Promise<{ sourceDir: string; targetDir: string; kimiHome: string }> {
  const kimiHome = join(workRoot, 'python-home');
  const sessionDir = join(kimiHome, 'sessions', args.md5, args.uuid);
  await mkdir(sessionDir, { recursive: true });
  const contextLines = (args.context as readonly object[])
    .map((entry) => JSON.stringify(entry))
    .join('\n');
  await writeFile(join(sessionDir, 'context.jsonl'), contextLines + '\n', 'utf8');
  if (args.wire !== undefined) {
    const wireLines = (args.wire as readonly object[]).map((e) => JSON.stringify(e)).join('\n');
    await writeFile(join(sessionDir, 'wire.jsonl'), wireLines + '\n', 'utf8');
  }
  if (args.state !== undefined) {
    await writeFile(join(sessionDir, 'state.json'), JSON.stringify(args.state), 'utf8');
  }
  if (args.includeKimiJson === true) {
    const kimiJson = {
      work_dirs: [
        {
          path: args.workDir ?? '/tmp/project',
          kaos: 'local',
          last_session_id: args.uuid,
        },
      ],
    };
    await writeFile(join(kimiHome, 'kimi.json'), JSON.stringify(kimiJson), 'utf8');
  }
  if (args.withSubagent === true) {
    await mkdir(join(sessionDir, 'subagents', 'sub-1'), { recursive: true });
    await writeFile(join(sessionDir, 'subagents', 'sub-1', 'context.jsonl'), '', 'utf8');
  }
  const targetDir = join(workRoot, 'ts-home', 'sessions', args.uuid);
  return { sourceDir: sessionDir, targetDir, kimiHome };
}

// ── Unit tests: parseContent ──────────────────────────────────────────

describe('parseContent', () => {
  it('accepts string-shaped content (single TextPart optimisation)', () => {
    const r = parseContent('hello world');
    expect(r.text).toBe('hello world');
    expect(r.thinkParts).toEqual([]);
    expect(r.droppedCount).toBe(0);
  });

  it('accepts list-shaped content with mixed parts', () => {
    const r = parseContent([
      { type: 'text', text: 'hi ' },
      { type: 'text', text: 'there' },
      { type: 'think', think: 'secret', encrypted: 'sig-x' },
    ]);
    expect(r.text).toBe('hi there');
    expect(r.thinkParts).toHaveLength(1);
    expect(r.thinkParts[0]?.encrypted).toBe('sig-x');
  });

  it('drops image/audio/video parts and emits warnings', () => {
    const r = parseContent([
      { type: 'text', text: 'caption' },
      { type: 'image_url', image_url: { url: 'http://x' } },
      { type: 'audio_url', audio_url: { url: 'http://y' } },
      { type: 'video_url', video_url: { url: 'http://z' } },
    ]);
    expect(r.text).toBe('caption');
    expect(r.droppedCount).toBe(3);
    expect(r.dropWarnings).toHaveLength(3);
  });
});

// ── Unit tests: mapTokenUsage (§Q1) ───────────────────────────────────

describe('mapTokenUsage', () => {
  it('aggregates four Python dims into three TS dims', () => {
    const result = mapTokenUsage({
      input_other: 100,
      input_cache_read: 50,
      input_cache_creation: 25,
      output: 200,
    });
    expect(result).toEqual({
      input_tokens: 175,
      output_tokens: 200,
      cache_read_tokens: 50,
      cache_write_tokens: 25,
    });
  });

  it('omits zero-value cache dims', () => {
    const result = mapTokenUsage({ input_other: 10, output: 5 });
    expect(result).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it('returns undefined for null input', () => {
    expect(mapTokenUsage(null)).toBeUndefined();
    // oxlint-disable-next-line unicorn/no-useless-undefined
    expect(mapTokenUsage(undefined)).toBeUndefined();
  });
});

// ── Unit tests: tool name mapping ─────────────────────────────────────

describe('mapToolName', () => {
  it('uses the default map', () => {
    expect(mapToolName('ReadFile')).toBe('Read');
    expect(mapToolName('WriteFile')).toBe('Write');
    expect(mapToolName('StrReplaceFile')).toBe('Edit');
    expect(mapToolName('Shell')).toBe('Bash');
  });

  it('passes through unknown and MCP tool names', () => {
    expect(mapToolName('Grep')).toBe('Grep');
    expect(mapToolName('mcp__server__do_thing')).toBe('mcp__server__do_thing');
    expect(mapToolName('SetTodoList')).toBe('SetTodoList');
  });

  it('applies overrides ahead of the default map', () => {
    const out = mapToolName('ReadFile', { ReadFile: 'MyCustomRead' });
    expect(out).toBe('MyCustomRead');
  });

  it('default map is a frozen object', () => {
    expect(Object.isFrozen(DEFAULT_TOOL_NAME_MAP)).toBe(true);
  });
});

// ── Mapper unit tests ─────────────────────────────────────────────────

describe('mapPythonToTsRecords', () => {
  it('synthesises turn_begin + user_message + assistant_message + tool_call_dispatched + tool_result + turn_end', () => {
    const wire = indexWireRecords([
      {
        timestamp: 100,
        message: {
          type: 'ToolResult',
          payload: {
            tool_call_id: 'tc1',
            return_value: { is_error: false, output: 'RESULT_OUTPUT' },
          },
        },
      },
      {
        timestamp: 101,
        message: {
          type: 'StatusUpdate',
          payload: {
            token_usage: {
              input_other: 10,
              input_cache_read: 5,
              input_cache_creation: 0,
              output: 20,
            },
          },
        },
      },
      { timestamp: 102, message: { type: 'TurnEnd', payload: {} } },
    ]);
    const mapped = mapPythonToTsRecords(
      [
        { role: 'user', content: 'do a thing' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'calling tool' }],
          tool_calls: [
            {
              type: 'function',
              id: 'tc1',
              function: { name: 'ReadFile', arguments: '{"path":"/a"}' },
            },
          ],
        },
        { role: 'tool', content: 'RESULT_OUTPUT', tool_call_id: 'tc1' },
      ],
      wire,
      null,
      { fallbackModel: 'kimi-test' },
    );
    const types = mapped.records.map((r) => r.type);
    expect(types).toEqual([
      'turn_begin',
      'user_message',
      'assistant_message',
      'tool_call_dispatched',
      'tool_result',
      'turn_end',
    ]);
    const assistant = mapped.records[2] as {
      tool_calls: Array<{ id: string; name: string; args: unknown }>;
      model: string;
      usage?: { input_tokens: number; output_tokens: number };
    };
    expect(assistant.tool_calls[0]?.name).toBe('Read');
    expect(assistant.tool_calls[0]?.args).toEqual({ path: '/a' });
    expect(assistant.model).toBe('kimi-test');
    expect(assistant.usage?.input_tokens).toBe(15);
    expect(assistant.usage?.output_tokens).toBe(20);
    const toolResult = mapped.records[4] as { output: unknown; is_error?: boolean };
    expect(toolResult.output).toBe('RESULT_OUTPUT');
    expect(toolResult.is_error).toBe(false);
    expect(mapped.messageCount).toBe(3);
  });

  it('preserves ThinkPart.encrypted as think_signature', () => {
    const wire = indexWireRecords([]);
    const mapped = mapPythonToTsRecords(
      [
        {
          role: 'assistant',
          content: [
            { type: 'think', think: 'reasoning...', encrypted: 'sig-abc' },
            { type: 'text', text: 'answer' },
          ],
        },
      ],
      wire,
      null,
      { fallbackModel: 'm' },
    );
    const assistant = mapped.records.find((r) => r.type === 'assistant_message') as {
      think: string | null;
      think_signature?: string;
    };
    expect(assistant.think).toBe('reasoning...');
    expect(assistant.think_signature).toBe('sig-abc');
  });

  it('falls back to is_error=false + warning when wire.jsonl lacks the tool result', () => {
    const wire = indexWireRecords([]);
    const mapped = mapPythonToTsRecords(
      [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { type: 'function', id: 'tc99', function: { name: 'Shell', arguments: '{}' } },
          ],
        },
        { role: 'tool', content: 'ok', tool_call_id: 'tc99' },
      ],
      wire,
      null,
      { fallbackModel: 'm' },
    );
    const toolResult = mapped.records.find((r) => r.type === 'tool_result') as {
      is_error?: boolean;
    };
    expect(toolResult.is_error).toBe(false);
    expect(mapped.warnings.some((w) => w.includes('no is_error'))).toBe(true);
  });

  it('counts dropped image/audio parts and emits warnings', () => {
    const wire = indexWireRecords([]);
    const mapped = mapPythonToTsRecords(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image_url', image_url: { url: 'http://img' } },
          ],
        },
      ],
      wire,
      null,
      { fallbackModel: 'm' },
    );
    expect(mapped.droppedContentCount).toBe(1);
    expect(mapped.warnings.some((w) => w.includes('image_url'))).toBe(true);
  });

  it('synthesises one compaction placeholder per Python CompactionEnd', () => {
    const wire = indexWireRecords([
      { timestamp: 1, message: { type: 'CompactionBegin', payload: {} } },
      { timestamp: 2, message: { type: 'CompactionEnd', payload: {} } },
      { timestamp: 3, message: { type: 'CompactionBegin', payload: {} } },
      { timestamp: 4, message: { type: 'CompactionEnd', payload: {} } },
    ]);
    const mapped = mapPythonToTsRecords([], wire, null, { fallbackModel: 'm' });
    const compactions = mapped.records.filter((r) => r.type === 'compaction');
    expect(compactions).toHaveLength(2);
    expect((compactions[0] as { summary: string }).summary).toBe('[migrated from Python session]');
  });

  it('falls back notification category to "system" for unknown values', () => {
    const wire = indexWireRecords([
      {
        timestamp: 1,
        message: {
          type: 'Notification',
          payload: {
            id: 'n1',
            category: 'unknown-category',
            type: 'some_type',
            source_kind: 'sk',
            source_id: 'sid',
            title: 't',
            body: 'b',
            severity: 'info',
          },
        },
      },
    ]);
    const mapped = mapPythonToTsRecords([], wire, null, { fallbackModel: 'm' });
    const notif = mapped.records.find((r) => r.type === 'notification') as {
      data: { category: string };
    };
    expect(notif.data.category).toBe('system');
    expect(mapped.warnings.some((w) => w.includes('unknown-category'))).toBe(true);
  });

  it('reports subagent warning via wire events', () => {
    const wire = indexWireRecords([
      {
        timestamp: 1,
        message: {
          type: 'SubagentEvent',
          payload: { parent_tool_call_id: 'tc', agent_id: 'a', event: {} },
        },
      },
    ]);
    const mapped = mapPythonToTsRecords([], wire, null, { fallbackModel: 'm' });
    expect(mapped.warnings.some((w) => w.includes('Subagent'))).toBe(true);
  });
});

// ── End-to-end: migratePythonSession ──────────────────────────────────

describe('migratePythonSession — end-to-end', () => {
  it('round-trips a multi-turn session with tool call → replayWire health=ok', async () => {
    const { sourceDir, targetDir } = await makePythonSession({
      md5: 'abc123',
      uuid: 'session-uuid-1',
      context: [
        { role: '_system_prompt', content: 'You are Kimi.' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
        { role: '_checkpoint', id: 0 },
        {
          role: 'user',
          content: [{ type: 'text', text: 'read /tmp/a.txt' }],
        },
        {
          role: 'assistant',
          content: [
            { type: 'think', think: 'plan', encrypted: 'sig-42' },
            { type: 'text', text: 'calling' },
          ],
          tool_calls: [
            {
              type: 'function',
              id: 'tc1',
              function: { name: 'ReadFile', arguments: '{"path":"/tmp/a.txt"}' },
            },
          ],
        },
        { role: 'tool', content: 'file contents', tool_call_id: 'tc1' },
        { role: 'assistant', content: 'done' },
      ],
      wire: [
        { type: 'metadata', protocol_version: '1.9' },
        {
          timestamp: 100,
          message: {
            type: 'TurnBegin',
            payload: { user_input: 'hello' },
          },
        },
        {
          timestamp: 101,
          message: {
            type: 'StatusUpdate',
            payload: {
              token_usage: {
                input_other: 5,
                input_cache_read: 0,
                input_cache_creation: 0,
                output: 10,
              },
            },
          },
        },
        { timestamp: 102, message: { type: 'TurnEnd', payload: {} } },
        {
          timestamp: 103,
          message: {
            type: 'ToolResult',
            payload: {
              tool_call_id: 'tc1',
              return_value: { is_error: false, output: 'file contents', message: '' },
            },
          },
        },
        {
          timestamp: 104,
          message: {
            type: 'StatusUpdate',
            payload: {
              token_usage: {
                input_other: 12,
                input_cache_read: 3,
                input_cache_creation: 0,
                output: 8,
              },
            },
          },
        },
        { timestamp: 105, message: { type: 'TurnEnd', payload: {} } },
      ],
      state: {
        version: 1,
        approval: { yolo: false, auto_approve_actions: ['Shell:ls'] },
        custom_title: 'Migration test',
        plan_mode: false,
        todos: [],
      },
      includeKimiJson: true,
      workDir: '/Users/test/project',
    });

    const result = await migratePythonSession({
      sourceDir,
      targetDir,
      fallbackModel: 'kimi-test-2',
    });

    expect(result.sessionId).toBe('session-uuid-1');
    expect(result.messageCount).toBe(6);
    expect(result.droppedContentCount).toBe(0);

    const replay = await replayWire(join(targetDir, 'wire.jsonl'), { supportedMajor: 2 });
    expect(replay.health).toBe('ok');

    const typeCounts: Record<string, number> = {};
    for (const r of replay.records) typeCounts[r.type] = (typeCounts[r.type] ?? 0) + 1;
    expect(typeCounts['user_message']).toBe(2);
    expect(typeCounts['assistant_message']).toBe(3);
    expect(typeCounts['tool_result']).toBe(1);
    expect(typeCounts['system_prompt_changed']).toBe(1);
    expect(typeCounts['tool_call_dispatched']).toBe(1);

    // state.json includes migratedFrom metadata
    const stateRaw = await (
      await import('node:fs/promises')
    ).readFile(join(targetDir, 'state.json'), 'utf8');
    const state = JSON.parse(stateRaw) as {
      session_id: string;
      migratedFrom: { workDirPath: string; sourceUuid: string };
      auto_approve_actions: string[];
      title?: string;
    };
    expect(state.session_id).toBe('session-uuid-1');
    expect(state.migratedFrom.workDirPath).toBe('/Users/test/project');
    expect(state.migratedFrom.sourceUuid).toBe('session-uuid-1');
    expect(state.auto_approve_actions).toContain('Shell:ls');
    expect(state.title).toBe('Migration test');
  });

  it('handles empty session without error', async () => {
    const { sourceDir, targetDir } = await makePythonSession({
      md5: 'empty',
      uuid: 'empty-uuid',
      context: [],
      wire: [{ type: 'metadata', protocol_version: '1.9' }],
    });
    const result = await migratePythonSession({
      sourceDir,
      targetDir,
      migratedFrom: { workDirPath: '/tmp/empty-project' },
    });
    expect(result.messageCount).toBe(0);
    expect(result.sessionId).toBe('empty-uuid');
  });

  it('warns when subagents directory is non-empty', async () => {
    const { sourceDir, targetDir } = await makePythonSession({
      md5: 'sub',
      uuid: 'sub-uuid',
      context: [{ role: 'user', content: 'hi' }],
      withSubagent: true,
    });
    const warnings: string[] = [];
    const result = await migratePythonSession({
      sourceDir,
      targetDir,
      migratedFrom: { workDirPath: '/tmp/sub-project' },
      onWarning: (m) => warnings.push(m),
    });
    expect(result.warnings.some((w) => w.includes('Subagent'))).toBe(true);
    expect(warnings.some((w) => w.includes('Subagent'))).toBe(true);
  });

  it('flattens the md5/<uuid> layout to a flat <uuid> target', async () => {
    const { sourceDir, targetDir } = await makePythonSession({
      md5: '8eafa27004bdf12c3174dce6245e4825',
      uuid: '3457ad97-771c-4a3f-acb9-075952a5f764',
      context: [{ role: 'user', content: 'flat' }],
    });
    const result = await migratePythonSession({
      sourceDir,
      targetDir,
      migratedFrom: { workDirPath: '/tmp/flat-project' },
    });
    expect(result.sessionId).toBe('3457ad97-771c-4a3f-acb9-075952a5f764');
    expect(result.targetDir).toBe(targetDir);
  });

  it('accepts explicit workDirPath override when kimi.json is missing', async () => {
    const { sourceDir, targetDir } = await makePythonSession({
      md5: 'x',
      uuid: 'u1',
      context: [{ role: 'user', content: 'hi' }],
    });
    const result = await migratePythonSession({
      sourceDir,
      targetDir,
      migratedFrom: { workDirPath: '/explicit/dir' },
    });
    const stateRaw = await (
      await import('node:fs/promises')
    ).readFile(join(targetDir, 'state.json'), 'utf8');
    const state = JSON.parse(stateRaw) as {
      migratedFrom: { workDirPath: string | null };
    };
    expect(state.migratedFrom.workDirPath).toBe('/explicit/dir');
    expect(result.sessionId).toBe('u1');
  });

  it('applies toolNameMap overrides during migration', async () => {
    const { sourceDir, targetDir } = await makePythonSession({
      md5: 'map',
      uuid: 'u2',
      context: [
        {
          role: 'assistant',
          content: 'a',
          tool_calls: [
            { type: 'function', id: 'tc1', function: { name: 'CustomPy', arguments: '{}' } },
          ],
        },
      ],
    });
    await migratePythonSession({
      sourceDir,
      targetDir,
      toolNameMap: { CustomPy: 'CustomTs' },
      migratedFrom: { workDirPath: '/tmp/map-project' },
    });
    const replay = await replayWire(join(targetDir, 'wire.jsonl'), { supportedMajor: 2 });
    const assistant = replay.records.find((r) => r.type === 'assistant_message') as {
      tool_calls: Array<{ name: string }>;
    };
    expect(assistant.tool_calls[0]?.name).toBe('CustomTs');
  });

  it('handles wire.jsonl without metadata header (legacy)', async () => {
    const { sourceDir, targetDir } = await makePythonSession({
      md5: 'legacy',
      uuid: 'legacy-uuid',
      context: [{ role: 'user', content: 'legacy test' }],
      wire: [
        // intentionally no metadata header
        { timestamp: 1, message: { type: 'TurnBegin', payload: { user_input: 'legacy test' } } },
        { timestamp: 2, message: { type: 'TurnEnd', payload: {} } },
      ],
    });
    const result = await migratePythonSession({
      sourceDir,
      targetDir,
      migratedFrom: { workDirPath: '/tmp/legacy-project' },
    });
    expect(result.sessionId).toBe('legacy-uuid');
    const replay = await replayWire(join(targetDir, 'wire.jsonl'), { supportedMajor: 2 });
    expect(replay.health).toBe('ok');
  });
});
