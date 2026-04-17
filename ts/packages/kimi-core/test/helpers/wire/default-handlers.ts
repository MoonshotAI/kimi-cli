/**
 * Thin re-export shim — the production handler registrations now
 * live at `src/wire-protocol/default-handlers.ts` as of Phase 17
 * §A.1 / §A.5. Both the in-memory harness and the production
 * `apps/kimi-cli --wire` runner share the same code path.
 */

export {
  registerDefaultWireHandlers,
  type DefaultHandlersDeps,
} from '../../../src/wire-protocol/default-handlers.js';
