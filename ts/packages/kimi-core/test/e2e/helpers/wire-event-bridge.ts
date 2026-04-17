/**
 * Thin re-export shim — the real bridge lives at
 * `src/wire-protocol/event-bridge.ts` as of Phase 17 §A.1. E2E test code
 * still imports from this path, so we forward the public surface here.
 */

export {
  installWireEventBridge,
  type InstallWireEventBridgeOptions as InstallBridgeOptions,
  type WireEventBridgeHandle,
} from '../../../src/wire-protocol/event-bridge.js';
