import { describe, it, expect } from 'vitest';

import { EchoChatProvider } from '../src/echo-provider.js';
import { ChatProviderError } from '../src/errors.js';
import {
  createUserMessage,
  type AudioURLPart,
  type ImageURLPart,
  type Message,
  type StreamedMessagePart,
  type TextPart,
  type ThinkPart,
  type ToolCall,
  type ToolCallPart,
  type VideoURLPart,
} from '../src/message.js';

function userMsg(text: string): Message {
  return createUserMessage(text);
}

describe('EchoChatProvider', () => {
  it('streams parts from DSL', async () => {
    const dsl = [
      'id: echo-42',
      'usage: {"input_other": 10, "output": 2, "input_cache_read": 3}',
      'text: Hello,',
      'text:  world!',
      'think: thinking...',
      'image_url: {"url": "https://example.com/image.png", "id": "img-1"}',
      'audio_url: https://example.com/audio.mp3',
      'video_url: https://example.com/video.mp4',
      'tool_call: {"id": "call-1", "name": "search", "arguments": "{\\"q\\":\\"python\\"", "extras": {"source": "test"}}',
      'tool_call_part: {"arguments_part": "}"}',
    ].join('\n');

    const provider = new EchoChatProvider();
    const history: Message[] = [userMsg(dsl)];

    const parts: StreamedMessagePart[] = [];
    const stream = await provider.generate('', [], history);
    for await (const part of stream) {
      parts.push(part);
    }

    expect(stream.id).toBe('echo-42');
    expect(stream.usage).toEqual({
      inputOther: 10,
      output: 2,
      inputCacheRead: 3,
      inputCacheCreation: 0,
    });

    expect(parts).toEqual([
      { type: 'text', text: 'Hello,' } satisfies TextPart,
      { type: 'text', text: ' world!' } satisfies TextPart,
      { type: 'think', think: 'thinking...' } satisfies ThinkPart,
      {
        type: 'image_url',
        imageUrl: { url: 'https://example.com/image.png', id: 'img-1' },
      } satisfies ImageURLPart,
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
  });

  it('rejects non-string arguments in tool_call', async () => {
    const dsl = 'tool_call: {"id": "call-1", "name": "search", "arguments": {"q": "python"}}';
    const provider = new EchoChatProvider();

    await expect(provider.generate('', [], [userMsg(dsl)])).rejects.toThrow(ChatProviderError);
  });

  it('requires last history message to be user', async () => {
    const provider = new EchoChatProvider();
    const history: Message[] = [
      {
        role: 'tool',
        content: [{ type: 'text', text: 'tool output' }],
        toolCallId: 'tc-1',
        toolCalls: [],
      },
    ];

    await expect(provider.generate('', [], history)).rejects.toThrow(ChatProviderError);
  });

  it('requires DSL content (not empty)', async () => {
    const provider = new EchoChatProvider();
    const history: Message[] = [userMsg('')];

    await expect(provider.generate('', [], history)).rejects.toThrow(ChatProviderError);
  });

  it('requires at least one message in history', async () => {
    const provider = new EchoChatProvider();

    await expect(provider.generate('', [], [])).rejects.toThrow(ChatProviderError);
  });

  it('handles comments and blank lines', async () => {
    const dsl = ['# this is a comment', '', 'text: Hello', '# another comment'].join('\n');

    const provider = new EchoChatProvider();
    const parts: StreamedMessagePart[] = [];
    const stream = await provider.generate('', [], [userMsg(dsl)]);
    for await (const part of stream) {
      parts.push(part);
    }

    expect(parts).toEqual([{ type: 'text', text: 'Hello' }]);
  });

  it('handles think_encrypted DSL', async () => {
    const dsl = 'think_encrypted: some_signature';
    const provider = new EchoChatProvider();
    const parts: StreamedMessagePart[] = [];
    const stream = await provider.generate('', [], [userMsg(dsl)]);
    for await (const part of stream) {
      parts.push(part);
    }

    expect(parts).toEqual([
      { type: 'think', think: '', encrypted: 'some_signature' } satisfies ThinkPart,
    ]);
  });

  it('withThinking returns a new EchoChatProvider', () => {
    const provider = new EchoChatProvider();
    const newProvider = provider.withThinking('high');
    expect(newProvider).toBeInstanceOf(EchoChatProvider);
    expect(newProvider).not.toBe(provider);
  });

  it('throws on a DSL line without a colon separator', async () => {
    const provider = new EchoChatProvider();
    await expect(provider.generate('', [], [userMsg('this line has no colon')])).rejects.toThrow(
      /Invalid echo DSL/,
    );
  });

  it('throws on an unknown DSL kind', async () => {
    const provider = new EchoChatProvider();
    await expect(
      provider.generate('', [], [userMsg('mystery_kind: some payload')]),
    ).rejects.toThrow(/Unknown echo DSL kind/);
  });

  it('skips markdown fence lines and bare echo keyword', async () => {
    const dsl = ['```', 'echo', 'text: actual content', '```'].join('\n');
    const provider = new EchoChatProvider();
    const stream = await provider.generate('', [], [userMsg(dsl)]);
    const parts: StreamedMessagePart[] = [];
    for await (const part of stream) parts.push(part);
    expect(parts).toEqual([{ type: 'text', text: 'actual content' }]);
  });

  it('parseUsage throws for non-integer field', async () => {
    const provider = new EchoChatProvider();
    const dsl = 'usage: {"output": "not_a_number"}';
    await expect(provider.generate('', [], [userMsg(dsl)])).rejects.toThrow(
      /Usage field 'output' must be an integer/,
    );
  });

  it('parseToolCall throws when id is missing', async () => {
    const provider = new EchoChatProvider();
    const dsl = 'tool_call: {"name": "search", "arguments": "{}"}';
    await expect(provider.generate('', [], [userMsg(dsl)])).rejects.toThrow(
      /tool_call requires string id and name/,
    );
  });

  it('parseToolCall throws when name is missing', async () => {
    const provider = new EchoChatProvider();
    const dsl = 'tool_call: {"id": "call-1", "arguments": "{}"}';
    await expect(provider.generate('', [], [userMsg(dsl)])).rejects.toThrow(
      /tool_call requires string id and name/,
    );
  });

  it('image_url DSL accepts a bare URL string (no id)', async () => {
    const provider = new EchoChatProvider();
    const dsl = 'image_url: https://example.com/img.png';
    const stream = await provider.generate('', [], [userMsg(dsl)]);
    const parts: StreamedMessagePart[] = [];
    for await (const part of stream) parts.push(part);
    expect(parts).toEqual([
      {
        type: 'image_url',
        imageUrl: { url: 'https://example.com/img.png' },
      } satisfies ImageURLPart,
    ]);
  });

  it('parseMapping falls back to key=value form when payload is not JSON', async () => {
    const provider = new EchoChatProvider();
    // usage payload as space-separated key=value form (requires at least one part too)
    const dsl = ['usage: input_other=10 output=2', 'text: hi'].join('\n');
    const stream = await provider.generate('', [], [userMsg(dsl)]);
    for await (const _ of stream) {
      /* drain */
    }
    expect(stream.usage).toEqual({
      inputOther: 10,
      output: 2,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
  });

  describe('finish_reason DSL', () => {
    it('defaults to completed/stop when finish_reason line is omitted', async () => {
      const provider = new EchoChatProvider();
      const stream = await provider.generate('', [], [userMsg('text: hi')]);
      for await (const _ of stream) {
        // drain
      }
      expect(stream.finishReason).toBe('completed');
      expect(stream.rawFinishReason).toBe('stop');
    });

    it('maps finish_reason: stop to completed/stop', async () => {
      const provider = new EchoChatProvider();
      const dsl = ['text: hi', 'finish_reason: stop'].join('\n');
      const stream = await provider.generate('', [], [userMsg(dsl)]);
      for await (const _ of stream) {
        // drain
      }
      expect(stream.finishReason).toBe('completed');
      expect(stream.rawFinishReason).toBe('stop');
    });

    it('maps finish_reason: length to truncated/length', async () => {
      const provider = new EchoChatProvider();
      const dsl = ['text: hi', 'finish_reason: length'].join('\n');
      const stream = await provider.generate('', [], [userMsg(dsl)]);
      for await (const _ of stream) {
        // drain
      }
      expect(stream.finishReason).toBe('truncated');
      expect(stream.rawFinishReason).toBe('length');
    });

    it('maps finish_reason: tool_calls to tool_calls/tool_calls', async () => {
      const provider = new EchoChatProvider();
      const dsl = ['text: hi', 'finish_reason: tool_calls'].join('\n');
      const stream = await provider.generate('', [], [userMsg(dsl)]);
      for await (const _ of stream) {
        // drain
      }
      expect(stream.finishReason).toBe('tool_calls');
      expect(stream.rawFinishReason).toBe('tool_calls');
    });

    it('maps finish_reason: content_filter to filtered/content_filter', async () => {
      const provider = new EchoChatProvider();
      const dsl = ['text: hi', 'finish_reason: content_filter'].join('\n');
      const stream = await provider.generate('', [], [userMsg(dsl)]);
      for await (const _ of stream) {
        // drain
      }
      expect(stream.finishReason).toBe('filtered');
      expect(stream.rawFinishReason).toBe('content_filter');
    });

    it('maps unknown finish_reason string to other and preserves raw', async () => {
      const provider = new EchoChatProvider();
      const dsl = ['text: hi', 'finish_reason: something_weird'].join('\n');
      const stream = await provider.generate('', [], [userMsg(dsl)]);
      for await (const _ of stream) {
        // drain
      }
      expect(stream.finishReason).toBe('other');
      expect(stream.rawFinishReason).toBe('something_weird');
    });

    it('maps finish_reason: null to {null, null}', async () => {
      const provider = new EchoChatProvider();
      const dsl = ['text: hi', 'finish_reason: null'].join('\n');
      const stream = await provider.generate('', [], [userMsg(dsl)]);
      for await (const _ of stream) {
        // drain
      }
      expect(stream.finishReason).toBeNull();
      expect(stream.rawFinishReason).toBeNull();
    });

    it('maps finish_reason: none to {null, null}', async () => {
      const provider = new EchoChatProvider();
      const dsl = ['text: hi', 'finish_reason: none'].join('\n');
      const stream = await provider.generate('', [], [userMsg(dsl)]);
      for await (const _ of stream) {
        // drain
      }
      expect(stream.finishReason).toBeNull();
      expect(stream.rawFinishReason).toBeNull();
    });

    it('maps empty finish_reason payload to {null, null}', async () => {
      const provider = new EchoChatProvider();
      const dsl = ['text: hi', 'finish_reason: '].join('\n');
      const stream = await provider.generate('', [], [userMsg(dsl)]);
      for await (const _ of stream) {
        // drain
      }
      expect(stream.finishReason).toBeNull();
      expect(stream.rawFinishReason).toBeNull();
    });

    it('strips quotes around finish_reason payloads', async () => {
      const provider = new EchoChatProvider();
      const dsl = ['text: hi', 'finish_reason: "length"'].join('\n');
      const stream = await provider.generate('', [], [userMsg(dsl)]);
      for await (const _ of stream) {
        // drain
      }
      expect(stream.finishReason).toBe('truncated');
      expect(stream.rawFinishReason).toBe('length');
    });
  });

  it('generate merges tool_call arguments via mergeInPlace', async () => {
    const dsl = [
      'id: echo-merge-1',
      'tool_call: {"id": "call-1", "name": "search", "arguments": "{\\"q\\":\\"py"}',
      'tool_call_part: {"arguments_part": "thon\\"}"}',
    ].join('\n');

    const provider = new EchoChatProvider();
    const { generate } = await import('../src/generate.js');

    const result = await generate(provider, '', [], [userMsg(dsl)]);

    expect(result.message.toolCalls).toBeDefined();
    expect(result.message.toolCalls).toHaveLength(1);

    const tc = result.message.toolCalls[0]!;
    expect(tc.id).toBe('call-1');
    expect(tc.function.name).toBe('search');
    expect(tc.function.arguments).toBe('{"q":"python"}');
  });
});
