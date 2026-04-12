import { describe, it, expect } from 'vitest';

import { EchoChatProvider } from '../src/echo-provider.js';
import { ChatProviderError } from '../src/errors.js';
import type {
  StreamedMessagePart,
  TextPart,
  ThinkPart,
  ImageURLPart,
  ToolCall,
  ToolCallPart,
} from '../src/message.js';
import { createUserMessage } from '../src/message.js';
import type { Message } from '../src/message.js';

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

    const tc = result.message.toolCalls![0]!;
    expect(tc.id).toBe('call-1');
    expect(tc.function.name).toBe('search');
    expect(tc.function.arguments).toBe('{"q":"python"}');
  });
});
