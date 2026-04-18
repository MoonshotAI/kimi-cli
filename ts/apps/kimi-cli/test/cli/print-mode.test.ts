import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  TextPrinter,
  JsonPrinter,
  FinalOnlyTextPrinter,
  FinalOnlyJsonPrinter,
  ExitCode,
  classifySessionError,
} from '../../src/app/printers.js';
import type { WireMessage } from '../../src/wire/wire-message.js';
import type { ContentDeltaData, SessionErrorData, TurnEndData } from '../../src/wire/events.js';

// ── Helpers ────────────────────────────────────────────────────────

afterEach(() => {
  vi.restoreAllMocks();
});

let counter = 0;

function makeEvent(method: string, data: unknown): WireMessage {
  counter += 1;
  return {
    id: `evt_${counter}`,
    time: Date.now(),
    session_id: 'sess_1',
    type: 'event',
    from: 'core',
    to: 'client',
    method,
    data,
    turn_id: 'turn_1',
    seq: counter,
  };
}

function contentDelta(type: ContentDeltaData['type'], text: string): WireMessage {
  if (type === 'think') {
    return makeEvent('content.delta', { type: 'think', think: text });
  }
  return makeEvent('content.delta', { type, text });
}

function stepBegin(step: number): WireMessage {
  return makeEvent('step.begin', { step });
}

function stepInterrupted(step: number): WireMessage {
  return makeEvent('step.interrupted', { step, reason: 'cancelled' });
}

function toolCall(id: string, name: string, args: Record<string, unknown>): WireMessage {
  return makeEvent('tool.call', { id, name, args });
}

function toolResult(toolCallId: string, output: string): WireMessage {
  return makeEvent('tool.result', { tool_call_id: toolCallId, output });
}

function turnEnd(success: boolean): WireMessage {
  return makeEvent('turn.end', {
    turn_id: 'turn_1',
    reason: success ? 'done' : 'error',
    success,
  } satisfies TurnEndData);
}

function notification(title: string, body: string): WireMessage {
  return makeEvent('notification', {
    id: 'notif_1',
    category: 'info',
    type: 'info',
    title,
    body,
    severity: 'info',
    targets: ['shell'],
  });
}

function planDisplay(content: string): WireMessage {
  return makeEvent('plan.display', { content, file_path: '/tmp/plan.md' });
}

function sessionError(error: string, errorType?: SessionErrorData['error_type']): WireMessage {
  return makeEvent('session.error', {
    error,
    error_type: errorType,
  } satisfies SessionErrorData);
}

// ── TextPrinter ────────────────────────────────────────────────────

describe('TextPrinter', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    counter = 0;
    writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  });

  it('should output text content deltas', () => {
    const printer = new TextPrinter();
    printer.feed(contentDelta('text', 'Hello'));
    printer.feed(contentDelta('text', ' World'));
    printer.flush();

    expect(writeSpy).toHaveBeenCalledWith('Hello');
    expect(writeSpy).toHaveBeenCalledWith(' World');
    expect(writeSpy).toHaveBeenCalledWith('\n');
  });

  it('should ignore thinking deltas', () => {
    const printer = new TextPrinter();
    printer.feed(contentDelta('think', 'internal thought'));
    printer.flush();

    // Only the trailing newline if hasOutput is false → no newline either
    expect(writeSpy).not.toHaveBeenCalledWith('internal thought');
  });

  it('should ignore tool call events', () => {
    const printer = new TextPrinter();
    printer.feed(toolCall('tc_1', 'read', { path: '/tmp' }));
    printer.feed(toolResult('tc_1', 'file contents'));
    printer.flush();

    expect(writeSpy).not.toHaveBeenCalledWith(expect.stringContaining('read'));
  });

  it('should not emit trailing newline when no output', () => {
    const printer = new TextPrinter();
    printer.flush();

    expect(writeSpy).not.toHaveBeenCalled();
  });
});

// ── JsonPrinter ────────────────────────────────────────────────────

describe('JsonPrinter', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    counter = 0;
    writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  });

  it('should output assistant message with merged text content', () => {
    const printer = new JsonPrinter();
    printer.feed(contentDelta('text', 'Hello'));
    printer.feed(contentDelta('text', ' World'));
    printer.flush();

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse((writeSpy.mock.calls[0]![0] as string).trim());
    expect(output).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello World' }],
    });
  });

  it('should include tool_calls when present', () => {
    const printer = new JsonPrinter();
    printer.feed(contentDelta('text', 'Let me read that'));
    printer.feed(toolCall('tc_1', 'read', { path: '/tmp/file.txt' }));
    printer.flush();

    const output = JSON.parse((writeSpy.mock.calls[0]![0] as string).trim());
    expect(output.role).toBe('assistant');
    expect(output.content).toEqual([{ type: 'text', text: 'Let me read that' }]);
    expect(output.tool_calls).toEqual([{ id: 'tc_1', name: 'read', args: { path: '/tmp/file.txt' } }]);
  });

  it('should flush assistant message on step.begin and start new one', () => {
    const printer = new JsonPrinter();
    printer.feed(contentDelta('text', 'Step 1 text'));
    printer.feed(stepBegin(2));
    printer.feed(contentDelta('text', 'Step 2 text'));
    printer.flush();

    expect(writeSpy).toHaveBeenCalledTimes(2);
    const out1 = JSON.parse((writeSpy.mock.calls[0]![0] as string).trim());
    const out2 = JSON.parse((writeSpy.mock.calls[1]![0] as string).trim());
    expect(out1.content).toEqual([{ type: 'text', text: 'Step 1 text' }]);
    expect(out2.content).toEqual([{ type: 'text', text: 'Step 2 text' }]);
  });

  it('should emit tool result as tool message', () => {
    const printer = new JsonPrinter();
    printer.feed(toolCall('tc_1', 'read', { path: '/tmp' }));
    printer.feed(toolResult('tc_1', 'file contents'));
    printer.flush();

    // First call: flush assistant (tool_calls), second: tool result
    expect(writeSpy).toHaveBeenCalledTimes(2);
    const toolResultOutput = JSON.parse((writeSpy.mock.calls[1]![0] as string).trim());
    expect(toolResultOutput).toEqual({
      role: 'tool',
      tool_call_id: 'tc_1',
      content: 'file contents',
    });
  });

  it('should emit plan display', () => {
    const printer = new JsonPrinter();
    printer.feed(planDisplay('## Plan\n1. Do stuff'));
    printer.flush();

    const output = JSON.parse((writeSpy.mock.calls[0]![0] as string).trim());
    expect(output.type).toBe('plan_display');
    expect(output.content).toBe('## Plan\n1. Do stuff');
  });

  it('should buffer notifications when content is buffered', () => {
    const printer = new JsonPrinter();
    printer.feed(contentDelta('text', 'text'));
    printer.feed(notification('test', 'notification body'));
    printer.flush();

    expect(writeSpy).toHaveBeenCalledTimes(2);
    const assistantMsg = JSON.parse((writeSpy.mock.calls[0]![0] as string).trim());
    const notifMsg = JSON.parse((writeSpy.mock.calls[1]![0] as string).trim());
    expect(assistantMsg.role).toBe('assistant');
    expect(notifMsg.title).toBe('test');
    expect(notifMsg.body).toBe('notification body');
  });

  it('should include thinking content parts', () => {
    const printer = new JsonPrinter();
    printer.feed(contentDelta('think', 'thinking...'));
    printer.feed(contentDelta('text', 'answer'));
    printer.flush();

    const output = JSON.parse((writeSpy.mock.calls[0]![0] as string).trim());
    expect(output.content).toEqual([
      { type: 'think', think: 'thinking...' },
      { type: 'text', text: 'answer' },
    ]);
  });
});

// ── FinalOnlyTextPrinter ───────────────────────────────────────────

describe('FinalOnlyTextPrinter', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    counter = 0;
    writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  });

  it('should only output text from the final step', () => {
    const printer = new FinalOnlyTextPrinter();
    printer.feed(stepBegin(1));
    printer.feed(contentDelta('text', 'first'));
    printer.feed(stepBegin(2));
    printer.feed(contentDelta('text', 'final'));
    printer.feed(contentDelta('text', ' msg'));
    printer.flush();

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledWith('final msg\n');
  });

  it('should clear buffer on step.interrupted', () => {
    const printer = new FinalOnlyTextPrinter();
    printer.feed(stepBegin(1));
    printer.feed(contentDelta('text', 'initial'));
    printer.feed(stepInterrupted(1));
    printer.feed(contentDelta('text', 'after interrupt'));
    printer.flush();

    expect(writeSpy).toHaveBeenCalledWith('after interrupt\n');
  });

  it('should ignore thinking deltas', () => {
    const printer = new FinalOnlyTextPrinter();
    printer.feed(contentDelta('think', 'secret'));
    printer.feed(contentDelta('text', 'visible'));
    printer.flush();

    expect(writeSpy).toHaveBeenCalledWith('visible\n');
  });

  it('should output nothing when buffer is empty', () => {
    const printer = new FinalOnlyTextPrinter();
    printer.feed(stepBegin(1));
    printer.feed(contentDelta('think', 'only thinking'));
    printer.flush();

    expect(writeSpy).not.toHaveBeenCalled();
  });
});

// ── FinalOnlyJsonPrinter ───────────────────────────────────────────

describe('FinalOnlyJsonPrinter', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    counter = 0;
    writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  });

  it('should output final message as JSON', () => {
    const printer = new FinalOnlyJsonPrinter();
    printer.feed(stepBegin(1));
    printer.feed(contentDelta('text', 'first'));
    printer.feed(stepBegin(2));
    printer.feed(contentDelta('think', 'secret'));
    printer.feed(contentDelta('text', 'final'));
    printer.flush();

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse((writeSpy.mock.calls[0]![0] as string).trim());
    expect(output).toEqual({
      role: 'assistant',
      content: 'final',
    });
  });

  it('should output nothing when only thinking', () => {
    const printer = new FinalOnlyJsonPrinter();
    printer.feed(contentDelta('think', 'only thinking'));
    printer.flush();

    expect(writeSpy).not.toHaveBeenCalled();
  });
});

// ── Exit code classification ───────────────────────────────────────

describe('classifySessionError', () => {
  it('should return SUCCESS=0 constant', () => {
    expect(ExitCode.SUCCESS).toBe(0);
  });

  it('should return FAILURE=1 constant', () => {
    expect(ExitCode.FAILURE).toBe(1);
  });

  it('should return RETRYABLE=75 constant', () => {
    expect(ExitCode.RETRYABLE).toBe(75);
  });

  it('should classify rate_limit as retryable (75)', () => {
    const code = classifySessionError({
      error: 'Rate limit exceeded',
      error_type: 'rate_limit',
    });
    expect(code).toBe(ExitCode.RETRYABLE);
  });

  it('should classify api_error as retryable (75)', () => {
    const code = classifySessionError({
      error: 'Internal server error',
      error_type: 'api_error',
    });
    expect(code).toBe(ExitCode.RETRYABLE);
  });

  it('should classify auth_error as failure (1)', () => {
    const code = classifySessionError({
      error: 'Unauthorized',
      error_type: 'auth_error',
    });
    expect(code).toBe(ExitCode.FAILURE);
  });

  it('should classify tool_error as failure (1)', () => {
    const code = classifySessionError({
      error: 'Tool failed',
      error_type: 'tool_error',
    });
    expect(code).toBe(ExitCode.FAILURE);
  });

  it('should classify internal as failure (1)', () => {
    const code = classifySessionError({
      error: 'Internal error',
      error_type: 'internal',
    });
    expect(code).toBe(ExitCode.FAILURE);
  });

  it('should classify undefined error_type as failure (1)', () => {
    const code = classifySessionError({
      error: 'Unknown error',
    });
    expect(code).toBe(ExitCode.FAILURE);
  });
});

// ── PrintMode integration (via mock WireClient) ────────────────────

describe('runPrintMode', () => {
  // Dynamically import to allow mocking
  let runPrintMode: typeof import('../../src/app/PrintMode.js').runPrintMode;

  beforeEach(async () => {
    counter = 0;
    const mod = await import('../../src/app/PrintMode.js');
    runPrintMode = mod.runPrintMode;
  });

  function createMockWireClient(events: WireMessage[]) {
    return {
      initialize: vi.fn(),
      createSession: vi.fn(),
      listSessions: vi.fn(),
      destroySession: vi.fn(),
      prompt: vi.fn().mockResolvedValue({ turn_id: 'turn_1' }),
      steer: vi.fn(),
      cancel: vi.fn(),
      resume: vi.fn(),
      fork: vi.fn(),
      rename: vi.fn(),
      getStatus: vi.fn(),
      getUsage: vi.fn(),
      compact: vi.fn(),
      clear: vi.fn(),
      setModel: vi.fn(),
      setThinking: vi.fn(),
      setPlanMode: vi.fn(),
      setYolo: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockReturnValue({
        [Symbol.asyncIterator]: () => {
          let idx = 0;
          return {
            next: async () => {
              if (idx >= events.length) return { value: undefined, done: true as const };
              return { value: events[idx++], done: false as const };
            },
          };
        },
      }),
      respondToRequest: vi.fn(),
      handleSlashCommand: vi.fn(),
      dispose: vi.fn(),
    };
  }

  it('should return SUCCESS when prompt completes normally', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const events = [
      contentDelta('text', 'Hello!'),
      turnEnd(true),
    ];
    const client = createMockWireClient(events);

    const code = await runPrintMode({
      wireClient: client,
      sessionId: 'sess_1',
      prompt: 'say hello',
      inputFormat: 'text',
      outputFormat: 'text',
      finalMessageOnly: false,
    });

    expect(code).toBe(ExitCode.SUCCESS);
    expect(client.prompt).toHaveBeenCalledWith('sess_1', 'say hello');
    expect(client.setYolo).toHaveBeenCalledWith('sess_1', true);
    expect(writeSpy).toHaveBeenCalledWith('Hello!');
    writeSpy.mockRestore();
  });

  it('should return FAILURE on turn.end with success=false', async () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const events = [turnEnd(false)];
    const client = createMockWireClient(events);

    const code = await runPrintMode({
      wireClient: client,
      sessionId: 'sess_1',
      prompt: 'fail',
      inputFormat: 'text',
      outputFormat: 'text',
      finalMessageOnly: false,
    });

    expect(code).toBe(ExitCode.FAILURE);
  });

  it('should return RETRYABLE on rate_limit session.error', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const events = [sessionError('Rate limit', 'rate_limit')];
    const client = createMockWireClient(events);

    const code = await runPrintMode({
      wireClient: client,
      sessionId: 'sess_1',
      prompt: 'do something',
      inputFormat: 'text',
      outputFormat: 'text',
      finalMessageOnly: false,
    });

    expect(code).toBe(ExitCode.RETRYABLE);
  });

  it('should return SUCCESS when no prompt and no stdin (text mode)', async () => {
    const events: WireMessage[] = [];
    const client = createMockWireClient(events);

    // Simulate TTY stdin (no pipe)
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    try {
      const code = await runPrintMode({
        wireClient: client,
        sessionId: 'sess_1',
        prompt: undefined,
        inputFormat: 'text',
        outputFormat: 'text',
        finalMessageOnly: false,
      });

      expect(code).toBe(ExitCode.SUCCESS);
      expect(client.prompt).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
    }
  });

  it('should use stream-json output format', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const events = [
      contentDelta('text', 'Hello'),
      turnEnd(true),
    ];
    const client = createMockWireClient(events);

    const code = await runPrintMode({
      wireClient: client,
      sessionId: 'sess_1',
      prompt: 'test',
      inputFormat: 'text',
      outputFormat: 'stream-json',
      finalMessageOnly: false,
    });

    expect(code).toBe(ExitCode.SUCCESS);
    const output = JSON.parse((writeSpy.mock.calls[0]![0] as string).trim());
    expect(output.role).toBe('assistant');
    expect(output.content).toEqual([{ type: 'text', text: 'Hello' }]);
    writeSpy.mockRestore();
  });

  it('should use final-message-only mode', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const events = [
      stepBegin(1),
      contentDelta('text', 'first step'),
      stepBegin(2),
      contentDelta('text', 'final answer'),
      turnEnd(true),
    ];
    const client = createMockWireClient(events);

    const code = await runPrintMode({
      wireClient: client,
      sessionId: 'sess_1',
      prompt: 'test',
      inputFormat: 'text',
      outputFormat: 'text',
      finalMessageOnly: true,
    });

    expect(code).toBe(ExitCode.SUCCESS);
    expect(writeSpy).toHaveBeenCalledWith('final answer\n');
    writeSpy.mockRestore();
  });
});
