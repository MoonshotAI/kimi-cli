/**
 * NotificationManager replay + extractDeliveredIds
 * (Slice 5.2 T3.1+T3.6, adapted for Phase 1 — Decision #89).
 *
 * Phase 1 removed `replayPendingForResume` — notifications are now
 * durable entries in ContextState history. Replay naturally rebuilds
 * them from wire.jsonl via the replay-projector's initialHistory, so
 * there is no need for a separate ephemeral re-inject path.
 *
 * The `extractDeliveredIds` tests are preserved (the utility is still
 * used by downstream replay code).
 */

import { describe, expect, it, vi } from 'vitest';

import { NotificationManager } from '../../src/soul-plus/notification-manager.js';
import type { NotificationRecord } from '../../src/storage/wire-record.js';

type NotifData = NotificationRecord['data'];

function makeManagerStub(): NotificationManager {
  return new NotificationManager({
    sessionJournal: { appendNotification: vi.fn() } as never,
    sessionEventBus: { emitNotification: vi.fn() } as never,
    onEmittedToLlm: vi.fn(),
  });
}

// Phase 1 (Decision #89): replayPendingForResume tests removed.
// Notifications are durable — replay naturally reconstructs them from
// wire.jsonl via the replay-projector's initialHistory. The old tests
// verified ephemeral re-inject behavior that no longer exists.
describe('NotificationManager replay — Phase 1 removal notes', () => {
  it('replayPendingForResume no longer exists (Phase 1)', () => {
    const mgr = makeManagerStub();
    expect((mgr as unknown as Record<string, unknown>)['replayPendingForResume']).toBeUndefined();
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
