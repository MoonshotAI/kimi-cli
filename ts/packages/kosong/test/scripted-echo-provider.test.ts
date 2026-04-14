import { describe, it, expect } from 'vitest';

import { ScriptedEchoChatProvider } from '../src/echo-provider.js';
import { ChatProviderError } from '../src/errors.js';
import type {
  AudioURLPart,
  StreamedMessagePart,
  TextPart,
  ToolCall,
  ToolCallPart,
  VideoURLPart,
} from '../src/message.js';

describe('ScriptedEchoChatProvider', () => {
  it('streams parts from first and second scripts', async () => {
    const dsl = [
      'id: scripted-1',
      'usage: {"input_other": 4, "output": 1, "input_cache_read": 2}',
      'text: Hello,',
      'text:  world!',
      'think: thinking...',
      'image_url: {"url": "https://example.com/image.png", "id": "img-1"}',
      'audio_url: https://example.com/audio.mp3',
      'video_url: https://example.com/video.mp4',
      'tool_call: {"id": "call-1", "name": "search", "arguments": "{\\"q\\":\\"python\\"", "extras": {"source": "test"}}',
      'tool_call_part: {"arguments_part": "}"}',
    ].join('\n');

    const secondDsl = ['id: scripted-2', 'text: second turn'].join('\n');

    const provider = new ScriptedEchoChatProvider([dsl, secondDsl]);

    // First call
    const parts: StreamedMessagePart[] = [];
    const stream = await provider.generate('', [], []);
    for await (const part of stream) {
      parts.push(part);
    }

    expect(stream.id).toBe('scripted-1');
    expect(stream.usage).toEqual({
      inputOther: 4,
      output: 1,
      inputCacheRead: 2,
      inputCacheCreation: 0,
    });
    expect(parts).toEqual([
      { type: 'text', text: 'Hello,' } satisfies TextPart,
      { type: 'text', text: ' world!' } satisfies TextPart,
      { type: 'think', think: 'thinking...' },
      {
        type: 'image_url',
        imageUrl: { url: 'https://example.com/image.png', id: 'img-1' },
      },
      {
        type: 'audio_url',
        audioUrl: { url: 'https://example.com/audio.mp3' },
      } satisfies AudioURLPart,
      {
        type: 'video_url',
        videoUrl: { url: 'https://example.com/video.mp4' },
      } satisfies VideoURLPart,
      {
        type: 'function',
        id: 'call-1',
        function: { name: 'search', arguments: '{"q":"python"' },
      } satisfies ToolCall,
      { type: 'tool_call_part', argumentsPart: '}' } satisfies ToolCallPart,
    ]);

    // Second call
    const secondStream = await provider.generate('', [], []);
    const secondParts: StreamedMessagePart[] = [];
    for await (const part of secondStream) {
      secondParts.push(part);
    }

    expect(secondStream.id).toBe('scripted-2');
    expect(secondStream.usage).toBeNull();
    expect(secondParts).toEqual([{ type: 'text', text: 'second turn' }]);
  });

  it('throws when scripts are exhausted', async () => {
    const provider = new ScriptedEchoChatProvider(['text: only once']);

    await provider.generate('', [], []);

    await expect(provider.generate('', [], [])).rejects.toThrow(ChatProviderError);
  });

  it('rejects non-string arguments in tool_call', async () => {
    const dsl = 'tool_call: {"id": "call-1", "name": "search", "arguments": {"q": "python"}}';
    const provider = new ScriptedEchoChatProvider([dsl]);

    await expect(provider.generate('', [], [])).rejects.toThrow(ChatProviderError);
  });

  it('rejects empty DSL content', async () => {
    const provider = new ScriptedEchoChatProvider(['# comment only\n```']);

    await expect(provider.generate('', [], [])).rejects.toThrow(ChatProviderError);
  });

  it('has correct default properties', () => {
    const provider = new ScriptedEchoChatProvider([]);
    expect(provider.name).toBe('scripted_echo');
    expect(provider.modelName).toBe('scripted_echo');
    expect(provider.thinkingEffort).toBeNull();
  });

  it('withThinking returns a new provider with remaining scripts', async () => {
    const provider = new ScriptedEchoChatProvider(['text: first', 'text: second']);

    // consume first script
    await provider.generate('', [], []);

    const newProvider = provider.withThinking('high');
    expect(newProvider).toBeInstanceOf(ScriptedEchoChatProvider);
    expect(newProvider).not.toBe(provider);

    // new provider should have only the remaining script
    const stream = await newProvider.generate('', [], []);
    const parts: StreamedMessagePart[] = [];
    for await (const part of stream) {
      parts.push(part);
    }
    expect(parts).toEqual([{ type: 'text', text: 'second' }]);
  });

  it('exposes per-script finish_reason values across sequential generate() calls', async () => {
    // Each script carries a different DSL finish_reason and the returned
    // stream must expose the right normalized + raw pair.
    const scripts = [
      ['id: scripted-fr-1', 'text: turn-1', 'finish_reason: stop'].join('\n'),
      ['id: scripted-fr-2', 'text: turn-2', 'finish_reason: length'].join('\n'),
      ['id: scripted-fr-3', 'text: turn-3', 'finish_reason: tool_calls'].join('\n'),
      ['id: scripted-fr-4', 'text: turn-4', 'finish_reason: null'].join('\n'),
      ['id: scripted-fr-5', 'text: turn-5'].join('\n'), // default
    ];
    const provider = new ScriptedEchoChatProvider(scripts);

    const expected: Array<{
      finishReason: 'completed' | 'tool_calls' | 'truncated' | null;
      rawFinishReason: string | null;
    }> = [
      { finishReason: 'completed', rawFinishReason: 'stop' },
      { finishReason: 'truncated', rawFinishReason: 'length' },
      { finishReason: 'tool_calls', rawFinishReason: 'tool_calls' },
      { finishReason: null, rawFinishReason: null },
      { finishReason: 'completed', rawFinishReason: 'stop' },
    ];

    for (const exp of expected) {
      const stream = await provider.generate('', [], []);
      for await (const _ of stream) {
        // drain
      }
      expect({
        finishReason: stream.finishReason,
        rawFinishReason: stream.rawFinishReason,
      }).toEqual(exp);
    }
  });

  it('generate merges tool_call arguments via mergeInPlace', async () => {
    const dsl = [
      'id: scripted-merge-1',
      'tool_call: {"id": "call-1", "name": "search", "arguments": "{\\"q\\":\\"py"}',
      'tool_call_part: {"arguments_part": "thon\\"}"}',
    ].join('\n');

    const provider = new ScriptedEchoChatProvider([dsl]);
    const { generate } = await import('../src/generate.js');

    const result = await generate(provider, '', [], []);

    expect(result.message.toolCalls).toBeDefined();
    expect(result.message.toolCalls).toHaveLength(1);

    const tc = result.message.toolCalls[0]!;
    expect(tc.id).toBe('call-1');
    expect(tc.function.name).toBe('search');
    expect(tc.function.arguments).toBe('{"q":"python"}');
  });
});
