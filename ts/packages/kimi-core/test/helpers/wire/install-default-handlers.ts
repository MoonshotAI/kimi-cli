/**
 * Test-only helper: lightweight standalone handler factory for MCP wire methods.
 *
 * Creates its own router and returns a single routing function
 * `(rawFrame: string) => Promise<string | undefined>`.
 *
 * Originally lived in `src/wire-protocol/default-handlers.ts` (Phase 24 Step
 * 4.7). Moved here per RR2-M-B so test-only code does not ship in the
 * production bundle. Only registers MCP methods; use
 * `registerDefaultWireHandlers` (production) for the full surface.
 */

import { RequestRouter } from '../../../src/router/request-router.js';
import type { SessionManager } from '../../../src/session/session-manager.js';
import type { McpRegistry } from '../../../src/soul-plus/mcp/registry.js';
import type { Transport } from '../../../src/transport/types.js';
import { WireCodec } from '../../../src/wire-protocol/codec.js';
import { createWireResponse } from '../../../src/wire-protocol/message-factory.js';
import type { WireMessage } from '../../../src/wire-protocol/types.js';

export function installDefaultHandlers(
  deps: { sessionManager: SessionManager; mcpRegistry?: McpRegistry | undefined },
): (raw: string) => Promise<string | undefined> {
  const codec = new WireCodec();
  const router = new RequestRouter({ sessionManager: deps.sessionManager });
  const { mcpRegistry } = deps;

  const mcpNoop = (data: unknown) =>
    async (msg: WireMessage): Promise<WireMessage> =>
      createWireResponse({ requestId: msg.id, sessionId: msg.session_id, data });

  router.registerProcessMethod('mcp.list', async (msg) => {
    const snap = mcpRegistry?.status() ?? { servers: [] };
    return createWireResponse({ requestId: msg.id, sessionId: msg.session_id, data: { servers: snap.servers } });
  });

  router.registerProcessMethod('mcp.refresh', async (msg) => {
    const data = msg.data as { server_id?: string } | undefined;
    if (mcpRegistry !== undefined && data?.server_id !== undefined) {
      await mcpRegistry.refresh(data.server_id);
    }
    return createWireResponse({ requestId: msg.id, sessionId: msg.session_id, data: { ok: true } });
  });

  router.registerProcessMethod('mcp.connect', mcpNoop({ ok: true }));
  router.registerProcessMethod('mcp.disconnect', mcpNoop({ ok: true }));
  router.registerProcessMethod('mcp.listResources', mcpNoop({ resources: [] }));
  router.registerProcessMethod('mcp.readResource', mcpNoop({ contents: [] }));
  router.registerProcessMethod('mcp.listPrompts', mcpNoop({ prompts: [] }));
  router.registerProcessMethod('mcp.getPrompt', mcpNoop({ messages: [] }));
  router.registerProcessMethod('mcp.startAuth', mcpNoop({ ok: true }));
  router.registerProcessMethod('mcp.resetAuth', mcpNoop({ ok: true }));

  const stubTransport: Transport = {
    state: 'connected',
    connect: async () => {},
    send: async () => {},
    close: async () => {},
    onConnect: null,
    onMessage: null,
    onClose: null,
    onError: null,
  };

  return async (raw: string): Promise<string | undefined> => {
    const msg = codec.decode(raw);
    try {
      const result = await router.dispatch(msg, stubTransport);
      return result !== undefined ? codec.encode(result as WireMessage) : undefined;
    } catch {
      return undefined;
    }
  };
}
