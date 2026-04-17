import { describe, it, expect } from 'vitest';

import { WireHandler, type WireHandlerDelegate } from '../../src/app/WireHandler.js';
import { darkColors } from '../../src/theme/colors.js';
import type { WireMessage } from '../../src/wire/wire-message.js';
import type { WireClient } from '../../src/wire/client.js';

type TodoStatus = 'pending' | 'in_progress' | 'done';

function makeToolCallMsg(id: string, name: string, args: Record<string, unknown>): WireMessage {
  return {
    type: 'event',
    method: 'tool.call',
    session_id: 'ses_1',
    seq: 1,
    data: { id, name, args },
  };
}

function makeToolResultMsg(
  id: string,
  output: string,
  is_error = false,
): WireMessage {
  return {
    type: 'event',
    method: 'tool.result',
    session_id: 'ses_1',
    seq: 2,
    data: { tool_call_id: id, output, is_error },
  };
}

function makeStubDelegate(): {
  delegate: WireHandlerDelegate;
  todoCalls: Array<readonly { title: string; status: TodoStatus }[]>;
  toolEnds: string[];
} {
  const todoCalls: Array<readonly { title: string; status: TodoStatus }[]> = [];
  const toolEnds: string[] = [];
  const delegate: WireHandlerDelegate = {
    getState: () => ({
      model: 'm',
      workDir: '/',
      sessionId: 'ses_1',
      yolo: false,
      planMode: false,
      thinking: false,
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
      isStreaming: false,
      streamingPhase: 'idle',
      streamingStartTime: 0,
      theme: 'dark',
      version: '0.0.0',
      editorCommand: null,
      availableModels: {},
    }),
    setState: () => {},
    getLivePane: () => ({
      mode: 'idle',
      pendingApproval: null,
      pendingQuestion: null,
      pendingToolCall: null,
      thinkingText: '',
    }),
    setLivePane: () => {},
    patchLivePane: () => {},
    resetLivePane: () => {},
    addTranscriptEntry: () => {},
    addToast: () => {},
    removeToast: () => {},
    onStreamingTextStart: () => {},
    onStreamingTextUpdate: () => {},
    onStreamingTextEnd: () => {},
    onToolCallStart: () => {},
    onToolCallEnd: (id) => { toolEnds.push(id); },
    routeSubagentEvent: () => {},
    setTodoList: (todos) => { todoCalls.push(todos); },
  };
  return { delegate, todoCalls, toolEnds };
}

describe('WireHandler SetTodoList routing', () => {
  const fakeClient = {} as WireClient;

  it('forwards the authoritative todos from args when tool.result lands', () => {
    const { delegate, todoCalls } = makeStubDelegate();
    const h = new WireHandler(fakeClient, 'ses_1', delegate, darkColors);
    const todos = [
      { title: 'a', status: 'done' as const },
      { title: 'b', status: 'in_progress' as const },
      { title: 'c', status: 'pending' as const },
    ];
    h.processMessage(makeToolCallMsg('tc_1', 'SetTodoList', { todos }));
    h.processMessage(makeToolResultMsg('tc_1', 'ok'));
    expect(todoCalls).toHaveLength(1);
    expect(todoCalls[0]).toEqual(todos);
  });

  it('does NOT forward anything when SetTodoList was a query (no todos arg)', () => {
    const { delegate, todoCalls } = makeStubDelegate();
    const h = new WireHandler(fakeClient, 'ses_1', delegate, darkColors);
    h.processMessage(makeToolCallMsg('tc_q', 'SetTodoList', {}));
    h.processMessage(makeToolResultMsg('tc_q', 'ok'));
    expect(todoCalls).toHaveLength(0);
  });

  it('forwards an empty array when the LLM clears the list', () => {
    const { delegate, todoCalls } = makeStubDelegate();
    const h = new WireHandler(fakeClient, 'ses_1', delegate, darkColors);
    h.processMessage(makeToolCallMsg('tc_clear', 'SetTodoList', { todos: [] }));
    h.processMessage(makeToolResultMsg('tc_clear', 'ok'));
    expect(todoCalls).toEqual([[]]);
  });

  it('does NOT forward on error results', () => {
    const { delegate, todoCalls } = makeStubDelegate();
    const h = new WireHandler(fakeClient, 'ses_1', delegate, darkColors);
    h.processMessage(makeToolCallMsg('tc_err', 'SetTodoList', { todos: [{ title: 'x', status: 'pending' }] }));
    h.processMessage(makeToolResultMsg('tc_err', 'fail', true));
    expect(todoCalls).toHaveLength(0);
  });

  it('skips malformed entries instead of propagating bad shape', () => {
    const { delegate, todoCalls } = makeStubDelegate();
    const h = new WireHandler(fakeClient, 'ses_1', delegate, darkColors);
    const mixed = [
      { title: 'good', status: 'done' },
      { title: '', status: 'pending' },           // empty title → drop
      { title: 'x', status: 'bogus' },            // bad status → drop
      'string',                                    // non-object → drop
      { title: 'ok', status: 'in_progress' },
    ];
    h.processMessage(makeToolCallMsg('tc_mix', 'SetTodoList', { todos: mixed }));
    h.processMessage(makeToolResultMsg('tc_mix', 'ok'));
    expect(todoCalls).toEqual([
      [
        { title: 'good', status: 'done' },
        { title: 'ok', status: 'in_progress' },
      ],
    ]);
  });

  it('non-SetTodoList tool results do not touch the todo list', () => {
    const { delegate, todoCalls } = makeStubDelegate();
    const h = new WireHandler(fakeClient, 'ses_1', delegate, darkColors);
    h.processMessage(makeToolCallMsg('tc_bash', 'Bash', { command: 'ls' }));
    h.processMessage(makeToolResultMsg('tc_bash', 'output'));
    expect(todoCalls).toHaveLength(0);
  });
});
