import type { Kaos } from '@moonshot-ai/kaos';
import type {
  ChatProvider,
  ContentPart,
  StreamedMessage,
  StreamedMessagePart,
  Tool,
  Toolset,
} from '@moonshot-ai/kosong';
import { describe, expect, test, vi } from 'vitest';

import { CollectingSink, runTurn } from '../src/index.js';
import type { Runtime } from '../src/index.js';

function createMockStream(parts: StreamedMessagePart[]): StreamedMessage {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<StreamedMessagePart> {
      for (const p of parts) {
        yield p;
      }
    },
    id: 'msg_001',
    usage: { inputOther: 10, output: 20, inputCacheRead: 0, inputCacheCreation: 0 },
  };
}

function createMockProvider(parts: StreamedMessagePart[]): ChatProvider {
  return {
    name: 'mock',
    modelName: 'mock-v1',
    thinkingEffort: null,
    generate: vi.fn().mockResolvedValue(createMockStream(parts)),
    withThinking(_effort) {
      return this;
    },
  };
}

function createMockToolset(): Toolset {
  return {
    tools: [] as Tool[],
    handle: vi.fn().mockResolvedValue({
      toolCallId: 'tc_001',
      returnValue: { isError: false, output: 'tool output', message: '' },
    }),
  };
}

function createMockRuntime(provider: ChatProvider): Runtime {
  return {
    llm: provider,
    kaos: { name: 'mock' } as unknown as Kaos,
    toolset: createMockToolset(),
    maxStepsPerTurn: 10,
  };
}

describe('runTurn', () => {
  test('completes a simple text turn', async () => {
    const provider = createMockProvider([{ type: 'text', text: 'Hello world' }]);
    const sink = new CollectingSink();
    const controller = new AbortController();
    const runtime = createMockRuntime(provider);

    const result = await runTurn('hi', runtime, sink, controller.signal);

    expect(result.stopReason).toBe('done');
    expect(result.stepCount).toBe(1);

    const stepBegins = sink.findByType('step.begin');
    expect(stepBegins).toHaveLength(1);
    expect(stepBegins[0]?.stepNumber).toBe(0);

    const deltas = sink.findByType('content.delta');
    expect(deltas).toHaveLength(1);

    const stepEnds = sink.findByType('step.end');
    expect(stepEnds).toHaveLength(1);
  });

  test('respects abort signal', async () => {
    const provider = createMockProvider([]);
    const sink = new CollectingSink();
    const controller = new AbortController();
    controller.abort();
    const runtime = createMockRuntime(provider);

    const result = await runTurn('hi', runtime, sink, controller.signal);

    expect(result.stopReason).toBe('cancelled');
  });

  test('handles tool calls and continues loop', async () => {
    const stream1 = createMockStream([
      { type: 'function', id: 'tc_001', function: { name: 'readFile', arguments: '{}' } },
    ]);
    const stream2 = createMockStream([{ type: 'text', text: 'Done' }]);

    const provider: ChatProvider = {
      name: 'mock',
      modelName: 'mock-v1',
      thinkingEffort: null,
      generate: vi.fn().mockResolvedValueOnce(stream1).mockResolvedValueOnce(stream2),
      withThinking(_effort) {
        return this;
      },
    };
    const sink = new CollectingSink();
    const controller = new AbortController();
    const runtime = createMockRuntime(provider);

    const result = await runTurn('read a file', runtime, sink, controller.signal);

    expect(result.stopReason).toBe('done');
    expect(result.stepCount).toBe(2);

    const toolCalls = sink.findByType('tool.call');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.toolCall.function.name).toBe('readFile');

    const toolResults = sink.findByType('tool.result');
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.output).toBe('tool output');
  });

  test('emits all content part types, not just text', async () => {
    const provider = createMockProvider([
      { type: 'think', think: 'reasoning about the answer' },
      { type: 'text', text: 'Hello' },
      { type: 'image_url', imageUrl: { url: 'https://example.com/img.png' } },
      { type: 'audio_url', audioUrl: { url: 'https://example.com/a.mp3' } },
      { type: 'video_url', videoUrl: { url: 'https://example.com/v.mp4' } },
    ]);
    const sink = new CollectingSink();
    const controller = new AbortController();
    const runtime = createMockRuntime(provider);

    const result = await runTurn('test', runtime, sink, controller.signal);

    expect(result.stopReason).toBe('done');

    const deltas = sink.findByType('content.delta');
    expect(deltas).toHaveLength(5);
    expect(deltas[0]?.part.type).toBe('think');
    expect(deltas[1]?.part.type).toBe('text');
    expect(deltas[2]?.part.type).toBe('image_url');
    expect(deltas[3]?.part.type).toBe('audio_url');
    expect(deltas[4]?.part.type).toBe('video_url');
  });

  test('forwards multimodal tool result verbatim via tool.result event', async () => {
    const stream1 = createMockStream([
      { type: 'function', id: 'tc_img', function: { name: 'get_image', arguments: '{}' } },
    ]);
    const stream2 = createMockStream([{ type: 'text', text: 'ok' }]);

    const provider: ChatProvider = {
      name: 'mock',
      modelName: 'mock-v1',
      thinkingEffort: null,
      generate: vi.fn().mockResolvedValueOnce(stream1).mockResolvedValueOnce(stream2),
      withThinking(_effort) {
        return this;
      },
    };

    const multimodalOutput: ContentPart[] = [
      { type: 'image_url', imageUrl: { url: 'https://example.com/img.png' } },
    ];

    // Custom toolset whose handler returns a ContentPart[] output — the
    // case that stringifyOutput used to silently flatten into `""`.
    const toolset: Toolset = {
      tools: [] as Tool[],
      handle: vi.fn().mockResolvedValue({
        toolCallId: 'tc_img',
        returnValue: {
          isError: false,
          output: multimodalOutput,
          message: '',
          display: [],
        },
      }),
    };

    const runtime: Runtime = {
      llm: provider,
      kaos: { name: 'mock' } as unknown as Kaos,
      toolset,
      maxStepsPerTurn: 10,
    };

    const sink = new CollectingSink();
    const controller = new AbortController();

    const result = await runTurn('get an image', runtime, sink, controller.signal);
    expect(result.stopReason).toBe('done');

    const toolResults = sink.findByType('tool.result');
    expect(toolResults).toHaveLength(1);
    // Crucially: the output is the original ContentPart[] — NOT a stringified
    // empty value, which was the bug reported by Codex Round 11.
    expect(Array.isArray(toolResults[0]?.output)).toBe(true);
    expect(toolResults[0]?.output).toEqual(multimodalOutput);
    expect(toolResults[0]?.isError).toBe(false);
  });

  test('CollectingSink.findByType filters correctly', () => {
    const sink = new CollectingSink();
    sink.emit({ type: 'step.begin', stepNumber: 0 });
    sink.emit({ type: 'content.delta', part: { type: 'text', text: 'a' } });
    sink.emit({ type: 'content.delta', part: { type: 'text', text: 'b' } });
    sink.emit({ type: 'step.end' });

    expect(sink.findByType('content.delta')).toHaveLength(2);
    expect(sink.findByType('step.begin')).toHaveLength(1);
    expect(sink.findByType('turn.end')).toHaveLength(0);
  });
});
