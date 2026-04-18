/**
 * Slice 20-B R-2 — `hooks.configured` schema alignment.
 *
 * Red-bar driver for the `hooks.configured[*].matcher` type pollution
 * exposed by `pnpm run check`: the wire initialize handler currently
 * feeds `matcher: {} | null | unknown` through a `as` cast to the
 * declared `{matcher?: string}` shape, so the handler quietly breaks the
 * contract instead of normalising inputs.
 *
 * Phase 20 §B.2 fixes this by **tightening the handler** (not the
 * schema) — only `matcher: string` with `length > 0` flows through; any
 * other value drops the `matcher` key entirely. The assertions below
 * drive that tightening.
 *
 * These tests intentionally fail today:
 *   - current harness copies `matcher` verbatim (including `{}` / `null`
 *     / non-strings), so the "matcher absent when non-string" cases fail
 *     when the shape is inspected.
 *   - the `as` cast in default-handlers masks the runtime leak; the
 *     assertions here observe the response on the wire, bypassing the
 *     cast.
 *
 * After the R-2 fix:
 *   - `configured` entries contain `matcher` **iff** the caller passed a
 *     non-empty string,
 *   - the production type `InitializeResponseData.capabilities.hooks.
 *     configured[*].matcher` is narrowed to `string | undefined`,
 *   - the harness' `as` cast disappears (typecheck passes without it).
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  createWireE2EHarness,
  type WireE2EInMemoryHarness,
} from '../helpers/index.js';
import {
  createWireRequest,
} from '../../src/wire-protocol/message-factory.js';
import {
  PROCESS_SESSION_ID,
  WIRE_PROTOCOL_VERSION,
  type InitializeResponseData,
  type WireMessage,
} from '../../src/wire-protocol/types.js';

let harness: WireE2EInMemoryHarness | undefined;

afterEach(async () => {
  if (harness !== undefined) {
    await harness.dispose();
    harness = undefined;
  }
});

// Thin helper — the canonical `buildInitializeRequest` helper only
// accepts typed `capabilities` / `external_tools` fields. Because R-2
// drives the handler to *normalise* arbitrary matcher values, we need
// to construct a request whose `data.hooks` is deliberately loose so we
// can feed `null` / `{}` / `""` / non-string objects through.
function buildInitializeWithHooks(
  hooks: ReadonlyArray<{ event: string; matcher?: unknown; id?: string }>,
): WireMessage {
  return createWireRequest({
    method: 'initialize',
    sessionId: PROCESS_SESSION_ID,
    data: {
      protocol_version: WIRE_PROTOCOL_VERSION,
      hooks,
    },
  });
}

interface ConfiguredEntry {
  readonly event: string;
  readonly matcher?: unknown;
}

async function sendAndReadConfigured(
  hooks: ReadonlyArray<{ event: string; matcher?: unknown; id?: string }>,
): Promise<readonly ConfiguredEntry[]> {
  harness = await createWireE2EHarness();
  const req = buildInitializeWithHooks(hooks);
  await harness.send(req);
  const { response } = await harness.collectUntilResponse(req.id);
  const data = response.data as {
    capabilities?: {
      hooks?: {
        configured?: readonly ConfiguredEntry[];
      };
    };
  };
  const configured = data.capabilities?.hooks?.configured;
  if (configured === undefined) {
    throw new Error('initialize response missing capabilities.hooks.configured');
  }
  return configured;
}

describe('Phase 20 R-2 — hooks.configured matcher normalisation', () => {
  it('includes `matcher` when caller passes a non-empty string', async () => {
    const configured = await sendAndReadConfigured([
      { id: 'h1', event: 'PreToolUse', matcher: 'Bash' },
    ]);
    expect(configured).toHaveLength(1);
    expect(configured[0]).toEqual({ event: 'PreToolUse', matcher: 'Bash' });
    expect(configured[0]!.matcher).toBe('Bash');
  });

  it('drops the `matcher` key when caller passes no matcher at all', async () => {
    const configured = await sendAndReadConfigured([
      { id: 'h1', event: 'Stop' },
    ]);
    expect(configured).toHaveLength(1);
    expect(configured[0]!.event).toBe('Stop');
    // Key must be absent, not `undefined` — the tightened shape says
    // `matcher?: string` (exactOptionalPropertyTypes), so an
    // `{matcher: undefined}` emission still leaks the looseness.
    expect(Object.hasOwn(configured[0]!, 'matcher')).toBe(false);
  });

  it('drops the `matcher` key for an empty string matcher', async () => {
    const configured = await sendAndReadConfigured([
      { id: 'h1', event: 'PreToolUse', matcher: '' },
    ]);
    expect(configured).toHaveLength(1);
    expect(Object.hasOwn(configured[0]!, 'matcher')).toBe(false);
  });

  it('drops the `matcher` key when caller passes a plain object ({})', async () => {
    const configured = await sendAndReadConfigured([
      { id: 'h1', event: 'PreToolUse', matcher: {} },
    ]);
    expect(configured).toHaveLength(1);
    // The current harness copies {} verbatim — this assertion is the
    // red bar that pins the fix.
    expect(Object.hasOwn(configured[0]!, 'matcher')).toBe(false);
  });

  it('drops the `matcher` key when caller passes null', async () => {
    const configured = await sendAndReadConfigured([
      { id: 'h1', event: 'PreToolUse', matcher: null },
    ]);
    expect(configured).toHaveLength(1);
    expect(Object.hasOwn(configured[0]!, 'matcher')).toBe(false);
  });

  it('normalises a mixed batch end-to-end', async () => {
    const configured = await sendAndReadConfigured([
      { id: 'a', event: 'PreToolUse', matcher: 'Bash' },
      { id: 'b', event: 'PostToolUse', matcher: '' },
      { id: 'c', event: 'Stop' },
      { id: 'd', event: 'Notification', matcher: {} },
      { id: 'e', event: 'PreToolUse', matcher: 'Write' },
    ]);
    expect(configured).toHaveLength(5);

    // Only the two string matchers survive with their `matcher` field.
    const withMatcher = configured.filter((c) =>
      Object.hasOwn(c, 'matcher'),
    );
    expect(withMatcher.map((c) => c.matcher)).toEqual(['Bash', 'Write']);

    // Every surviving matcher is a string.
    for (const entry of withMatcher) {
      expect(typeof entry.matcher).toBe('string');
    }
  });
});

// ── Compile-time shape assertion ───────────────────────────────────────
//
// Post-R-2, `InitializeResponseData.capabilities.hooks.configured[*]`
// is `{ event: string; matcher?: string | undefined }`. This type-level
// sentinel locks the shape so the cast in
// `test/helpers/wire/default-handlers.ts` can be removed. Body never
// runs; TS evaluates at compile time.

function _narrowMatcherShape(r: InitializeResponseData): void {
  const sample: { readonly event: string; readonly matcher?: string | undefined } =
    r.capabilities.hooks.configured[0]!;
  void sample;
}
void _narrowMatcherShape;
