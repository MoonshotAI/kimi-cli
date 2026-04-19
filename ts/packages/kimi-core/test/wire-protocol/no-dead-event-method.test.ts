/**
 * Phase 24 T5 — Dead literal 'subagent.event' cleanup + WireEventMethod completeness.
 *
 * Decision D3 / §5.4: `'subagent.event'` must be fully eliminated from src/.
 * The actual event delivery mechanism for subagent internal events is the
 * source-envelope bubble (decided in §3.6.1 / 决策 #88), not a dedicated
 * 'subagent.event' wire method.
 *
 * Additionally, Phase 24 adds new WireEventMethod literals that must be
 * present for type-safe downstream consumers.
 *
 * Expected FAILURES with current implementation:
 *   - 'subagent.event' appears in src/ (types.ts:180 + default-handlers.ts:171) → FAILS
 *   - WireEventMethod union in types.ts contains 'subagent.event' → FAILS
 *   - WireEventMethod union missing skill.invoked/skill.completed/mcp.loading/
 *     status.update.mcp_status → FAILS (4 tests)
 *   - NOTE: subagent.spawned/.completed/.failed are Phase 25 scope — NOT tested here.
 *
 * Phase 24 Steps 3.3 / 4.2 / 5.4: Implementer must update types.ts + default-handlers.ts.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// ── Helpers ───────────────────────────────────────────────────────────────

const srcDir = join(import.meta.dirname, '../../src');

async function grepSrc(searchString: string, dir: string): Promise<string[]> {
  const hits: string[] = [];

  async function scanDir(d: string): Promise<void> {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(d, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const fullPath = join(d, entry.name);
        if (entry.isDirectory()) {
          await scanDir(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
          const content = await readFile(fullPath, 'utf8');
          content.split('\n').forEach((line, idx) => {
            const trimmed = line.trim();
            const isComment =
              trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
            if (!isComment && line.includes(searchString)) {
              hits.push(`${fullPath}:${String(idx + 1)}: ${line.trim()}`);
            }
          });
        }
      }),
    );
  }

  await scanDir(dir);
  return hits;
}

async function readTypesTs(): Promise<string> {
  return readFile(join(srcDir, 'wire-protocol/types.ts'), 'utf8');
}

// ── T5.1 — 'subagent.event' must be gone from src/ ─────────────────────

describe("Phase 24 T5 — 'subagent.event' dead literal elimination", () => {
  it("'subagent.event' must not appear as a live literal in any src/*.ts file", async () => {
    const hits = await grepSrc("'subagent.event'", srcDir);
    // Phase 24: expected 0 hits; current: 2 hits (types.ts:180 + default-handlers.ts:171) → FAILS NOW
    if (hits.length > 0) {
      console.error(
        `Found ${String(hits.length)} occurrence(s) of 'subagent.event' in src/:\n${hits.join('\n')}`,
      );
    }
    expect(hits).toHaveLength(0);
  });

  it("WireEventMethod union in types.ts must NOT contain '| .subagent.event.'", async () => {
    const src = await readTypesTs();
    // Phase 24: types.ts line 180 has `| 'subagent.event'` → FAILS NOW
    // After Phase 24: this line is deleted
    const hasDeadLiteral = src.includes("'subagent.event'");
    expect(hasDeadLiteral).toBe(false);
  });
});

// ── T5.2 — WireEventMethod must contain all new Phase 24 literals ────────

describe('Phase 24 T5 — WireEventMethod must contain all new Phase 24 event methods', () => {
  it("types.ts WireEventMethod union contains 'skill.invoked' (Phase 24 Step 3.3)", async () => {
    const src = await readTypesTs();
    // → FAILS NOW: 'skill.invoked' is not in the WireEventMethod union in types.ts
    expect(src).toContain("'skill.invoked'");
  });

  it("types.ts WireEventMethod union contains 'skill.completed' (Phase 24 Step 3.3)", async () => {
    const src = await readTypesTs();
    // → FAILS NOW
    expect(src).toContain("'skill.completed'");
  });

  it("types.ts WireEventMethod union contains 'mcp.loading' (Phase 24 Step 4.2)", async () => {
    const src = await readTypesTs();
    // → FAILS NOW
    expect(src).toContain("'mcp.loading'");
  });

  it("types.ts WireEventMethod union contains 'status.update.mcp_status' (Phase 24 Step 4.2)", async () => {
    const src = await readTypesTs();
    // → FAILS NOW
    expect(src).toContain("'status.update.mcp_status'");
  });

  it("WireEventMethod still retains the 6 existing mcp.* event literals (no regression)", async () => {
    const src = await readTypesTs();
    // These were added in Slice 7.2; must remain present after Phase 24
    for (const method of [
      "'mcp.connected'",
      "'mcp.disconnected'",
      "'mcp.error'",
      "'mcp.tools_changed'",
      "'mcp.resources_changed'",
      "'mcp.auth_required'",
    ]) {
      expect(src).toContain(method);
    }
  });
});

// ── T5.3 — SUPPORTED_WIRE_EVENTS coherence ──────────────────────────────

describe("Phase 24 T5 — default-handlers.ts SUPPORTED_WIRE_EVENTS coherence", () => {
  it("default-handlers.ts must not contain 'subagent.event' literal", async () => {
    const dhSrc = await readFile(
      join(srcDir, 'wire-protocol/default-handlers.ts'),
      'utf8',
    );
    // → FAILS NOW: line 171 has 'subagent.event' in SUPPORTED_WIRE_EVENTS array
    expect(dhSrc).not.toContain("'subagent.event'");
  });
});
