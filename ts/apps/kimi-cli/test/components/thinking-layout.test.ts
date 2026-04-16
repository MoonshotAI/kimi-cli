import { describe, expect, it } from 'vitest';

import {
  computeThinkingMaxHeight,
  computeThinkingViewportHeight,
  tailLines,
  wrapThinkingText,
} from '../../src/components/message/thinking-layout.js';

describe('thinking-layout', () => {
  it('clamps the preferred max thinking height between 4 and 8 rows', () => {
    expect(computeThinkingMaxHeight(12, 12)).toBe(4);
    expect(computeThinkingMaxHeight(24, 12)).toBe(6);
    expect(computeThinkingMaxHeight(80, 20)).toBe(8);
  });

  it('caps the max thinking height by the available rows', () => {
    expect(computeThinkingMaxHeight(40, 3)).toBe(3);
    expect(computeThinkingMaxHeight(24, 1)).toBe(1);
  });

  it('lets the live viewport grow naturally from one line up to the cap', () => {
    expect(computeThinkingViewportHeight(0, 6)).toBe(1);
    expect(computeThinkingViewportHeight(1, 6)).toBe(1);
    expect(computeThinkingViewportHeight(3, 6)).toBe(3);
    expect(computeThinkingViewportHeight(10, 6)).toBe(6);
  });

  it('wraps thinking text into hard-width lines and preserves blank lines', () => {
    expect(wrapThinkingText('abcdef', 3)).toEqual(['abc', 'def']);
    expect(wrapThinkingText('ab\n\ncd', 4)).toEqual(['ab', '', 'cd']);
  });

  it('returns only the tail lines needed for the viewport', () => {
    expect(tailLines(['1', '2', '3', '4'], 2)).toEqual(['3', '4']);
    expect(tailLines(['1', '2'], 5)).toEqual(['1', '2']);
    expect(tailLines(['1', '2'], 0)).toEqual([]);
  });
});
