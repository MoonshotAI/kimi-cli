import { describe, it, expect } from 'vitest';

import { WireHandler, type WireHandlerDelegate, type SubagentRoutedPayload } from '../../src/app/WireHandler.js';
import { darkColors } from '../../src/theme/colors.js';
import type { WireMessage } from '../../src/wire/wire-message.js';
import type { WireClient } from '../../src/wire/client.js';

function makeRouted(
  parentId: string,
  subEvent: { method: string; data: unknown },
  agentId = 'sub_1',
  agentName?: string,
): WireMessage {
  return {
    type: 'event',
    method: 'subagent.event',
    session_id: 'ses_1',
    seq: 1,
    data: {
      parent_tool_call_id: parentId,
      agent_id: agentId,
      ...(agentName !== undefined ? { agent_name: agentName } : {}),
      sub_event: subEvent,
    },
  };
}

function makeStubDelegate(): {
  delegate: WireHandlerDelegate;
  routed: Array<{ parentId: string; payload: SubagentRoutedPayload }>;
} {
  const routed: Array<{ parentId: string; payload: SubagentRoutedPayload }> = [];
  const delegate: WireHandlerDelegate = {
    getState: () => ({
      model: 'test',
      workDir: '/tmp',
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
    onToolCallEnd: () => {},
    routeSubagentEvent: (parentId, payload) => {
      routed.push({ parentId, payload });
    },
  };
  return { delegate, routed };
}

describe('WireHandler subagent.event routing', () => {
  const fakeClient = {} as WireClient;

  it('routes a well-formed subagent.event to the delegate', () => {
    const { delegate, routed } = makeStubDelegate();
    const handler = new WireHandler(fakeClient, 'ses_1', delegate, darkColors);
    const msg = makeRouted(
      'tc_parent',
      { method: 'tool.call', data: { id: 'sub_tc', name: 'Grep', args: { pattern: 'x' } } },
      'sub_abc',
      'explore',
    );
    handler.processMessage(msg);
    expect(routed).toHaveLength(1);
    expect(routed[0]!.parentId).toBe('tc_parent');
    expect(routed[0]!.payload.agent_id).toBe('sub_abc');
    expect(routed[0]!.payload.agent_name).toBe('explore');
    expect(routed[0]!.payload.sub_event.method).toBe('tool.call');
  });

  it('drops an envelope missing parent_tool_call_id without throwing', () => {
    const { delegate, routed } = makeStubDelegate();
    const handler = new WireHandler(fakeClient, 'ses_1', delegate, darkColors);
    const msg: WireMessage = {
      type: 'event',
      method: 'subagent.event',
      session_id: 'ses_1',
      seq: 1,
      data: {
        agent_id: 'sub_x',
        sub_event: { method: 'tool.call', data: {} },
      },
    };
    expect(() => handler.processMessage(msg)).not.toThrow();
    expect(routed).toHaveLength(0);
  });

  it('drops an envelope missing sub_event.method', () => {
    const { delegate, routed } = makeStubDelegate();
    const handler = new WireHandler(fakeClient, 'ses_1', delegate, darkColors);
    const msg: WireMessage = {
      type: 'event',
      method: 'subagent.event',
      session_id: 'ses_1',
      seq: 1,
      data: {
        parent_tool_call_id: 'p',
        agent_id: 'sub_x',
        sub_event: { data: {} },
      },
    };
    expect(() => handler.processMessage(msg)).not.toThrow();
    expect(routed).toHaveLength(0);
  });
});
