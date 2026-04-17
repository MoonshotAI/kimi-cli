/**
 * Slice 6.1 — Notification × Background Task integration tests.
 *
 * Three feature areas:
 *   1. BPM lifecycle → NotificationManager.emit() on terminal state
 *   2. renderNotificationXml includes `<task-notification>` block with
 *      output tail when source_kind='background_task'
 *   3. NotificationManager.hasPendingForLlm() query
 *
 * All tests are RED — implementation does not exist yet.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  NotificationManager,
  SessionEventBus,
  type NotificationData,
} from '../../src/soul-plus/index.js';
import { InMemorySessionJournalImpl } from '../../src/storage/session-journal.js';
import { BackgroundProcessManager } from '../../src/tools/background/manager.js';
import {
  DefaultConversationProjector,
  type EphemeralInjection,
} from '../../src/storage/projector.js';

// ── Helpers ─────────────────────────────────────────────────────────────

/** Minimal NotificationManager wired to capture LLM sink pushes. */
function createNotificationManager(overrides?: {
  onEmittedToLlm?: (n: NotificationData) => void;
}) {
  const journal = new InMemorySessionJournalImpl();
  const eventBus = new SessionEventBus();
  const llmSink: NotificationData[] = [];
  const manager = new NotificationManager({
    sessionJournal: journal,
    sessionEventBus: eventBus,
    onEmittedToLlm: overrides?.onEmittedToLlm ?? ((n) => llmSink.push(n)),
    logger: () => {
      /* swallow */
    },
  });
  return { manager, journal, eventBus, llmSink };
}

/**
 * Fake KaosProcess that resolves/rejects on demand.
 * We expose `resolve(exitCode)` and `reject(err)` handles so the test
 * can drive lifecycle transitions deterministically.
 */
function createFakeProcess() {
  let resolveWait!: (exitCode: number) => void;
  let rejectWait!: (err: Error) => void;
  const waitPromise = new Promise<number>((res, rej) => {
    resolveWait = res;
    rejectWait = rej;
  });
  const proc = {
    pid: 12345,
    exitCode: null as number | null,
    stdin: { write: () => false, end: () => {} },
    stdout: { setEncoding: () => {}, on: vi.fn() },
    stderr: { setEncoding: () => {}, on: vi.fn() },
    wait: () => waitPromise,
    kill: vi.fn(async () => {}),
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  return { proc, resolve: resolveWait, reject: rejectWait };
}

/** Wait a tick so lifecycle `.finally()` callbacks run. */
const tick = () => new Promise<void>((r) => setTimeout(r, 20));

// ═══════════════════════════════════════════════════════════════════════
// 1. BPM lifecycle → NotificationManager.emit()
// ═══════════════════════════════════════════════════════════════════════

describe('BPM → NotificationManager emit on terminal state (Slice 6.1)', () => {
  it('emits category=task, type=task.completed when a process completes successfully', async () => {
    const { manager: nm, llmSink } = createNotificationManager();
    const bpm = new BackgroundProcessManager();
    // Wire BPM's lifecycle notification callback to NotificationManager.
    // This is the integration point Slice 6.1 adds:
    bpm.onTerminal(async (info) => {
      await nm.emit({
        category: 'task',
        type: `task.${info.status}`,
        source_kind: 'background_task',
        source_id: info.taskId,
        title: `Task ${info.status}`,
        body: `Task ${info.taskId}: ${info.description}`,
        severity: info.status === 'completed' ? 'success' : 'error',
        dedupe_key: `background_task:${info.taskId}:${info.status}`,
      });
    });

    const { proc, resolve } = createFakeProcess();
    bpm.register(proc, 'echo hello', 'test task');
    resolve(0);
    await tick();

    expect(llmSink).toHaveLength(1);
    expect(llmSink[0]!.category).toBe('task');
    expect(llmSink[0]!.type).toBe('task.completed');
    expect(llmSink[0]!.source_kind).toBe('background_task');
    expect(llmSink[0]!.severity).toBe('success');
  });

  it('emits severity=error when a process fails', async () => {
    const { manager: nm, llmSink } = createNotificationManager();
    const bpm = new BackgroundProcessManager();
    bpm.onTerminal(async (info) => {
      const severityMap: Record<string, 'success' | 'warning' | 'error'> = {
        completed: 'success',
        failed: 'error',
        killed: 'warning',
        lost: 'warning',
      };
      await nm.emit({
        category: 'task',
        type: `task.${info.status}`,
        source_kind: 'background_task',
        source_id: info.taskId,
        title: `Task ${info.status}`,
        body: `Task ${info.taskId}: ${info.description}`,
        severity: severityMap[info.status] ?? 'error',
        dedupe_key: `background_task:${info.taskId}:${info.status}`,
      });
    });

    const { proc, resolve } = createFakeProcess();
    bpm.register(proc, 'exit 1', 'failing task');
    resolve(1); // non-zero → failed
    await tick();

    expect(llmSink).toHaveLength(1);
    expect(llmSink[0]!.severity).toBe('error');
    expect(llmSink[0]!.type).toBe('task.failed');
  });

  it('emits severity=warning when a process is killed', async () => {
    const { manager: nm, llmSink } = createNotificationManager();
    const bpm = new BackgroundProcessManager();
    bpm.onTerminal(async (info) => {
      const severityMap: Record<string, 'success' | 'warning' | 'error'> = {
        completed: 'success',
        failed: 'error',
        killed: 'warning',
        lost: 'warning',
      };
      await nm.emit({
        category: 'task',
        type: `task.${info.status}`,
        source_kind: 'background_task',
        source_id: info.taskId,
        title: `Task ${info.status}`,
        body: `Task ${info.taskId}: ${info.description}`,
        severity: severityMap[info.status] ?? 'error',
        dedupe_key: `background_task:${info.taskId}:${info.status}`,
      });
    });

    const { proc, resolve } = createFakeProcess();
    const taskId = bpm.register(proc, 'sleep 999', 'long task');
    // Stop (kill) the task, then let it exit
    void bpm.stop(taskId);
    resolve(137);
    await tick();

    expect(llmSink).toHaveLength(1);
    expect(llmSink[0]!.severity).toBe('warning');
    expect(llmSink[0]!.type).toBe('task.killed');
  });

  it('dedupes: same task + same terminal status emits only one notification', async () => {
    const { manager: nm, llmSink } = createNotificationManager();
    const bpm = new BackgroundProcessManager();
    bpm.onTerminal(async (info) => {
      await nm.emit({
        category: 'task',
        type: `task.${info.status}`,
        source_kind: 'background_task',
        source_id: info.taskId,
        title: `Task ${info.status}`,
        body: `Task ${info.taskId}: ${info.description}`,
        severity: 'success',
        dedupe_key: `background_task:${info.taskId}:${info.status}`,
      });
    });

    const { proc, resolve } = createFakeProcess();
    bpm.register(proc, 'echo ok', 'dup test');
    resolve(0);
    await tick();

    // Manually call onTerminal again for the same task to simulate duplicate
    // The dedupe_key in NotificationManager should prevent a second emit.
    const info = bpm.getTask(
      [...(bpm as any).processes.keys()][0]!,
    )!;
    await nm.emit({
      category: 'task',
      type: `task.${info.status}`,
      source_kind: 'background_task',
      source_id: info.taskId,
      title: `Task ${info.status}`,
      body: `Task ${info.taskId}: ${info.description}`,
      severity: 'success',
      dedupe_key: `background_task:${info.taskId}:${info.status}`,
    });

    // Only the first should have been delivered to LLM
    expect(llmSink).toHaveLength(1);
  });

  it('notification body contains task_id, status, and description', async () => {
    const { manager: nm, llmSink } = createNotificationManager();
    const bpm = new BackgroundProcessManager();
    bpm.onTerminal(async (info) => {
      await nm.emit({
        category: 'task',
        type: `task.${info.status}`,
        source_kind: 'background_task',
        source_id: info.taskId,
        title: `Task ${info.status}`,
        body: [
          `Task ID: ${info.taskId}`,
          `Status: ${info.status}`,
          `Description: ${info.description}`,
        ].join('\n'),
        severity: 'success',
        dedupe_key: `background_task:${info.taskId}:${info.status}`,
      });
    });

    const { proc, resolve } = createFakeProcess();
    bpm.register(proc, 'make build', 'build project');
    resolve(0);
    await tick();

    expect(llmSink).toHaveLength(1);
    const body = llmSink[0]!.body;
    expect(body).toContain('Task ID:');
    expect(body).toContain('Status: completed');
    expect(body).toContain('Description: build project');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. renderNotificationXml — <task-notification> block with output tail
// ═══════════════════════════════════════════════════════════════════════

describe('renderNotificationXml — task-notification tail output (Slice 6.1)', () => {
  const projector = new DefaultConversationProjector();

  /**
   * Project a pending_notification injection through the public
   * projector path and return the rendered text.
   */
  function renderViaProjector(data: Record<string, unknown>): string {
    const injection: EphemeralInjection = {
      kind: 'pending_notification',
      content: data,
    };
    const snapshot = {
      history: [],
      systemPrompt: '',
      model: 'test',
      activeTools: new Set<string>(),
    };
    const messages = projector.project(snapshot, [injection], {});
    expect(messages).toHaveLength(1);
    const text = messages[0]!.content
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text)
      .join('');
    return text;
  }

  it('includes <task-notification> block when source_kind=background_task', () => {
    const text = renderViaProjector({
      id: 'n_test1',
      category: 'task',
      type: 'task.completed',
      source_kind: 'background_task',
      source_id: 'bg_abc',
      title: 'Task completed',
      body: 'Build finished successfully',
      severity: 'success',
      // Slice 6.1 adds: tail_output attached by the renderer
      tail_output: 'line 1\nline 2\nline 3',
    });

    expect(text).toContain('<task-notification>');
    expect(text).toContain('</task-notification>');
    expect(text).toContain('line 1');
    expect(text).toContain('line 3');
  });

  it('truncates tail output to 20 lines', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `output line ${i + 1}`);
    const text = renderViaProjector({
      id: 'n_trunc_lines',
      category: 'task',
      type: 'task.completed',
      source_kind: 'background_task',
      source_id: 'bg_xyz',
      title: 'Done',
      body: 'OK',
      severity: 'success',
      tail_output: lines.join('\n'),
    });

    expect(text).toContain('<task-notification>');
    // Last 20 lines should be present
    expect(text).toContain('output line 50');
    expect(text).toContain('output line 31');
    // Line 30 (the 21st from the end) should NOT be present
    expect(text).not.toContain('output line 30');
  });

  it('truncates tail output to 3000 characters', () => {
    // Each line ~100 chars, 10 lines = 1000 chars. 40 lines = 4000 chars.
    const lines = Array.from({ length: 10 }, (_, i) =>
      `line ${i + 1}: ${'x'.repeat(90)}`,
    );
    // Total ≈ 10 × 100 = 1000. Build to exceed 3000:
    const longLines = Array.from({ length: 40 }, (_, i) =>
      `line ${i + 1}: ${'A'.repeat(90)}`,
    );
    const text = renderViaProjector({
      id: 'n_trunc_chars',
      category: 'task',
      type: 'task.completed',
      source_kind: 'background_task',
      source_id: 'bg_big',
      title: 'Big output',
      body: 'done',
      severity: 'success',
      tail_output: longLines.join('\n'),
    });

    expect(text).toContain('<task-notification>');
    // The tail portion within <task-notification> should be ≤ 3000 chars
    const taskNotifMatch = text.match(
      /<task-notification>([\s\S]*?)<\/task-notification>/,
    );
    expect(taskNotifMatch).not.toBeNull();
    const tailContent = taskNotifMatch![1]!;
    // The output tail within the block should respect the 3000 char limit
    expect(tailContent.length).toBeLessThanOrEqual(3200); // small margin for labels
  });

  it('does NOT include <task-notification> for non-task notifications', () => {
    const text = renderViaProjector({
      id: 'n_system',
      category: 'system',
      type: 'system.info',
      source_kind: 'system',
      source_id: 'sys_1',
      title: 'System notice',
      body: 'Something happened',
      severity: 'info',
    });

    expect(text).not.toContain('<task-notification>');
  });

  it('does NOT include <task-notification> when source_kind is not background_task', () => {
    const text = renderViaProjector({
      id: 'n_agent',
      category: 'task',
      type: 'task.completed',
      source_kind: 'agent',
      source_id: 'agent_1',
      title: 'Agent done',
      body: 'Agent finished',
      severity: 'success',
      tail_output: 'some output',
    });

    expect(text).not.toContain('<task-notification>');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. NotificationManager durable LLM path (Phase 1 — Decision #89)
//
// Phase 1 removed hasPendingForLlm / markLlmDrained / pendingLlmCount.
// Notifications are now written durably to contextState.appendNotification
// instead of being buffered as pending ephemeral injections.
// ═══════════════════════════════════════════════════════════════════════

describe('NotificationManager — durable LLM path (Phase 1)', () => {
  it('notification with llm target writes to contextState.appendNotification', async () => {
    const appendCalls: NotificationData[] = [];
    const fakeContextState = {
      appendNotification: async (data: NotificationData) => {
        appendCalls.push(data);
      },
    };
    const journal = new InMemorySessionJournalImpl();
    const eventBus = new SessionEventBus();
    const manager = new NotificationManager({
      sessionJournal: journal,
      sessionEventBus: eventBus,
      contextState: fakeContextState,
    } as unknown as ConstructorParameters<typeof NotificationManager>[0]);

    await manager.emit({
      category: 'task',
      type: 'task.completed',
      source_kind: 'background_task',
      source_id: 'bg_1',
      title: 'Done',
      body: 'OK',
      severity: 'success',
    });

    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]!.title).toBe('Done');
  });

  it('notification without llm target does NOT write to contextState', async () => {
    const appendCalls: NotificationData[] = [];
    const fakeContextState = {
      appendNotification: async (data: NotificationData) => {
        appendCalls.push(data);
      },
    };
    const journal = new InMemorySessionJournalImpl();
    const eventBus = new SessionEventBus();
    const manager = new NotificationManager({
      sessionJournal: journal,
      sessionEventBus: eventBus,
      contextState: fakeContextState,
    } as unknown as ConstructorParameters<typeof NotificationManager>[0]);

    await manager.emit({
      category: 'task',
      type: 'task.completed',
      source_kind: 'background_task',
      source_id: 'bg_3',
      title: 'Wire only',
      body: 'OK',
      severity: 'info',
      targets: ['wire'],
    });

    // No LLM target → contextState.appendNotification not called
    expect(appendCalls).toHaveLength(0);
  });

  it('multiple LLM notifications produce multiple durable writes', async () => {
    const appendCalls: NotificationData[] = [];
    const fakeContextState = {
      appendNotification: async (data: NotificationData) => {
        appendCalls.push(data);
      },
    };
    const journal = new InMemorySessionJournalImpl();
    const eventBus = new SessionEventBus();
    const manager = new NotificationManager({
      sessionJournal: journal,
      sessionEventBus: eventBus,
      contextState: fakeContextState,
    } as unknown as ConstructorParameters<typeof NotificationManager>[0]);

    await manager.emit({
      category: 'task',
      type: 'task.completed',
      source_kind: 'background_task',
      source_id: 'bg_a',
      title: 'First',
      body: 'OK',
      severity: 'success',
    });
    await manager.emit({
      category: 'task',
      type: 'task.completed',
      source_kind: 'background_task',
      source_id: 'bg_b',
      title: 'Second',
      body: 'OK',
      severity: 'info',
    });

    expect(appendCalls).toHaveLength(2);
    expect(appendCalls[0]!.title).toBe('First');
    expect(appendCalls[1]!.title).toBe('Second');
  });

  it('falls back to onEmittedToLlm when contextState is absent (backward compat)', async () => {
    const llmSink: NotificationData[] = [];
    const { manager } = createNotificationManager({
      onEmittedToLlm: (n) => llmSink.push(n),
    });

    await manager.emit({
      category: 'task',
      type: 'task.completed',
      source_kind: 'background_task',
      source_id: 'bg_4',
      title: 'Legacy path',
      body: 'OK',
      severity: 'success',
    });

    expect(llmSink).toHaveLength(1);
    expect(llmSink[0]!.title).toBe('Legacy path');
  });
});
