/**
 * v2 SoulPlus barrel — **not** re-exported from `src/index.ts`.
 *
 * Slice 3 keeps SoulPlus independent of the legacy top-level barrel, the
 * same way Slice 2 kept `src/soul/` independent. Slice 5 (Wire + Transport
 * + Router) will promote the v2 SoulPlus stack into `src/index.ts` and
 * retire the `-legacy` directories.
 */

export type {
  DispatchRequest,
  DispatchResponse,
  SessionLifecycleState,
  SoulHandle,
  SoulKey,
  SoulPlusConfig,
  TurnTrigger,
} from './types.js';

export { SessionLifecycleStateMachine } from './lifecycle-state-machine.js';
export { LifecycleGateFacade } from './lifecycle-gate.js';
export { KosongAdapter, createKosongAdapter } from './kosong-adapter.js';
export type { KosongAdapterOptions } from './kosong-adapter.js';
export { SessionEventBus } from './session-event-bus.js';
export type { SessionEventListener } from './session-event-bus.js';
export { SoulRegistry } from './soul-registry.js';
export type { SoulRegistryDeps } from './soul-registry.js';
export {
  createRuntime,
  createStubCompactionProvider,
  createStubJournalCapability,
} from './runtime-factory.js';
export type { RuntimeFactoryDeps } from './runtime-factory.js';
export { TurnManager } from './turn-manager.js';
export type { TurnManagerDeps, TurnState } from './turn-manager.js';
export { SoulPlus } from './soul-plus.js';
export type { SoulPlusDeps } from './soul-plus.js';
export { TransactionalHandlerRegistry } from './transactional-handler-registry.js';
export type { TransactionalHandler } from './transactional-handler-registry.js';
