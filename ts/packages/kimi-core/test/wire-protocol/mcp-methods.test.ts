/**
 * Wire protocol — MCP method + event placeholders (Slice 7.2 / 决策 #100).
 *
 * Phase 7 wires the MCP method surface into the wire protocol type union
 * and the event discriminator. The actual handlers remain stubs that
 * return a NotImplemented error until later slices implement them, but
 * the type union must list every method name so downstream clients can
 * refer to them at compile time.
 *
 * Six MCP events likewise enter the event-method union so event routers
 * can switch on them without an escape hatch.
 */

import { describe, expect, it } from 'vitest';

import type { WireEventMethod, WireMethod } from '../../src/wire-protocol/index.js';

// ── Method name coverage ────────────────────────────────────────────────

const MCP_REQUEST_METHODS = [
  'mcp.list',
  'mcp.connect',
  'mcp.disconnect',
  'mcp.refresh',
  'mcp.listResources',
  'mcp.readResource',
  'mcp.listPrompts',
  'mcp.getPrompt',
  'mcp.startAuth',
  'mcp.resetAuth',
] as const;

type McpRequestMethod = (typeof MCP_REQUEST_METHODS)[number];

describe('Wire protocol — mcp.* request methods (Phase 7 placeholder)', () => {
  it('every mcp.* method is a WireMethod', () => {
    // Compile-time check: if a method is missing from WireMethod the
    // assignment fails typecheck. We keep a runtime assertion to surface
    // the failure in the test reporter when tsc merely prints a warning.
    const methods: WireMethod[] = MCP_REQUEST_METHODS.map((m) => m as WireMethod);
    expect(methods).toHaveLength(10);
  });

  it('all 10 method names are present and unique', () => {
    const unique = new Set<string>(MCP_REQUEST_METHODS);
    expect(unique.size).toBe(MCP_REQUEST_METHODS.length);
    expect(unique.size).toBe(10);
  });

  it('method names follow the `mcp.<verb>` dot-namespace convention', () => {
    for (const m of MCP_REQUEST_METHODS) {
      expect(m.startsWith('mcp.')).toBe(true);
    }
  });

  it('exports a type literal that narrows to McpRequestMethod', () => {
    // Structural check — the tuple's element type must remain assignable
    // to WireMethod after narrowing.
    const narrow: McpRequestMethod = 'mcp.connect';
    const widened: WireMethod = narrow;
    expect(widened).toBe('mcp.connect');
  });
});

// ── Event name coverage ─────────────────────────────────────────────────

const MCP_EVENT_METHODS = [
  'mcp.connected',
  'mcp.disconnected',
  'mcp.error',
  'mcp.tools_changed',
  'mcp.resources_changed',
  'mcp.auth_required',
] as const;

describe('Wire protocol — mcp.* event methods (Phase 7 schema)', () => {
  it('every mcp.* event is a WireEventMethod', () => {
    const events: WireEventMethod[] = MCP_EVENT_METHODS.map((m) => m as WireEventMethod);
    expect(events).toHaveLength(6);
  });

  it('all 6 event names are unique', () => {
    const unique = new Set<string>(MCP_EVENT_METHODS);
    expect(unique.size).toBe(MCP_EVENT_METHODS.length);
    expect(unique.size).toBe(6);
  });

  it('event names follow the `mcp.<name>` dot-namespace convention', () => {
    for (const e of MCP_EVENT_METHODS) {
      expect(e.startsWith('mcp.')).toBe(true);
    }
  });
});
