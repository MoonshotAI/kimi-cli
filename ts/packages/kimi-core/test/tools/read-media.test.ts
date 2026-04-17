/**
 * ReadMediaFileTool — Phase 14 §3.3 / §3.4 rewrite.
 *
 * Replaces the Slice-3 suite: the old contract returned a single
 * `ToolResultContent` image block; Phase 14 widens to a 3-part sequence
 * (TextPart `<image path="…">` / ImageContent / TextPart `</image>`)
 * and introduces capability gating (`image_in` / `video_in`) plus
 * magic-byte sniffing.
 *
 * Ports the 6 Python tests in
 *   `/Users/moonshot/Developer/kimi-cli/tests/tools/test_read_media_file.py`
 * with one deliberate re-expression: TS-core has no PIL dependency, so
 * the "image size" variant injects a fake `imageSizeExtractor` and
 * asserts the "3x4px" hint appears in the ToolOk message.
 *
 * FAILS until Phase 14 §3.3 lands:
 *   - `ReadMediaFileTool` constructor accepts `capabilities` + optional
 *     `imageSizeExtractor`
 *   - `ToolResultContent` gains a `{ type: 'video'; source }` variant
 *   - output is `[TextPart, ImageContent | VideoContent, TextPart]`
 */

import type { Kaos } from '@moonshot-ai/kaos';
import { describe, expect, it, vi } from 'vitest';

import { ReadMediaFileTool } from '../../src/tools/read-media.js';
import { createFakeKaos, PERMISSIVE_WORKSPACE } from './fixtures/fake-kaos.js';

const signal = new AbortController().signal;

const DEFAULT_STAT = {
  stMode: 0o100644,
  stIno: 0,
  stDev: 0,
  stNlink: 1,
  stUid: 0,
  stGid: 0,
  stSize: 1024,
  stAtime: 0,
  stMtime: 0,
  stCtime: 0,
};

// PNG magic bytes + trivial body
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// MP4 ftyp brand `mp42` / `isom`
const MP4_HEADER = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftyp'),
  Buffer.from('mp42'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('mp42isom'),
]);

interface MakeOpts {
  readonly stat?: Kaos['stat'];
  readonly readBytes?: Kaos['readBytes'];
  readonly capabilities?: ReadonlySet<string>;
  readonly imageSizeExtractor?: (
    data: Buffer,
  ) => { width: number; height: number } | null;
}

function makeReadMediaTool(opts: MakeOpts = {}): ReadMediaFileTool {
  const kaos = createFakeKaos({
    stat: opts.stat ?? vi.fn<Kaos['stat']>().mockResolvedValue(DEFAULT_STAT),
    readBytes:
      opts.readBytes ??
      vi.fn<Kaos['readBytes']>().mockResolvedValue(PNG_HEADER),
  });
  const capabilities = opts.capabilities ?? new Set(['image_in', 'video_in']);
  // Phase 14 §3.3 — constructor accepts capabilities + extractor.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (ReadMediaFileTool as any)(
    kaos,
    PERMISSIVE_WORKSPACE,
    capabilities,
    opts.imageSizeExtractor,
  ) as ReadMediaFileTool;
}

interface ContentPart {
  readonly type: 'text' | 'image' | 'video';
  readonly text?: string;
  readonly source?: { type: 'base64'; data: string; media_type: string };
}

describe('ReadMediaFileTool (Phase 14 §3.4)', () => {
  it('returns a 3-part wrap [text, image, text] for PNG files', async () => {
    // Port of Python `test_read_image_file` (test_read_media_file.py:18).
    const data = Buffer.concat([PNG_HEADER, Buffer.from('pngdata')]);
    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({
        ...DEFAULT_STAT,
        stSize: data.length,
      }),
      readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(data),
    });

    const result = await tool.execute('c1', { path: '/workspace/sample.png' }, signal);

    expect(result.isError).toBeFalsy();
    expect(Array.isArray(result.content)).toBe(true);
    const parts = result.content as ContentPart[];
    // Canonical 3-part wrap; extractor-injected size hint may append a
    // 4th text part, so probe "at least 3" instead of pinning length.
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(parts[0]).toMatchObject({
      type: 'text',
      text: '<image path="/workspace/sample.png">',
    });
    expect(parts[1]?.type).toBe('image');
    expect(parts[1]?.source?.media_type).toBe('image/png');
    expect(parts[1]?.source?.data).toBe(data.toString('base64'));
    expect(parts[2]).toMatchObject({ type: 'text', text: '</image>' });
  });

  it('detects an extensionless PNG via magic-byte sniff', async () => {
    // Port of Python `test_read_extensionless_image_file`
    // (test_read_media_file.py:43). The TS path has no extension;
    // resolution must fall back to the header sniff path.
    const data = Buffer.concat([PNG_HEADER, Buffer.from('pngdata')]);
    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({
        ...DEFAULT_STAT,
        stSize: data.length,
      }),
      readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(data),
    });

    const result = await tool.execute('c2', { path: '/workspace/sample' }, signal);

    expect(result.isError).toBeFalsy();
    const parts = result.content as ContentPart[];
    expect(parts[0]).toMatchObject({ type: 'text', text: '<image path="/workspace/sample">' });
    expect(parts[1]?.source?.media_type).toBe('image/png');
  });

  it('injects "original size WxHpx" hint when imageSizeExtractor returns dimensions', async () => {
    // Port of Python `test_read_image_file_with_size`
    // (test_read_media_file.py:70) — TS uses an injected extractor.
    const data = Buffer.concat([PNG_HEADER, Buffer.from('pngdata')]);
    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({
        ...DEFAULT_STAT,
        stSize: data.length,
      }),
      readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(data),
      imageSizeExtractor: () => ({ width: 3, height: 4 }),
    });

    // For this assertion the tool must expose the "Loaded …" message
    // somewhere observable. v2 surfaces it via `result.content` text
    // part, `output`, or a dedicated `message` field — we accept any of
    // the three and look for "3x4px".
    const result = await tool.execute('c3', { path: '/workspace/valid.png' }, signal);
    expect(result.isError).toBeFalsy();

    const stringified = JSON.stringify(result);
    expect(stringified).toContain('3x4px');
  });

  it('returns a 3-part wrap [text, video, text] for MP4 ftyp files', async () => {
    // Port of Python `test_read_video_file` (test_read_media_file.py:94).
    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({
        ...DEFAULT_STAT,
        stSize: MP4_HEADER.length,
      }),
      readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(MP4_HEADER),
    });

    const result = await tool.execute('c4', { path: '/workspace/sample.mp4' }, signal);

    expect(result.isError).toBeFalsy();
    const parts = result.content as ContentPart[];
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(parts[0]).toMatchObject({
      type: 'text',
      text: '<video path="/workspace/sample.mp4">',
    });
    expect(parts[1]?.type).toBe('video');
    expect(parts[1]?.source?.media_type).toBe('video/mp4');
    expect(parts[1]?.source?.data).toBe(MP4_HEADER.toString('base64'));
    expect(parts[2]).toMatchObject({ type: 'text', text: '</video>' });
  });

  it('rejects text files with "use ReadFile" message', async () => {
    // Port of Python `test_read_text_file` (test_read_media_file.py:119).
    const text = Buffer.from('hello');
    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({
        ...DEFAULT_STAT,
        stSize: text.length,
      }),
      readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(text),
    });

    const result = await tool.execute('c5', { path: '/workspace/sample.txt' }, signal);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/text file.*Use ReadFile|Use ReadFile.*text/i);
  });

  it('errors when the model lacks video_in capability on a video file', async () => {
    // Port of Python `test_read_video_file_without_capability`
    // (test_read_media_file.py:133). Cap = image_in only; MP4 → error
    // "model does not support video input".
    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({
        ...DEFAULT_STAT,
        stSize: MP4_HEADER.length,
      }),
      readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(MP4_HEADER),
      capabilities: new Set(['image_in']),
    });

    const result = await tool.execute('c6', { path: '/workspace/sample.mp4' }, signal);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/video input/i);
  });

  // ── Slice 3 regression — keep critical non-port tests ──────────────

  it('rejects empty file', async () => {
    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({ ...DEFAULT_STAT, stSize: 0 }),
    });
    const result = await tool.execute('c_empty', { path: '/workspace/empty.png' }, signal);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/empty/i);
  });

  it('rejects file exceeding size limit', async () => {
    const tool = makeReadMediaTool({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue({
        ...DEFAULT_STAT,
        stSize: 200 * 1024 * 1024,
      }),
    });
    const result = await tool.execute('c_huge', { path: '/workspace/huge.png' }, signal);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/exceeds|too large|100/i);
  });

  it('rejects path outside workspace', async () => {
    const kaos = createFakeKaos({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue(DEFAULT_STAT),
      readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(PNG_HEADER),
    });
    const narrowWorkspace = { workspaceDir: '/workspace', additionalDirs: [] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tool = new (ReadMediaFileTool as any)(
      kaos,
      narrowWorkspace,
      new Set(['image_in', 'video_in']),
    ) as ReadMediaFileTool;

    const result = await tool.execute('c_ws', { path: '/etc/secret.png' }, signal);
    expect(result.isError).toBe(true);
  });
});
