import { describe, expect, it } from 'vitest';

import { ScriptedEchoChatProvider } from '../../src/echo-provider.js';
import { extractText } from '../../src/message.js';
import type { Message, StreamedMessagePart, ToolCall } from '../../src/message.js';
import type { ChatProvider, StreamedMessage, ThinkingEffort } from '../../src/provider.js';
import { SimpleToolset } from '../../src/simple-toolset.js';
import { step } from '../../src/step.js';
import type { JsonType, Tool, ToolReturnValue } from '../../src/tool.js';
import { toolOk } from '../../src/tool.js';
import type { TokenUsage } from '../../src/usage.js';

// ── Mock helpers ──────────────────────────────────────────────────────

function createMockStream(
  parts: StreamedMessagePart[],
  opts?: { id?: string; usage?: TokenUsage },
): StreamedMessage {
  return {
    get id(): string | null {
      return opts?.id ?? null;
    },
    get usage(): TokenUsage | null {
      return opts?.usage ?? null;
    },
    finishReason: null,
    rawFinishReason: null,
    async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
      for (const part of parts) {
        yield part;
      }
    },
  };
}

/**
 * A provider that consumes a queue of StreamedMessage instances,
 * one per generate() call. More flexible than ScriptedEchoChatProvider
 * when we need programmatic ToolCall objects with specific argument strings.
 */
class QueuedMockProvider implements ChatProvider {
  readonly name: string = 'queued-mock';
  readonly modelName: string = 'queued-mock';
  readonly thinkingEffort: ThinkingEffort | null = null;
  private readonly _queue: StreamedMessage[];
  private _cursor: number = 0;

  constructor(queue: StreamedMessage[]) {
    this._queue = queue;
  }

  async generate(
    _systemPrompt: string,
    _tools: Tool[],
    _history: Message[],
  ): Promise<StreamedMessage> {
    const stream = this._queue[this._cursor];
    if (stream === undefined) {
      throw new Error(`QueuedMockProvider exhausted at turn ${this._cursor + 1}.`);
    }
    this._cursor++;
    return stream;
  }

  withThinking(_effort: ThinkingEffort): ChatProvider {
    return this;
  }
}

/**
 * Simulate a full agent loop: call step() repeatedly until there are
 * no more tool calls, appending assistant + tool messages to history.
 */
async function runAgentLoop(
  provider: ChatProvider,
  toolset: SimpleToolset,
  systemPrompt: string = '',
  initialHistory: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'go' }], toolCalls: [] },
  ],
): Promise<{ messages: Message[]; turns: number }> {
  const history: Message[] = [...initialHistory];
  let turns = 0;
  const maxTurns = 10;

  while (turns < maxTurns) {
    turns++;
    const result = await step(provider, systemPrompt, toolset, history);
    history.push(result.message);

    if (result.toolCalls.length === 0) {
      break;
    }

    const toolResults = await result.toolResults();
    for (const tr of toolResults) {
      history.push({
        role: 'tool',
        content: [
          {
            type: 'text',
            text: typeof tr.returnValue.output === 'string' ? tr.returnValue.output : '',
          },
        ],
        toolCallId: tr.toolCallId,
        toolCalls: [],
      });
    }
  }

  return { messages: history, turns };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('e2e: multi-step agent loop', () => {
  it('2-step loop: tool_call → result → final text', async () => {
    const toolCall: ToolCall = {
      type: 'function',
      id: 'tc-1',
      function: { name: 'search', arguments: '{"query":"vitest"}' },
    };

    const provider = new QueuedMockProvider([
      // Turn 1: LLM returns a tool call
      createMockStream([toolCall]),
      // Turn 2: LLM returns final text
      createMockStream([{ type: 'text', text: 'Found results for vitest.' }]),
    ]);

    const toolset = new SimpleToolset();
    toolset.add(
      { name: 'search', description: 'Search the web', parameters: {} },
      async (args: JsonType): Promise<ToolReturnValue> => {
        const obj = args as Record<string, JsonType>;
        return toolOk({ output: `results for ${obj['query'] as string}` });
      },
    );

    const { messages, turns } = await runAgentLoop(provider, toolset);

    expect(turns).toBe(2);
    // History: user → assistant(tool_call) → tool → assistant(text)
    expect(messages).toHaveLength(4);
    expect(messages[1]!.role).toBe('assistant');
    expect(messages[1]!.toolCalls).toHaveLength(1);
    expect(messages[2]!.role).toBe('tool');
    expect(messages[3]!.role).toBe('assistant');
    expect(extractText(messages[3]!)).toBe('Found results for vitest.');
  });

  it('3-step loop: tool A → tool B → final text', async () => {
    const tcSearch: ToolCall = {
      type: 'function',
      id: 'tc-search',
      function: { name: 'search', arguments: '{"query":"vitest"}' },
    };
    const tcRead: ToolCall = {
      type: 'function',
      id: 'tc-read',
      function: { name: 'read_file', arguments: '{"path":"/docs/vitest.md"}' },
    };

    const provider = new QueuedMockProvider([
      createMockStream([{ type: 'text', text: 'Let me search first.' }, tcSearch]),
      createMockStream([{ type: 'text', text: 'Found a doc, reading it.' }, tcRead]),
      createMockStream([{ type: 'text', text: 'The answer is: use vitest.' }]),
    ]);

    const toolset = new SimpleToolset();
    toolset.add(
      { name: 'search', description: 'Search', parameters: {} },
      async (): Promise<ToolReturnValue> => toolOk({ output: '/docs/vitest.md' }),
    );
    toolset.add(
      { name: 'read_file', description: 'Read file', parameters: {} },
      async (): Promise<ToolReturnValue> => toolOk({ output: 'vitest is a test runner' }),
    );

    const { messages, turns } = await runAgentLoop(provider, toolset);

    expect(turns).toBe(3);
    // user → asst(search) → tool → asst(read_file) → tool → asst(final)
    expect(messages).toHaveLength(6);
    expect(extractText(messages[5]!)).toBe('The answer is: use vitest.');
  });

  it('parallel tool calls: 3 tool_calls in one turn → all executed', async () => {
    const tc1: ToolCall = {
      type: 'function',
      id: 'tc-a',
      function: { name: 'fetch_url', arguments: '{"url":"https://a.com"}' },
    };
    const tc2: ToolCall = {
      type: 'function',
      id: 'tc-b',
      function: { name: 'fetch_url', arguments: '{"url":"https://b.com"}' },
    };
    const tc3: ToolCall = {
      type: 'function',
      id: 'tc-c',
      function: { name: 'fetch_url', arguments: '{"url":"https://c.com"}' },
    };

    const provider = new QueuedMockProvider([
      // Turn 1: 3 parallel tool calls
      createMockStream([tc1, tc2, tc3]),
      // Turn 2: final text
      createMockStream([{ type: 'text', text: 'All 3 URLs fetched.' }]),
    ]);

    const callOrder: string[] = [];
    const toolset = new SimpleToolset();
    toolset.add(
      { name: 'fetch_url', description: 'Fetch a URL', parameters: {} },
      async (args: JsonType): Promise<ToolReturnValue> => {
        const obj = args as Record<string, JsonType>;
        const url = obj['url'] as string;
        // Vary delays to confirm parallel execution
        const delay = url.includes('a.com') ? 30 : url.includes('b.com') ? 10 : 20;
        await new Promise<void>((r) => setTimeout(r, delay));
        callOrder.push(url);
        return toolOk({ output: `content of ${url}` });
      },
    );

    const { messages, turns } = await runAgentLoop(provider, toolset);

    expect(turns).toBe(2);
    // All 3 tool results should be present
    const toolMessages = messages.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(3);

    // b.com should finish first (10ms), c.com second (20ms), a.com last (30ms)
    // confirming parallel execution
    expect(callOrder[0]).toBe('https://b.com');
    expect(callOrder[1]).toBe('https://c.com');
    expect(callOrder[2]).toBe('https://a.com');
  });

  it('tool chain: tool A result triggers tool B call', async () => {
    const tcList: ToolCall = {
      type: 'function',
      id: 'tc-list',
      function: { name: 'list_files', arguments: '{"dir":"/src"}' },
    };
    const tcRead: ToolCall = {
      type: 'function',
      id: 'tc-read',
      function: { name: 'read_file', arguments: '{"path":"/src/main.ts"}' },
    };

    // The provider sees history growing—tool A result is in history when
    // turn 2 calls tool B.
    const provider = new QueuedMockProvider([
      createMockStream([tcList]),
      createMockStream([tcRead]),
      createMockStream([{ type: 'text', text: 'main.ts exports greet()' }]),
    ]);

    const toolset = new SimpleToolset();
    toolset.add(
      { name: 'list_files', description: 'List', parameters: {} },
      async (): Promise<ToolReturnValue> => toolOk({ output: 'main.ts\nutils.ts' }),
    );
    toolset.add(
      { name: 'read_file', description: 'Read', parameters: {} },
      async (args: JsonType): Promise<ToolReturnValue> => {
        const obj = args as Record<string, JsonType>;
        return toolOk({ output: `content of ${obj['path'] as string}` });
      },
    );

    const { messages, turns } = await runAgentLoop(provider, toolset);

    expect(turns).toBe(3);
    // user → asst(list) → tool(list result) → asst(read) → tool(read result) → asst(final)
    expect(messages).toHaveLength(6);
    expect(extractText(messages[5]!)).toBe('main.ts exports greet()');
  });

  it('text + tool_call interleaved across multiple turns', async () => {
    const tc1: ToolCall = {
      type: 'function',
      id: 'tc-1',
      function: { name: 'calc', arguments: '{"expr":"2+2"}' },
    };
    const tc2: ToolCall = {
      type: 'function',
      id: 'tc-2',
      function: { name: 'calc', arguments: '{"expr":"4*3"}' },
    };

    const provider = new QueuedMockProvider([
      createMockStream([{ type: 'text', text: 'Computing 2+2...' }, tc1]),
      createMockStream([{ type: 'text', text: 'Now 4*3...' }, tc2]),
      createMockStream([{ type: 'text', text: 'Results: 4 and 12.' }]),
    ]);

    const toolset = new SimpleToolset();
    toolset.add(
      { name: 'calc', description: 'Calculate', parameters: {} },
      async (args: JsonType): Promise<ToolReturnValue> => {
        const obj = args as Record<string, JsonType>;
        const expr = obj['expr'] as string;
        const result = expr === '2+2' ? '4' : '12';
        return toolOk({ output: result });
      },
    );

    const { messages, turns } = await runAgentLoop(provider, toolset);

    expect(turns).toBe(3);
    // Each assistant message should have both text content and tool calls
    expect(messages[1]!.content).toEqual([{ type: 'text', text: 'Computing 2+2...' }]);
    expect(messages[1]!.toolCalls).toHaveLength(1);
    expect(messages[3]!.content).toEqual([{ type: 'text', text: 'Now 4*3...' }]);
    expect(messages[3]!.toolCalls).toHaveLength(1);
    expect(extractText(messages[5]!)).toBe('Results: 4 and 12.');
  });

  it('ScriptedEchoChatProvider works for multi-step loop with echo DSL', async () => {
    const provider = new ScriptedEchoChatProvider([
      // Turn 1: tool call via DSL
      'tool_call: {"id":"tc-1","name":"greet","arguments":"{\\"name\\":\\"world\\"}"}',
      // Turn 2: final text
      'text: Hello, world!',
    ]);

    const toolset = new SimpleToolset();
    toolset.add(
      { name: 'greet', description: 'Greet', parameters: {} },
      async (args: JsonType): Promise<ToolReturnValue> => {
        const obj = args as Record<string, JsonType>;
        return toolOk({ output: `Hi ${obj['name'] as string}` });
      },
    );

    const { turns } = await runAgentLoop(provider, toolset);
    expect(turns).toBe(2);
  });

  it('empty tool arguments (null) are handled correctly', async () => {
    const tc: ToolCall = {
      type: 'function',
      id: 'tc-no-args',
      function: { name: 'get_time', arguments: null },
    };

    const provider = new QueuedMockProvider([
      createMockStream([tc]),
      createMockStream([{ type: 'text', text: 'The time is 12:00.' }]),
    ]);

    const toolset = new SimpleToolset();
    toolset.add(
      { name: 'get_time', description: 'Get current time', parameters: {} },
      async (): Promise<ToolReturnValue> => toolOk({ output: '12:00' }),
    );

    const { turns } = await runAgentLoop(provider, toolset);
    expect(turns).toBe(2);
  });
});
