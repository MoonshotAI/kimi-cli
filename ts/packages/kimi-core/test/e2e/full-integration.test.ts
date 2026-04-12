import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalKaos } from '@moonshot-ai/kaos';
import type { JsonType, Tool, ToolReturnValue } from '@moonshot-ai/kosong';
import { ScriptedEchoChatProvider, SimpleToolset, toolError, toolOk } from '@moonshot-ai/kosong';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Runtime, TurnResult } from '../../src/index.js';
import { CollectingSink, runTurn } from '../../src/index.js';

// ── Integration: runTurn → ScriptedEcho → SimpleToolset → LocalKaos ──
//
// Highest-level happy-path integration: the scripted provider asks to read a
// file, the tool reads the file via LocalKaos on the real filesystem, the
// scripted provider reacts to the content and asks to write a new file, then
// produces a final text message. Every wire event along the way is asserted.
//
// This exercises the entire kimi-core stack in one test:
//   runTurn → step → generate → ScriptedEchoChatProvider
//     → SimpleToolset.handle → LocalKaos.readText/writeText
//     → history append → next step → final text → stop

describe('e2e: full integration (runTurn + LocalKaos + SimpleToolset)', () => {
  let tempDir: string;
  let kaos: LocalKaos;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'kimi-full-integration-'));
    kaos = new LocalKaos();
    await kaos.chdir(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function makeKaosToolset(k: LocalKaos): SimpleToolset {
    const ts = new SimpleToolset();

    const readFileTool: Tool = {
      name: 'read_file',
      description: 'Read a UTF-8 text file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    };
    ts.add(readFileTool, async (args: JsonType): Promise<ToolReturnValue> => {
      const { path } = args as { path: string };
      try {
        const content = await k.readText(path);
        return toolOk({ output: content, brief: `read ${path}` });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        // Pass `output: msg` explicitly so the LLM sees the error text on
        // the next step. `toolError`'s default `output` is `""` (matching
        // Python), so tool authors must opt in to surfacing error detail.
        return toolError({ message: msg, output: msg, brief: `read ${path} failed` });
      }
    });

    const writeFileTool: Tool = {
      name: 'write_file',
      description: 'Write a UTF-8 text file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    };
    ts.add(writeFileTool, async (args: JsonType): Promise<ToolReturnValue> => {
      const { path, content } = args as { path: string; content: string };
      const bytes = await k.writeText(path, content);
      return toolOk({ output: `wrote ${bytes} bytes`, brief: `wrote ${path}` });
    });

    const execTool: Tool = {
      name: 'exec',
      description: 'Run a shell-free binary command',
      parameters: {
        type: 'object',
        properties: {
          argv: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['argv'],
      },
    };
    ts.add(execTool, async (args: JsonType): Promise<ToolReturnValue> => {
      const { argv } = args as { argv: string[] };
      const proc = await k.exec(...argv);
      const chunks: Buffer[] = [];
      for await (const chunk of proc.stdout) {
        chunks.push(Buffer.from(chunk as Buffer));
      }
      const exitCode = await proc.wait();
      const stdout = Buffer.concat(chunks).toString('utf-8');
      return toolOk({ output: `exit=${exitCode}\n${stdout}` });
    });

    return ts;
  }

  it('three-step loop: read → write → final text, with full wire event sequence', async () => {
    // Seed a real file on disk.
    await kaos.writeText('source.txt', 'original-content');

    const toolset = makeKaosToolset(kaos);

    // Script 3 assistant messages:
    //   turn 0: call read_file("source.txt")
    //   turn 1: call write_file("copy.txt", "original-content")
    //   turn 2: final text, no tool calls → stops
    const provider = new ScriptedEchoChatProvider([
      'tool_call: {"id": "call_read", "name": "read_file", "arguments": "{\\"path\\":\\"source.txt\\"}"}',
      'tool_call: {"id": "call_write", "name": "write_file", "arguments": "{\\"path\\":\\"copy.txt\\",\\"content\\":\\"original-content\\"}"}',
      'text: copied the file successfully',
    ]);

    const runtime: Runtime = {
      llm: provider,
      kaos,
      toolset,
      maxStepsPerTurn: 10,
    };

    const sink = new CollectingSink();
    const controller = new AbortController();

    const result: TurnResult = await runTurn(
      'please copy source.txt',
      runtime,
      sink,
      controller.signal,
    );

    // ── Verify final turn result ──
    expect(result.stopReason).toBe('done');
    expect(result.stepCount).toBe(3);

    // ── Verify real filesystem effect ──
    const copied = await readFile(join(tempDir, 'copy.txt'), 'utf-8');
    expect(copied).toBe('original-content');

    // ── Verify wire event sequence ──
    // Expected: step.begin(0), tool.call(read), tool.result(read),
    //           step.end, step.begin(1), tool.call(write), tool.result(write),
    //           step.end, step.begin(2), content.delta(text), step.end
    const types = sink.events.map((e) => e.type);
    expect(types).toEqual([
      'step.begin',
      'tool.call',
      'tool.result',
      'step.end',
      'step.begin',
      'tool.call',
      'tool.result',
      'step.end',
      'step.begin',
      'content.delta',
      'step.end',
    ]);

    // ── Tool call events are the right tools in the right order ──
    const toolCallEvents = sink.findByType('tool.call');
    expect(toolCallEvents).toHaveLength(2);
    expect(toolCallEvents[0]!.toolCall.id).toBe('call_read');
    expect(toolCallEvents[0]!.toolCall.function.name).toBe('read_file');
    expect(toolCallEvents[1]!.toolCall.id).toBe('call_write');
    expect(toolCallEvents[1]!.toolCall.function.name).toBe('write_file');

    // ── Tool result events carry the LocalKaos handler output ──
    const toolResultEvents = sink.findByType('tool.result');
    expect(toolResultEvents).toHaveLength(2);
    expect(toolResultEvents[0]!.toolCallId).toBe('call_read');
    expect(toolResultEvents[0]!.isError).toBe(false);
    expect(toolResultEvents[0]!.output).toBe('original-content');
    expect(toolResultEvents[1]!.toolCallId).toBe('call_write');
    expect(toolResultEvents[1]!.isError).toBe(false);
    expect(toolResultEvents[1]!.output).toBe('wrote 16 bytes');

    // ── Final content delta carries the wrap-up text ──
    const contentDeltas = sink.findByType('content.delta');
    expect(contentDeltas).toHaveLength(1);
    const finalPart = contentDeltas[0]!.part;
    expect(finalPart.type).toBe('text');
    if (finalPart.type === 'text') {
      expect(finalPart.text).toBe('copied the file successfully');
    }
  });

  it('tool error (read missing file) feeds the error message back to the LLM on the next step', async () => {
    // No file seeded. The read_file tool will surface a toolError.
    const toolset = makeKaosToolset(kaos);

    // turn 0: read_file("missing.txt") → error
    // turn 1: text: ack the error, no tool calls → stop
    const provider = new ScriptedEchoChatProvider([
      'tool_call: {"id": "call_1", "name": "read_file", "arguments": "{\\"path\\":\\"missing.txt\\"}"}',
      'text: file not found, giving up',
    ]);

    const runtime: Runtime = {
      llm: provider,
      kaos,
      toolset,
      maxStepsPerTurn: 10,
    };

    const sink = new CollectingSink();
    const controller = new AbortController();
    const result = await runTurn('read it', runtime, sink, controller.signal);

    expect(result.stopReason).toBe('done');
    expect(result.stepCount).toBe(2);

    const toolResults = sink.findByType('tool.result');
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.isError).toBe(true);
    // The error message surfaced through the tool handler is non-empty.
    expect(toolResults[0]!.output.length).toBeGreaterThan(0);
  });

  it('exec tool dispatches a real child process via LocalKaos', async () => {
    const toolset = makeKaosToolset(kaos);

    const provider = new ScriptedEchoChatProvider([
      // Use node -e so this works on any platform without relying on /bin/sh.
      'tool_call: {"id": "call_exec", "name": "exec", "arguments": "{\\"argv\\":[\\"node\\",\\"-e\\",\\"process.stdout.write(\'integration-exec-ok\')\\"]}"}',
      'text: exec complete',
    ]);

    const runtime: Runtime = {
      llm: provider,
      kaos,
      toolset,
      maxStepsPerTurn: 10,
    };

    const sink = new CollectingSink();
    const controller = new AbortController();
    const result = await runTurn('exec it', runtime, sink, controller.signal);

    expect(result.stopReason).toBe('done');
    expect(result.stepCount).toBe(2);

    const toolResults = sink.findByType('tool.result');
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.isError).toBe(false);
    expect(toolResults[0]!.output).toContain('exit=0');
    expect(toolResults[0]!.output).toContain('integration-exec-ok');
  });
});
