import type { Readable } from 'node:stream';

import { LocalKaos, type Kaos } from '@moonshot-ai/kaos';
import {
  EmptyToolset,
  ScriptedEchoChatProvider,
  SimpleToolset,
  toolOk,
  type Message as KosongMessage,
  type StreamedMessagePart,
  type Tool,
  type ToolReturnValue,
} from '@moonshot-ai/kosong';
import { describe, expect, test } from 'vitest';

import {
  CollectingSink,
  runTurn,
  type ContentDeltaEvent as CoreContentDelta,
  type Runtime,
  type ToolCallEvent as CoreToolCallEvent,
  type TurnResult,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createRuntime(
  provider: ScriptedEchoChatProvider,
  toolset: SimpleToolset | EmptyToolset,
  kaos?: Kaos,
): Runtime {
  return {
    llm: provider,
    kaos: kaos ?? new LocalKaos(),
    toolset,
    maxStepsPerTurn: 10,
  };
}

async function collectStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// ---------------------------------------------------------------------------
// 1. Full Agent Loop (kosong + kaos + kimi-core collaboration)
// ---------------------------------------------------------------------------

describe('Full Agent Loop: kosong + kaos + kimi-core', () => {
  test('tool_call dispatches to real shell command via LocalKaos.exec', async () => {
    const kaos = new LocalKaos();

    // Build a real tool that executes `echo hello-from-kaos` via LocalKaos
    const toolset = new SimpleToolset();
    const shellTool: Tool = {
      name: 'run_command',
      description: 'Execute a shell command',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
        },
        required: ['command'],
      },
    };

    toolset.add(shellTool, async (args): Promise<ToolReturnValue> => {
      const parsed = args as { command: string };
      const proc = await kaos.exec('sh', '-c', parsed.command);
      const stdout = await collectStream(proc.stdout);
      await proc.wait();
      return toolOk({ output: stdout.trim() });
    });

    // Script: LLM returns a tool_call, then a text response
    const provider = new ScriptedEchoChatProvider([
      // Step 1: LLM requests tool_call
      `tool_call: {"id": "tc_001", "name": "run_command", "arguments": "{\\"command\\": \\"echo hello-from-kaos\\"}"}`,
      // Step 2: LLM returns final text
      `text: command executed successfully`,
    ]);

    const sink = new CollectingSink();
    const controller = new AbortController();
    const runtime = createRuntime(provider, toolset, kaos);

    const result = await runTurn('run echo', runtime, sink, controller.signal);

    // Verify turn completed
    expect(result.stopReason).toBe('done');
    expect(result.stepCount).toBe(2);

    // Verify tool.call event
    const toolCalls = sink.findByType('tool.call');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.toolCall.function.name).toBe('run_command');

    // Verify tool.result event contains real command output
    const toolResults = sink.findByType('tool.result');
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.output).toBe('hello-from-kaos');
    expect(toolResults[0]?.isError).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Multi-step Agent Loop (runTurn with ScriptedEchoChatProvider)
// ---------------------------------------------------------------------------

describe('Multi-step Agent Loop via runTurn', () => {
  test('two-step turn: tool_call then text, with full event sequence', async () => {
    const toolset = new SimpleToolset();
    const echoTool: Tool = {
      name: 'echo_tool',
      description: 'Echo back a message',
      parameters: {
        type: 'object',
        properties: { msg: { type: 'string' } },
      },
    };

    toolset.add(echoTool, async (args): Promise<ToolReturnValue> => {
      const parsed = args as { msg: string };
      return toolOk({ output: `echoed: ${parsed.msg}` });
    });

    const provider = new ScriptedEchoChatProvider([
      // Step 1: LLM calls echo_tool
      `tool_call: {"id": "tc_100", "name": "echo_tool", "arguments": "{\\"msg\\": \\"world\\"}"}`,
      // Step 2: LLM returns text based on tool result
      `text: The tool said echoed: world`,
    ]);

    const sink = new CollectingSink();
    const controller = new AbortController();
    const runtime = createRuntime(provider, toolset);

    const result = await runTurn('say hello', runtime, sink, controller.signal);

    // Verify 2 steps
    expect(result.stopReason).toBe('done');
    expect(result.stepCount).toBe(2);

    // Verify full event sequence:
    // step.begin -> tool.call -> tool.result -> step.end -> step.begin -> content.delta -> step.end
    const eventTypes = sink.events.map((e) => e.type);
    expect(eventTypes).toEqual([
      'step.begin', // Step 0 begins
      'tool.call', // LLM requests tool
      'tool.result', // Tool responds
      'step.end', // Step 0 ends
      'step.begin', // Step 1 begins
      'content.delta', // LLM returns text
      'step.end', // Step 1 ends
    ]);

    // Verify event details
    const stepBegins = sink.findByType('step.begin');
    expect(stepBegins).toHaveLength(2);
    expect(stepBegins[0]?.stepNumber).toBe(0);
    expect(stepBegins[1]?.stepNumber).toBe(1);

    const toolCallEvents = sink.findByType('tool.call');
    expect(toolCallEvents[0]?.toolCall.function.name).toBe('echo_tool');

    const toolResultEvents = sink.findByType('tool.result');
    expect(toolResultEvents[0]?.output).toBe('echoed: world');
    expect(toolResultEvents[0]?.isError).toBe(false);

    const contentDeltas = sink.findByType('content.delta');
    expect(contentDeltas).toHaveLength(1);
    expect(contentDeltas[0]?.part.type).toBe('text');
  });
});

// ---------------------------------------------------------------------------
// 3. Abort cancellation test
// ---------------------------------------------------------------------------

describe('Abort cancellation', () => {
  test('pre-aborted signal yields cancelled immediately', async () => {
    const provider = new ScriptedEchoChatProvider([`text: this should not appear`]);

    const sink = new CollectingSink();
    const controller = new AbortController();
    controller.abort(); // abort before starting

    const runtime = createRuntime(provider, new SimpleToolset());

    const result = await runTurn('hi', runtime, sink, controller.signal);

    expect(result.stopReason).toBe('cancelled');
    expect(result.stepCount).toBe(0);

    // No events should have been emitted
    expect(sink.events).toHaveLength(0);
  });

  test('abort after first step prevents second step', async () => {
    const toolset = new SimpleToolset();
    const delayTool: Tool = {
      name: 'noop',
      description: 'No-op tool',
      parameters: { type: 'object', properties: {} },
    };

    toolset.add(delayTool, async (): Promise<ToolReturnValue> => {
      return toolOk({ output: 'done' });
    });

    const provider = new ScriptedEchoChatProvider([
      // Step 1: tool call
      `tool_call: {"id": "tc_abort", "name": "noop", "arguments": "{}"}`,
      // Step 2: this should never execute
      `text: should not reach here`,
    ]);

    const sink = new CollectingSink();
    const controller = new AbortController();
    const runtime = createRuntime(provider, toolset);

    // We abort after the first step completes by watching for step.end
    const originalEmit = sink.emit.bind(sink);
    let stepEndCount = 0;
    sink.emit = (event) => {
      originalEmit(event);
      if (event.type === 'step.end') {
        stepEndCount++;
        if (stepEndCount === 1) {
          controller.abort();
        }
      }
    };

    const result = await runTurn('do something', runtime, sink, controller.signal);

    expect(result.stopReason).toBe('cancelled');
    expect(result.stepCount).toBe(1);

    // Verify no dangling promises: the turn completed without hanging
    // (The fact that we reached here without timeout proves no dangling promises)
  });
});

// ---------------------------------------------------------------------------
// 3b. Usage accumulation across multi-step turns (regression)
// ---------------------------------------------------------------------------

describe('Usage accumulation (runTurn multi-step)', () => {
  test('TurnResult.usage is the sum of per-step usage (not just the last step)', async () => {
    const toolset = new SimpleToolset();
    const noopTool: Tool = {
      name: 'noop',
      description: 'No-op',
      parameters: { type: 'object', properties: {} },
    };
    toolset.add(noopTool, async (): Promise<ToolReturnValue> => toolOk({ output: 'ok' }));

    // Two-script provider: step 1 emits a tool_call with its own usage;
    // step 2 emits plain text with a different usage. runTurn must sum them.
    const provider = new ScriptedEchoChatProvider([
      [
        'usage: {"input_other": 100, "output": 20, "input_cache_read": 5, "input_cache_creation": 1}',
        'tool_call: {"id": "tc_sum_1", "name": "noop", "arguments": "{}"}',
      ].join('\n'),
      [
        'usage: {"input_other": 200, "output": 40, "input_cache_read": 10, "input_cache_creation": 2}',
        'text: done',
      ].join('\n'),
    ]);

    const sink = new CollectingSink();
    const controller = new AbortController();
    const runtime = createRuntime(provider, toolset);

    const result: TurnResult = await runTurn('go', runtime, sink, controller.signal);

    expect(result.stopReason).toBe('done');
    expect(result.stepCount).toBe(2);

    // usage must be the elementwise sum of both step usages.
    expect(result.usage).toEqual({
      inputOther: 300,
      output: 60,
      inputCacheRead: 15,
      inputCacheCreation: 3,
    });
  });

  test('TurnResult.usage is null when no step reported usage', async () => {
    const provider = new ScriptedEchoChatProvider([`text: hello`]);
    const sink = new CollectingSink();
    const controller = new AbortController();
    const runtime = createRuntime(provider, new SimpleToolset());

    const result = await runTurn('hi', runtime, sink, controller.signal);
    expect(result.stopReason).toBe('done');
    expect(result.usage).toBeNull();
  });

  test('TurnResult.usage accumulates across 3 steps (2 tool_calls then text)', async () => {
    const toolset = new SimpleToolset();
    const noopTool: Tool = {
      name: 'noop',
      description: 'No-op',
      parameters: { type: 'object', properties: {} },
    };
    toolset.add(noopTool, async (): Promise<ToolReturnValue> => toolOk({ output: 'ok' }));

    const provider = new ScriptedEchoChatProvider([
      [
        'usage: {"input_other": 10, "output": 1, "input_cache_read": 0, "input_cache_creation": 0}',
        'tool_call: {"id": "tc_a", "name": "noop", "arguments": "{}"}',
      ].join('\n'),
      [
        'usage: {"input_other": 20, "output": 2, "input_cache_read": 0, "input_cache_creation": 0}',
        'tool_call: {"id": "tc_b", "name": "noop", "arguments": "{}"}',
      ].join('\n'),
      [
        'usage: {"input_other": 30, "output": 3, "input_cache_read": 0, "input_cache_creation": 0}',
        'text: final',
      ].join('\n'),
    ]);

    const sink = new CollectingSink();
    const controller = new AbortController();
    const runtime = createRuntime(provider, toolset);

    const result = await runTurn('go', runtime, sink, controller.signal);

    expect(result.stopReason).toBe('done');
    expect(result.stepCount).toBe(3);
    expect(result.usage).toEqual({
      inputOther: 60,
      output: 6,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Empty Toolset test
// ---------------------------------------------------------------------------

describe('Empty Toolset: tool_call with no tools', () => {
  test('tool_call returns toolNotFoundError', async () => {
    const provider = new ScriptedEchoChatProvider([
      `tool_call: {"id": "tc_empty", "name": "nonexistent_tool", "arguments": "{}"}`,
      // After getting error, LLM responds with text
      `text: tool was not found`,
    ]);

    const sink = new CollectingSink();
    const controller = new AbortController();
    const runtime = createRuntime(provider, new EmptyToolset());

    const result = await runTurn('call tool', runtime, sink, controller.signal);

    expect(result.stopReason).toBe('done');
    expect(result.stepCount).toBe(2);

    // Verify tool.result shows error
    const toolResults = sink.findByType('tool.result');
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.isError).toBe(true);
    // `toolNotFoundError` factory (matching Python) sets `output: ""` by
    // design — the error text lives in `message`, not in the wire payload
    // the LLM sees. Asserting only the error flag here is the right contract
    // for the wire event; the text is covered by tool-errors.ts unit tests.
    expect(toolResults[0]?.output).toEqual('');
  });
});

// ---------------------------------------------------------------------------
// 5. Cross-package type consistency
// ---------------------------------------------------------------------------

describe('Cross-package type consistency', () => {
  test('Message type from kosong and re-exported from core are compatible', () => {
    // kimi-core does not re-export Message directly, but Runtime uses kosong types.
    // The key test is: a kosong Message can be used where kosong Message is expected
    // through the kimi-core pipeline.
    const msg: KosongMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
      toolCalls: [],
    };

    // Verify the message conforms to the Message interface
    expect(msg.role).toBe('user');
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0]?.type).toBe('text');
  });

  test('StreamedMessagePart discriminated union narrows correctly across packages', () => {
    // This test verifies that the discriminated union type from kosong
    // works correctly for type narrowing when consumed by downstream packages.
    const parts: StreamedMessagePart[] = [
      { type: 'text', text: 'hello' },
      { type: 'think', think: 'reasoning...' },
      { type: 'function', id: 'tc_1', function: { name: 'tool', arguments: '{}' } },
      { type: 'tool_call_part', argumentsPart: '{"key":' },
    ];

    // Narrow to text
    const textParts = parts.filter(
      (p): p is Extract<StreamedMessagePart, { type: 'text' }> => p.type === 'text',
    );
    expect(textParts).toHaveLength(1);
    expect(textParts[0]?.text).toBe('hello');

    // Narrow to think
    const thinkParts = parts.filter(
      (p): p is Extract<StreamedMessagePart, { type: 'think' }> => p.type === 'think',
    );
    expect(thinkParts).toHaveLength(1);
    expect(thinkParts[0]?.think).toBe('reasoning...');

    // Narrow to function (ToolCall)
    const toolCalls = parts.filter(
      (p): p is Extract<StreamedMessagePart, { type: 'function' }> => p.type === 'function',
    );
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.function.name).toBe('tool');

    // Narrow to tool_call_part
    const toolCallParts = parts.filter(
      (p): p is Extract<StreamedMessagePart, { type: 'tool_call_part' }> =>
        p.type === 'tool_call_part',
    );
    expect(toolCallParts).toHaveLength(1);
    expect(toolCallParts[0]?.argumentsPart).toBe('{"key":');
  });

  test('WireEvent types from kimi-core use kosong types transitively', () => {
    // WireEvent's ContentDeltaEvent uses ContentPart from kosong
    // WireEvent's ToolCallEvent uses ToolCall from kosong
    // This test ensures the transitive type dependency works.
    const delta: CoreContentDelta = {
      type: 'content.delta',
      part: { type: 'text', text: 'test' },
    };

    const toolEvent: CoreToolCallEvent = {
      type: 'tool.call',
      toolCall: {
        type: 'function',
        id: 'tc_type',
        function: { name: 'test', arguments: null },
      },
    };

    expect(delta.part.type).toBe('text');
    expect(toolEvent.toolCall.type).toBe('function');
  });
});
