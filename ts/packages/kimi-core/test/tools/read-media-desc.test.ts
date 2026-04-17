/**
 * ReadMediaFileTool description — Phase 14 §3.4.
 *
 * Ports
 *   `/Users/moonshot/Developer/kimi-cli/tests/tools/test_read_media_file_desc.py`
 * (4 parametrised cases).
 *
 * Pins the v2 description-template behaviour:
 *   - capabilities ⊇ {image_in, video_in}  → "supports image and video"
 *   - capabilities == {image_in}           → "supports image", "video … not supported"
 *   - capabilities == {video_in}           → "supports video", "image … not supported"
 *   - capabilities == ∅                    → constructor throws `SkipThisTool`
 *
 * FAILS until Phase 14 §3.3 lands:
 *   - `ReadMediaFileTool` constructor honours `capabilities`
 *   - `SkipThisTool` error class exported from `src/tools/index.ts`
 *   - description template interpolates per capability set
 */

import { describe, expect, it } from 'vitest';

import { ReadMediaFileTool } from '../../src/tools/read-media.js';
import { createFakeKaos, PERMISSIVE_WORKSPACE } from './fixtures/fake-kaos.js';
// eslint-disable-next-line import/no-unresolved
import { SkipThisTool } from '../../src/tools/index.js';

function makeTool(capabilities: ReadonlySet<string>): ReadMediaFileTool {
  const kaos = createFakeKaos();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (ReadMediaFileTool as any)(
    kaos,
    PERMISSIVE_WORKSPACE,
    capabilities,
  ) as ReadMediaFileTool;
}

describe('ReadMediaFileTool description by capabilities (Phase 14 §3.4)', () => {
  it('mentions image and video when both capabilities are present', () => {
    const tool = makeTool(new Set(['image_in', 'video_in']));
    expect(tool.description).toContain('supports image and video');
  });

  it('mentions image but flags video unsupported when only image_in is present', () => {
    const tool = makeTool(new Set(['image_in']));
    expect(tool.description).toContain('supports image files for the current model');
    expect(tool.description).toContain('Video files are not supported');
  });

  it('mentions video but flags image unsupported when only video_in is present', () => {
    const tool = makeTool(new Set(['video_in']));
    expect(tool.description).toContain('supports video files for the current model');
    expect(tool.description).toContain('Image files are not supported');
  });

  it('throws SkipThisTool when no image/video capability is present', () => {
    const kaos = createFakeKaos();
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new (ReadMediaFileTool as any)(kaos, PERMISSIVE_WORKSPACE, new Set());
    }).toThrow(SkipThisTool);
  });
});
