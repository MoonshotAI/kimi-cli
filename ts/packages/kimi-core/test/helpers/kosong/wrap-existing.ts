/**
 * wrapExistingAdapter — bridge between a test-supplied `KosongAdapter`
 * and the `FakeKosongAdapter` exposed on `TestRuntimeBundle.kosong` /
 * `TestSessionBundle.kosong`.
 *
 * When the caller passes `new FakeKosongAdapter(...)` we use it
 * directly; when they pass their own adapter (mock provider, real
 * kosong binding, etc.) the bundle still exposes a `FakeKosongAdapter`
 * so tests can assert on `.calls`, `.callCount`, `lastSystemPrompt()`
 * etc. This module centralises the "wrap existing adapter" path so
 * both `create-test-runtime.ts` and `create-test-session.ts` stay in
 * sync (reviewed Round 1 M5).
 */

import type { KosongAdapter } from '../../../src/soul/runtime.js';

import { FakeKosongAdapter } from './fake-kosong-adapter.js';

/**
 * Wrap an existing adapter so it appears as a `FakeKosongAdapter` for
 * assertion purposes. `chat()` still delegates to the real adapter;
 * every call is also recorded on the wrapper's `calls` array so
 * `wrapper.callCount` / `wrapper.lastMessages()` etc. work as
 * expected.
 */
export function wrapExistingAsFake(adapter: KosongAdapter): FakeKosongAdapter {
  if (adapter instanceof FakeKosongAdapter) return adapter;

  const wrapper = new FakeKosongAdapter();
  const realChat = adapter.chat.bind(adapter);
  Object.defineProperty(wrapper, 'chat', {
    value: async (params: Parameters<KosongAdapter['chat']>[0]) => {
      // Call the official recording hook so `wrapper.calls` AND
      // `wrapper.callCount` stay in sync (Review Round 2 R2-2 —
      // previously only `calls` was updated, leaving `callCount` at 0).
      wrapper.recordCall(params);
      return realChat(params);
    },
    configurable: true,
    writable: true,
  });
  return wrapper;
}

/**
 * Given a value that is optionally a `FakeKosongAdapter`, resolve the
 * concrete `KosongAdapter` + `FakeKosongAdapter` pair for a bundle:
 *   - `undefined` → fresh `FakeKosongAdapter`
 *   - `FakeKosongAdapter` → reuse directly
 *   - other `KosongAdapter` → delegate + wrap for assertions
 */
export function resolveKosongPair(supplied?: KosongAdapter | FakeKosongAdapter): {
  readonly kosong: KosongAdapter;
  readonly fake: FakeKosongAdapter;
} {
  if (supplied === undefined) {
    const fake = new FakeKosongAdapter();
    return { kosong: fake, fake };
  }
  const fake = wrapExistingAsFake(supplied);
  // The wrapper delegates to `supplied`, so `supplied` is what Soul
  // should talk to (only when `supplied` is the FakeKosongAdapter
  // itself; otherwise `fake.chat` IS the wrapper that both records
  // and delegates, so that's the one Soul should use).
  return { kosong: fake, fake };
}
