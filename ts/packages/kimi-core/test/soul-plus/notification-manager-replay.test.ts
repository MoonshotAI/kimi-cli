/**
 * NotificationManager.replayPendingForResume + extractDeliveredIds
 * (Slice 5.2 T3.1+T3.6).
 */

import { describe, expect, it, vi } from 'vitest';

import { NotificationManager } from '../../src/soul-plus/notification-manager.js';
import type { EphemeralInjection } from '../../src/storage/projector.js';
import type { NotificationRecord } from '../../src/storage/wire-record.js';

type NotifData = NotificationRecord['data'];

function notif(
  id: string,
  overrides: Partial<NotifData> = {},
): NotificationRecord {
  return {
    type: 'notification',
    seq: 1,
    time: 1,
    data: {
      id,
      category: 'system',
      type: 'info',
      source_kind: 'system',
      source_id: 'test',
      title: `t-${id}`,
      body: `b-${id}`,
      severity: 'info',
      targets: ['llm', 'wire', 'shell'],
      ...overrides,
    },
  };
}

function makeManagerStub(): NotificationManager {
  return new NotificationManager({
    sessionJournal: { appendNotification: vi.fn() } as never,
    sessionEventBus: { emitNotification: vi.fn() } as never,
    onEmittedToLlm: vi.fn(),
  });
}

class StashCapture {
  injected: EphemeralInjection[] = [];
  stashEphemeralInjection(injection: EphemeralInjection): void {
    this.injected.push(injection);
  }
}

describe('NotificationManager.replayPendingForResume', () => {
  it('injects llm-target notifications not yet delivered', () => {
    const mgr = makeManagerStub();
    const records = [
      notif('n_1', { targets: ['llm', 'shell'] }),
      notif('n_2', { targets: ['wire'] }),  // not llm — skip
      notif('n_3'),  // default targets include llm
    ];
    const capture = new StashCapture();
    const out = mgr.replayPendingForResume(records, capture, new Set());
    expect(out).toHaveLength(2);
    expect(out.map((i) => (i.content as NotifData).id).sort()).toEqual(['n_1', 'n_3']);
    expect(capture.injected).toHaveLength(2);
  });

  it('skips notifications already delivered (id present in deliveredIds)', () => {
    const mgr = makeManagerStub();
    const records = [
      notif('n_already', { targets: ['llm'] }),
      notif('n_pending', { targets: ['llm'] }),
    ];
    const capture = new StashCapture();
    const out = mgr.replayPendingForResume(records, capture, new Set(['n_already']));
    expect(out.map((i) => (i.content as NotifData).id)).toEqual(['n_pending']);
  });

  it('produces pending_notification injections (kind + content)', () => {
    const mgr = makeManagerStub();
    const records = [notif('n_x')];
    const capture = new StashCapture();
    mgr.replayPendingForResume(records, capture, new Set());
    expect(capture.injected[0]).toMatchObject({
      kind: 'pending_notification',
      content: expect.objectContaining({ id: 'n_x' }),
    });
  });

  it('returns empty when records list is empty', () => {
    const mgr = makeManagerStub();
    expect(mgr.replayPendingForResume([], new StashCapture(), new Set())).toEqual([]);
  });
});

describe('NotificationManager.extractDeliveredIds', () => {
  it('extracts ids from string content', () => {
    const messages = [
      { content: 'hello <notification id="n_a" foo="bar">body</notification> world' },
      { content: 'no notifications here' },
      { content: '<notification id="n_b">x</notification><notification id="n_c">y</notification>' },
    ];
    const ids = NotificationManager.extractDeliveredIds(messages);
    expect([...ids].sort()).toEqual(['n_a', 'n_b', 'n_c']);
  });

  it('extracts ids from array-of-parts content', () => {
    const messages = [
      {
        content: [
          { type: 'text', text: '<notification id="n_array_1">x</notification>' },
          { type: 'text', text: 'plain text' },
          { type: 'text', text: '<notification id="n_array_2">y</notification>' },
        ],
      },
    ];
    const ids = NotificationManager.extractDeliveredIds(messages);
    expect([...ids].sort()).toEqual(['n_array_1', 'n_array_2']);
  });

  it('returns empty set for empty messages', () => {
    expect(NotificationManager.extractDeliveredIds([]).size).toBe(0);
  });

  it('ignores malformed notification tags', () => {
    const messages = [
      { content: '<notification>missing id</notification>' },
      { content: '<notify id="n_wrong_tag">x</notify>' },
    ];
    expect(NotificationManager.extractDeliveredIds(messages).size).toBe(0);
  });
});
