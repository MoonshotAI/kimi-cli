/**
 * Phase 17 A.4 — wire error-mapping central table.
 *
 * `src/wire-protocol/error-mapping.ts::mapToWireError(err): WireError`
 * is the new single source of truth that both the production
 * `apps/kimi-cli --wire` frame loop and the in-memory harness
 * `onMessage` share to map thrown errors onto JSON-RPC style codes.
 *
 * Coverage:
 *   - -32700 Parse error   → WireCodec decode failure
 *   - -32600 Invalid request → WireMessageSchema envelope rejection
 *   - -32602 Invalid params  → zod params schema reject at handler entry
 *   - Boundary: request_id falls back to null when frame unparseable
 *   - Boundary: nested parse error bubbles up wrapped (cause chain)
 *   - Boundary: zod error.issues preserved in `details`
 *
 * Expected state before implementer: import fails because
 * `src/wire-protocol/error-mapping.ts` does not exist yet.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  mapToWireError,
  type WireErrorMapping,
} from '../../src/wire-protocol/error-mapping.js';
import {
  InvalidWireEnvelopeError,
  MalformedWireFrameError,
} from '../../src/wire-protocol/errors.js';

describe('Phase 17 A.4 — mapToWireError', () => {
  it('-32700 Parse error: MalformedWireFrameError maps to -32700 with message containing "parse"', () => {
    const mapping: WireErrorMapping = mapToWireError(
      new MalformedWireFrameError('unexpected token'),
    );
    expect(mapping.error.code).toBe(-32700);
    expect(mapping.error.message.toLowerCase()).toMatch(/parse|json/);
    // Unparseable frames have no addressable request_id.
    expect(mapping.request_id).toBeNull();
  });

  it('-32600 Invalid request: InvalidWireEnvelopeError maps to -32600', () => {
    const mapping = mapToWireError(new InvalidWireEnvelopeError('missing type'));
    expect(mapping.error.code).toBe(-32600);
    expect(mapping.error.message.toLowerCase()).toMatch(/invalid|request/);
  });

  it('-32602 Invalid params: zod parse failure maps to -32602 and preserves issues in details', () => {
    const schema = z.object({ input: z.string() });
    const parsed = schema.safeParse({ input: 42 });
    expect(parsed.success).toBe(false);
    const mapping = mapToWireError(parsed.error!);
    expect(mapping.error.code).toBe(-32602);
    expect(mapping.error.message.toLowerCase()).toMatch(/invalid\s*params/);
    // `details` must surface the zod `issues` array for client
    // diagnostics — without it clients cannot point the user at the
    // offending field.
    const details = mapping.error.details as { issues?: readonly unknown[] };
    expect(details).toBeDefined();
    expect(Array.isArray(details.issues)).toBe(true);
    expect(details.issues!.length).toBeGreaterThan(0);
  });

  it('boundary: request_id is null for codec-level failures (no frame parsed)', () => {
    const mapping = mapToWireError(new MalformedWireFrameError('oops'));
    expect(mapping.request_id).toBeNull();
  });

  it('boundary: non-wire Error falls back to -32603 Internal error', () => {
    const mapping = mapToWireError(new Error('boom'));
    expect(mapping.error.code).toBe(-32603);
    expect(mapping.error.message.toLowerCase()).toMatch(/internal|error/);
  });

  it('boundary: nested zod error issues path survives (e.g. input.0.text)', () => {
    const schema = z.object({
      parts: z.array(z.object({ type: z.literal('text'), text: z.string() })),
    });
    const parsed = schema.safeParse({ parts: [{ type: 'text', text: 7 }] });
    expect(parsed.success).toBe(false);
    const mapping = mapToWireError(parsed.error!);
    const details = mapping.error.details as { issues: Array<{ path: readonly unknown[] }> };
    const firstIssue = details.issues[0]!;
    expect(firstIssue.path).toEqual(expect.arrayContaining(['parts']));
  });
});
