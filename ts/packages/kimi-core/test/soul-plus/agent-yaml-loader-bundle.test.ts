/**
 * agent-yaml-loader — bundled YAML discovery tests (Slice 5.3 T3).
 *
 * Pins the contract of `getBundledAgentYamlPath()`: the helper described
 * in plan-book Change C3 / D4 resolves the bundled `agents/default/
 * agent.yaml` from inside the `@moonshot-ai/core` package layout so that
 * the app does not need to hardcode its own path (and works in both dev
 * and published `dist/` layouts).
 *
 * Red bar today: `getBundledAgentYamlPath` is not exported yet (C3.1 +
 * C3.2 still pending). The TypeScript compile will fail at the import
 * — that is the expected red bar for this test, per the Coordinator
 * brief.
 */

import { stat } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  getBundledAgentYamlPath,
  loadSubagentTypes,
} from '../../src/soul-plus/agent-yaml-loader.js';

describe('getBundledAgentYamlPath (Slice 5.3 T3)', () => {
  it('resolves to an existing file on disk', async () => {
    const bundledPath = await getBundledAgentYamlPath();
    const info = await stat(bundledPath);
    expect(info.isFile()).toBe(true);
    expect(bundledPath.endsWith('agent.yaml')).toBe(true);
  });

  it('feeds loadSubagentTypes → coder / explore / plan types', async () => {
    const bundledPath = await getBundledAgentYamlPath();
    const types = await loadSubagentTypes(bundledPath);
    const names = types.map((t) => t.name).sort();
    expect(names).toEqual(['coder', 'explore', 'plan']);
  });
});
