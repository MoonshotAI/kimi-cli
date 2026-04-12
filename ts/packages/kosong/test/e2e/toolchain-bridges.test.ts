import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { derefJsonSchema } from '../../src/json-schema-deref.js';
import { MCPToolset, type MCPClient } from '../../src/mcp-toolset.js';
import { createToolMessage, extractText } from '../../src/message.js';
import type { Message, StreamedMessagePart } from '../../src/message.js';
import type { ChatProvider, StreamedMessage, ThinkingEffort } from '../../src/provider.js';
import { SimpleToolset } from '../../src/simple-toolset.js';
import { step } from '../../src/step.js';
import type { Tool, ToolReturnValue } from '../../src/tool.js';
import { toolOk } from '../../src/tool.js';
import { createTypedTool } from '../../src/typed-tool.js';

function createStream(parts: StreamedMessagePart[], opts?: { id?: string }): StreamedMessage {
  return {
    get id(): string | null {
      return opts?.id ?? null;
    },
    get usage() {
      return null;
    },
    async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
      for (const part of parts) {
        yield part;
      }
    },
  };
}

class QueuedProvider implements ChatProvider {
  readonly name: string = 'queued';
  readonly modelName: string = 'queued-model';
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
      throw new Error(`QueuedProvider exhausted at turn ${this._cursor + 1}.`);
    }
    this._cursor += 1;
    return stream;
  }

  withThinking(_effort: ThinkingEffort): ChatProvider {
    return this;
  }
}

async function runTwoStepLoop(toolset: SimpleToolset | MCPToolset, provider: ChatProvider) {
  const history: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'run the tool chain' }], toolCalls: [] },
  ];

  const first = await step(provider, '', toolset, history);
  history.push(first.message);

  const toolResults = await first.toolResults();
  for (const toolResult of toolResults) {
    history.push(createToolMessage(toolResult.toolCallId, toolResult.returnValue.output));
  }

  const second = await step(provider, '', toolset, history);
  history.push(second.message);

  return { first, second, toolResults, history };
}

describe('e2e: kosong toolchain bridges', () => {
  it('typed-tool -> SimpleToolset -> step dispatches nested Zod args and completes the loop', async () => {
    const addressTool = createTypedTool({
      name: 'route_address',
      description: 'Routes a package to a nested address payload',
      params: z.object({
        shipment: z.object({
          id: z.string(),
          address: z.object({
            city: z.string(),
            zip: z.string(),
          }),
        }),
        urgent: z.boolean().optional(),
      }),
      handler: async (params): Promise<ToolReturnValue> => {
        return toolOk({
          output: `${params.shipment.id} -> ${params.shipment.address.city}:${params.shipment.address.zip}`,
        });
      },
    });

    expect(addressTool.tool.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: expect.objectContaining({
        shipment: expect.any(Object),
      }),
    });

    const provider = new QueuedProvider([
      createStream([
        { type: 'text', text: 'I will route the shipment.' },
        {
          type: 'function',
          id: 'tc-route',
          function: {
            name: 'route_address',
            arguments: JSON.stringify({
              shipment: {
                id: 'pkg-42',
                address: { city: 'Shanghai', zip: '200000' },
              },
              urgent: true,
            }),
          },
        },
      ]),
      createStream([{ type: 'text', text: 'Shipment routed.' }]),
    ]);

    const toolset = new SimpleToolset();
    toolset.add(addressTool.tool, addressTool.handler);

    const { first, second, toolResults } = await runTwoStepLoop(toolset, provider);

    expect(extractText(first.message)).toBe('I will route the shipment.');
    expect(first.toolCalls).toHaveLength(1);
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.toolCallId).toBe('tc-route');
    expect(toolResults[0]!.returnValue.isError).toBe(false);
    expect(toolResults[0]!.returnValue.output).toBe('pkg-42 -> Shanghai:200000');
    expect(extractText(second.message)).toBe('Shipment routed.');
  });

  it('json-schema-deref -> SimpleToolset -> step validates a flattened schema and completes the loop', async () => {
    const rawSchema: Record<string, unknown> = {
      type: 'object',
      $defs: {
        address: {
          type: 'object',
          properties: {
            city: { type: 'string' },
            zip: { type: 'string' },
          },
          required: ['city', 'zip'],
          additionalProperties: false,
        },
      },
      properties: {
        shipping: { $ref: '#/$defs/address' },
        billing: { $ref: '#/$defs/address' },
      },
      required: ['shipping', 'billing'],
      additionalProperties: false,
    };

    const schema = derefJsonSchema(rawSchema);
    expect(schema).not.toHaveProperty('$defs');
    expect(schema).toMatchObject({
      type: 'object',
      properties: expect.objectContaining({
        shipping: expect.objectContaining({
          type: 'object',
          properties: expect.objectContaining({
            city: { type: 'string' },
            zip: { type: 'string' },
          }),
        }),
      }),
    });

    const toolset = new SimpleToolset();
    let receivedArgs: Record<string, unknown> | null = null;
    toolset.add(
      {
        name: 'ship_package',
        description: 'Ships a package with two addresses',
        parameters: schema,
      },
      async (args): Promise<ToolReturnValue> => {
        receivedArgs = args as Record<string, unknown>;
        return toolOk({
          output: `ship:${(args as Record<string, unknown>)['shipping'] !== undefined ? 'ok' : 'missing'}`,
        });
      },
    );

    const provider = new QueuedProvider([
      createStream([
        {
          type: 'function',
          id: 'tc-ship',
          function: {
            name: 'ship_package',
            arguments: JSON.stringify({
              shipping: { city: 'Hangzhou', zip: '310000' },
              billing: { city: 'Shenzhen', zip: '518000' },
            }),
          },
        },
      ]),
      createStream([{ type: 'text', text: 'Shipment booked.' }]),
    ]);

    const { first, second, toolResults } = await runTwoStepLoop(toolset, provider);

    expect(first.toolCalls).toHaveLength(1);
    expect(receivedArgs).toEqual({
      shipping: { city: 'Hangzhou', zip: '310000' },
      billing: { city: 'Shenzhen', zip: '518000' },
    });
    expect(toolResults[0]!.returnValue.output).toBe('ship:ok');
    expect(extractText(second.message)).toBe('Shipment booked.');
  });

  it('MCPToolset -> step discovers tools, validates args, and dispatches through the fake client', async () => {
    const callLog: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client: MCPClient = {
      async listTools() {
        return [
          {
            name: 'summarize',
            description: 'Summarizes a document',
            inputSchema: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                body: { type: 'string' },
              },
              required: ['title', 'body'],
              additionalProperties: false,
            },
          },
        ];
      },
      async callTool(name, args) {
        callLog.push({ name, args });
        return {
          content: [{ type: 'text', text: `${args['title']} summarized` }],
          isError: false,
        };
      },
    };

    const toolset = await MCPToolset.connect(client);
    expect(toolset.tools).toHaveLength(1);
    expect(toolset.tools[0]!.name).toBe('summarize');

    const provider = new QueuedProvider([
      createStream([
        { type: 'text', text: 'I will summarize the document.' },
        {
          type: 'function',
          id: 'tc-mcp',
          function: {
            name: 'summarize',
            arguments: JSON.stringify({
              title: 'Design Notes',
              body: 'The system is now TS-native.',
            }),
          },
        },
      ]),
      createStream([{ type: 'text', text: 'Summary complete.' }]),
    ]);

    const { first, second, toolResults } = await runTwoStepLoop(toolset, provider);

    expect(extractText(first.message)).toBe('I will summarize the document.');
    expect(callLog).toEqual([
      {
        name: 'summarize',
        args: {
          title: 'Design Notes',
          body: 'The system is now TS-native.',
        },
      },
    ]);
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.returnValue.isError).toBe(false);
    expect(toolResults[0]!.returnValue.output).toBe('Design Notes summarized');
    expect(extractText(second.message)).toBe('Summary complete.');
  });
});
