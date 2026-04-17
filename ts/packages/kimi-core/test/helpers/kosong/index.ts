/**
 * Kosong helper barrel — lets `create-test-runtime` / `create-test-session`
 * pull `FakeKosongAdapter` + `resolveKosongPair` + related types through
 * a single import statement (keeps `max-dependencies` under budget).
 */

export {
  FakeKosongAdapter,
  createTextResponseAdapter,
  createToolCallAdapter,
  type AbortOnTurn,
  type FakeKosongAdapterOptions,
  type KosongErrorInjection,
  type ScriptedToolCall,
  type ScriptedStreaming,
  type ScriptedTurn,
} from './fake-kosong-adapter.js';
export { resolveDeltaChunks } from './script-builder.js';
export { resolveKosongPair, wrapExistingAsFake } from './wrap-existing.js';
