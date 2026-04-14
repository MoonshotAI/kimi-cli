/**
 * Approval scenario -- triggers an approval request before executing a write.
 *
 * Flow: TurnBegin -> StepBegin -> ThinkPart -> ApprovalRequest
 *       -> (wait for approval) -> ToolCall -> ToolResult
 *       -> StepBegin(2) -> TextPart -> StatusUpdate -> TurnEnd
 *
 * The scenario pauses at the ApprovalRequest. The `MockWireClient` resumes
 * the stream when `approvalResponse()` is called.
 */

import type { Scenario, ScenarioStep } from '../mock-event-generator.js';
import { event, delay } from '../mock-event-generator.js';

/**
 * Create an approval scenario. The `onApproval` callback receives a function
 * that should be called to provide the remaining steps after approval.
 */
export function approvalScenario(userInput: string): {
  /** Steps before the approval pause. */
  preApproval: Scenario;
  /** Steps after approval is granted. */
  postApproval: Scenario;
  /** Steps when approval is rejected. */
  rejected: Scenario;
  /** The approval request ID. */
  approvalRequestId: string;
} {
  const approvalRequestId = 'apr-001';

  const preApproval: Scenario = {
    name: 'approval-pre',
    description: 'Before approval request',
    steps: [
      event({ type: 'TurnBegin', userInput }),
      delay(50),
      event({ type: 'StepBegin', n: 1 }),
      delay(30),
      event({
        type: 'ContentPart',
        part: { type: 'think', think: 'I need to write a file. Let me ask for approval.' },
      }),
      delay(40),
      event({
        type: 'ApprovalRequest',
        id: approvalRequestId,
        toolCallId: 'tc-002',
        sender: 'Write',
        action: 'write file',
        description: 'Write hello.py with a greeting script',
        display: [
          {
            type: 'diff',
            path: 'hello.py',
            oldText: '',
            newText: 'print("Hello, World!")\n',
          },
        ],
      }),
    ],
  };

  const postApproval: Scenario = {
    name: 'approval-post',
    description: 'After approval granted',
    steps: [
      event({
        type: 'ApprovalResponse',
        requestId: approvalRequestId,
        response: 'approve',
        feedback: '',
      }),
      delay(30),
      event({
        type: 'ToolCall',
        toolCall: {
          type: 'function',
          id: 'tc-002',
          function: {
            name: 'Write',
            arguments: '{"path":"hello.py","content":"print(\\"Hello, World!\\")\\n"}',
          },
        },
      }),
      delay(80),
      event({
        type: 'ToolResult',
        toolCallId: 'tc-002',
        returnValue: {
          isError: false,
          output: 'File written successfully.',
          message: 'Wrote 1 line to hello.py',
          display: [
            {
              type: 'brief',
              text: 'Wrote hello.py',
            },
          ],
        },
      }),
      delay(50),
      event({ type: 'StepBegin', n: 2 }),
      delay(30),
      event({
        type: 'ContentPart',
        part: {
          type: 'text',
          text: 'I have created `hello.py` with a simple greeting script. You can run it with `python hello.py`.',
        },
      }),
      delay(20),
      event({
        type: 'StatusUpdate',
        contextUsage: 0.08,
        contextTokens: 800,
        maxContextTokens: 100000,
      }),
      delay(10),
      event({ type: 'TurnEnd' }),
    ],
  };

  const rejected: Scenario = {
    name: 'approval-rejected',
    description: 'After approval rejected',
    steps: [
      event({
        type: 'ApprovalResponse',
        requestId: approvalRequestId,
        response: 'reject',
        feedback: 'Please do not write files.',
      }),
      delay(30),
      event({ type: 'StepBegin', n: 2 }),
      delay(30),
      event({
        type: 'ContentPart',
        part: {
          type: 'text',
          text: 'Understood, I will not write the file. Let me know if you need anything else.',
        },
      }),
      delay(20),
      event({
        type: 'StatusUpdate',
        contextUsage: 0.06,
        contextTokens: 600,
        maxContextTokens: 100000,
      }),
      delay(10),
      event({ type: 'TurnEnd' }),
    ],
  };

  return { preApproval, postApproval, rejected, approvalRequestId };
}

/**
 * Build a flat list of steps for the approval scenario,
 * assuming approval is granted (for simple testing).
 */
export function approvalScenarioFlat(userInput: string): Scenario {
  const { preApproval, postApproval } = approvalScenario(userInput);
  const steps: ScenarioStep[] = [...preApproval.steps, delay(100), ...postApproval.steps];
  return {
    name: 'approval',
    description: 'Approval flow (auto-approved)',
    steps,
  };
}
