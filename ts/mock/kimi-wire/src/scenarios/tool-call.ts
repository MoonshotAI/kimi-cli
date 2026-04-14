/**
 * Tool call scenario -- demonstrates a tool invocation with result.
 *
 * Flow: TurnBegin -> StepBegin -> ThinkPart -> ToolCall -> ToolResult
 *       -> StepBegin(2) -> TextPart * N -> StatusUpdate -> TurnEnd
 */

import type { Scenario } from '../mock-event-generator.js';
import { event, delay } from '../mock-event-generator.js';

export function toolCallScenario(userInput: string): Scenario {
  return {
    name: 'tool-call',
    description: 'Conversation with tool call and result',
    steps: [
      event({ type: 'TurnBegin', userInput }),
      delay(50),
      // Step 1: model decides to call a tool
      event({ type: 'StepBegin', n: 1 }),
      delay(30),
      event({
        type: 'ContentPart',
        part: { type: 'think', think: 'I need to list the files in the current directory.' },
      }),
      delay(40),
      event({
        type: 'ToolCall',
        toolCall: {
          type: 'function',
          id: 'tc-001',
          function: {
            name: 'Shell',
            arguments: '{"command":"ls -la"}',
          },
        },
      }),
      delay(100),
      // Tool result
      event({
        type: 'ToolResult',
        toolCallId: 'tc-001',
        returnValue: {
          isError: false,
          output: 'total 32\ndrwxr-xr-x  5 user  staff  160 Jan  1 00:00 .\ndrwxr-xr-x  3 user  staff   96 Jan  1 00:00 ..\n-rw-r--r--  1 user  staff  1234 Jan  1 00:00 package.json\n-rw-r--r--  1 user  staff   567 Jan  1 00:00 tsconfig.json\ndrwxr-xr-x  4 user  staff  128 Jan  1 00:00 src',
          message: 'Command executed successfully.',
          display: [
            {
              type: 'shell',
              language: 'bash',
              command: 'ls -la',
            },
          ],
        },
      }),
      delay(50),
      // Step 2: model summarizes the result
      event({ type: 'StepBegin', n: 2 }),
      delay(30),
      event({
        type: 'ContentPart',
        part: {
          type: 'text',
          text: 'Here are the files in your current directory:\n\n',
        },
      }),
      delay(15),
      event({
        type: 'ContentPart',
        part: {
          type: 'text',
          text: '- `package.json` - Node.js package configuration\n',
        },
      }),
      delay(15),
      event({
        type: 'ContentPart',
        part: {
          type: 'text',
          text: '- `tsconfig.json` - TypeScript configuration\n',
        },
      }),
      delay(15),
      event({
        type: 'ContentPart',
        part: {
          type: 'text',
          text: '- `src/` - Source code directory\n',
        },
      }),
      delay(20),
      event({
        type: 'StatusUpdate',
        contextUsage: 0.12,
        contextTokens: 1200,
        maxContextTokens: 100000,
        tokenUsage: {
          inputOther: 300,
          output: 150,
          inputCacheRead: 0,
          inputCacheCreation: 0,
        },
      }),
      delay(10),
      event({ type: 'TurnEnd' }),
    ],
  };
}
