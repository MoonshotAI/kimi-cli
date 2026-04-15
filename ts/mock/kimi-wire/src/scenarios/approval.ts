/**
 * Approval scenario -- triggers an approval request before executing a write.
 *
 * Flow: turn.begin -> step.begin -> content.delta(think) -> approval.request (pause)
 *       -> (wait for approval) -> tool.call -> tool.result -> step.end
 *       -> step.begin(2) -> content.delta(text) -> status.update -> step.end -> turn.end
 *
 * The scenario pauses at the approval.request. The MockEventGenerator
 * resumes when resolveRequest() is called via WireClient.respondToRequest().
 */

import type { Scenario } from '../mock-event-generator.js';
import { evt, req, delay } from '../mock-event-generator.js';
import { createEvent, createRequest } from '../types.js';
import type {
  TurnBeginData,
  StepBeginData,
  StepEndData,
  ContentDeltaData,
  ApprovalRequestData,
  ToolCallData,
  ToolResultData,
  StatusUpdateData,
  TurnEndData,
} from '../types.js';

export function approvalScenario(userInput: string, sessionId: string, turnId: string): Scenario {
  const opts = { session_id: sessionId, turn_id: turnId };
  const reqOpts = { session_id: sessionId, from: 'core', to: 'client', turn_id: turnId };

  const approvalRequest = createRequest('approval.request', {
    id: 'apr-001',
    tool_call_id: 'tc-002',
    tool_name: 'Write',
    action: 'write file',
    description: 'Write hello.py with a greeting script',
    display: [
      {
        type: 'diff',
        path: 'hello.py',
        old_text: '',
        new_text: 'print("Hello, World!")\n',
      },
    ],
  } satisfies ApprovalRequestData, reqOpts);

  return {
    name: 'approval',
    description: 'Approval flow with pause/resume',
    steps: [
      evt(createEvent('turn.begin', { turn_id: turnId, user_input: userInput, input_kind: 'user' } satisfies TurnBeginData, opts)),
      delay(50),
      evt(createEvent('step.begin', { step: 1 } satisfies StepBeginData, opts)),
      delay(30),
      evt(createEvent('content.delta', { type: 'think', think: 'I need to write a file. Let me ask for approval.' } satisfies ContentDeltaData, opts)),
      delay(40),
      // Approval request -- pauses the stream
      req(approvalRequest),
      // After approval is resolved, continue:
      delay(30),
      evt(createEvent('tool.call', {
        id: 'tc-002',
        name: 'Write',
        args: { path: 'hello.py', content: 'print("Hello, World!")\n' },
        description: 'Writing hello.py',
      } satisfies ToolCallData, opts)),
      delay(80),
      evt(createEvent('tool.result', {
        tool_call_id: 'tc-002',
        output: 'File written successfully.',
        is_error: false,
      } satisfies ToolResultData, opts)),
      delay(20),
      evt(createEvent('step.end', {} satisfies StepEndData, opts)),
      delay(30),
      evt(createEvent('step.begin', { step: 2 } satisfies StepBeginData, opts)),
      delay(30),
      evt(createEvent('content.delta', { type: 'text', text: 'I have created `hello.py` with a simple greeting script. You can run it with `python hello.py`.' } satisfies ContentDeltaData, opts)),
      delay(20),
      evt(createEvent('status.update', {
        context_usage: 0.08,
        context_tokens: 800,
        max_context_tokens: 100000,
      } satisfies StatusUpdateData, opts)),
      delay(10),
      evt(createEvent('step.end', {} satisfies StepEndData, opts)),
      delay(10),
      evt(createEvent('turn.end', { turn_id: turnId, reason: 'done', success: true } satisfies TurnEndData, opts)),
    ],
  };
}

/**
 * Build a flat scenario for approval with auto-approve (for simple testing).
 * Does not actually pause -- all steps run sequentially.
 */
export function approvalScenarioFlat(userInput: string, sessionId: string = '__mock__', turnId: string = 'turn_0'): Scenario {
  const opts = { session_id: sessionId, turn_id: turnId };

  return {
    name: 'approval-flat',
    description: 'Approval flow (auto-approved, no pause)',
    steps: [
      evt(createEvent('turn.begin', { turn_id: turnId, user_input: userInput, input_kind: 'user' } satisfies TurnBeginData, opts)),
      delay(50),
      evt(createEvent('step.begin', { step: 1 } satisfies StepBeginData, opts)),
      delay(30),
      evt(createEvent('content.delta', { type: 'think', think: 'I need to write a file. Let me ask for approval.' } satisfies ContentDeltaData, opts)),
      delay(40),
      // Approval request as event (not pausing)
      evt(createEvent('approval.request', {
        id: 'apr-001',
        tool_call_id: 'tc-002',
        tool_name: 'Write',
        action: 'write file',
        description: 'Write hello.py with a greeting script',
        display: [
          {
            type: 'diff',
            path: 'hello.py',
            old_text: '',
            new_text: 'print("Hello, World!")\n',
          },
        ],
      } satisfies ApprovalRequestData, opts)),
      delay(30),
      evt(createEvent('tool.call', {
        id: 'tc-002',
        name: 'Write',
        args: { path: 'hello.py', content: 'print("Hello, World!")\n' },
        description: 'Writing hello.py',
      } satisfies ToolCallData, opts)),
      delay(80),
      evt(createEvent('tool.result', {
        tool_call_id: 'tc-002',
        output: 'File written successfully.',
        is_error: false,
      } satisfies ToolResultData, opts)),
      delay(20),
      evt(createEvent('step.end', {} satisfies StepEndData, opts)),
      delay(30),
      evt(createEvent('step.begin', { step: 2 } satisfies StepBeginData, opts)),
      delay(30),
      evt(createEvent('content.delta', { type: 'text', text: 'I have created `hello.py` with a simple greeting script. You can run it with `python hello.py`.' } satisfies ContentDeltaData, opts)),
      delay(20),
      evt(createEvent('status.update', {
        context_usage: 0.08,
        context_tokens: 800,
        max_context_tokens: 100000,
      } satisfies StatusUpdateData, opts)),
      delay(10),
      evt(createEvent('step.end', {} satisfies StepEndData, opts)),
      delay(10),
      evt(createEvent('turn.end', { turn_id: turnId, reason: 'done', success: true } satisfies TurnEndData, opts)),
    ],
  };
}
