/**
 * Tool call scenario -- demonstrates a tool invocation with result.
 *
 * Flow: turn.begin -> step.begin -> content.delta(think)
 *       -> tool.call -> tool.result -> step.end
 *       -> step.begin(2) -> content.delta(text) * N
 *       -> status.update -> step.end -> turn.end
 */

import type { Scenario } from '../mock-event-generator.js';
import { evt, delay } from '../mock-event-generator.js';
import { createEvent } from '../types.js';
import type {
  TurnBeginData,
  StepBeginData,
  StepEndData,
  ContentDeltaData,
  ToolCallData,
  ToolResultData,
  StatusUpdateData,
  TurnEndData,
} from '../types.js';

export function toolCallScenario(userInput: string, sessionId: string, turnId: string): Scenario {
  const opts = { session_id: sessionId, turn_id: turnId };

  return {
    name: 'tool-call',
    description: 'Conversation with tool call and result',
    steps: [
      evt(createEvent('turn.begin', { turn_id: turnId, user_input: userInput, input_kind: 'user' } satisfies TurnBeginData, opts)),
      delay(50),
      // Step 1: model decides to call a tool
      evt(createEvent('step.begin', { step: 1 } satisfies StepBeginData, opts)),
      delay(30),
      evt(createEvent('content.delta', { type: 'think', think: 'I need to list the files in the current directory.' } satisfies ContentDeltaData, opts)),
      delay(40),
      evt(createEvent('tool.call', {
        id: 'tc-001',
        name: 'Shell',
        args: { command: 'ls -la' },
        description: 'Running: ls -la',
      } satisfies ToolCallData, opts)),
      delay(100),
      // Tool result
      evt(createEvent('tool.result', {
        tool_call_id: 'tc-001',
        output: 'total 32\ndrwxr-xr-x  5 user  staff  160 Jan  1 00:00 .\ndrwxr-xr-x  3 user  staff   96 Jan  1 00:00 ..\n-rw-r--r--  1 user  staff  1234 Jan  1 00:00 package.json\n-rw-r--r--  1 user  staff   567 Jan  1 00:00 tsconfig.json\ndrwxr-xr-x  4 user  staff  128 Jan  1 00:00 src',
        is_error: false,
      } satisfies ToolResultData, opts)),
      delay(20),
      evt(createEvent('step.end', {} satisfies StepEndData, opts)),
      delay(30),
      // Step 2: model summarizes the result
      evt(createEvent('step.begin', { step: 2 } satisfies StepBeginData, opts)),
      delay(30),
      evt(createEvent('content.delta', { type: 'text', text: 'Here are the files in your current directory:\n\n' } satisfies ContentDeltaData, opts)),
      delay(15),
      evt(createEvent('content.delta', { type: 'text', text: '- `package.json` - Node.js package configuration\n' } satisfies ContentDeltaData, opts)),
      delay(15),
      evt(createEvent('content.delta', { type: 'text', text: '- `tsconfig.json` - TypeScript configuration\n' } satisfies ContentDeltaData, opts)),
      delay(15),
      evt(createEvent('content.delta', { type: 'text', text: '- `src/` - Source code directory\n' } satisfies ContentDeltaData, opts)),
      delay(20),
      evt(createEvent('status.update', {
        context_usage: 0.12,
        context_tokens: 1200,
        max_context_tokens: 100000,
        token_usage: {
          input_other: 300,
          output: 150,
          input_cache_read: 0,
          input_cache_creation: 0,
        },
      } satisfies StatusUpdateData, opts)),
      delay(10),
      evt(createEvent('step.end', {} satisfies StepEndData, opts)),
      delay(10),
      evt(createEvent('turn.end', { turn_id: turnId, reason: 'done', success: true } satisfies TurnEndData, opts)),
    ],
  };
}
