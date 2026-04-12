import { describe, expect, it } from 'vitest';

import type { TokenUsage } from '../src/usage.js';
import { addUsage, emptyUsage, grandTotal, inputTotal } from '../src/usage.js';

describe('emptyUsage', () => {
  it('returns all zeros', () => {
    const usage = emptyUsage();
    expect(usage.inputOther).toBe(0);
    expect(usage.output).toBe(0);
    expect(usage.inputCacheRead).toBe(0);
    expect(usage.inputCacheCreation).toBe(0);
  });
});

describe('inputTotal', () => {
  it('sums all input fields', () => {
    const usage: TokenUsage = {
      inputOther: 100,
      output: 50,
      inputCacheRead: 200,
      inputCacheCreation: 30,
    };
    expect(inputTotal(usage)).toBe(330);
  });

  it('returns 0 for empty usage', () => {
    expect(inputTotal(emptyUsage())).toBe(0);
  });
});

describe('grandTotal', () => {
  it('sums input total and output', () => {
    const usage: TokenUsage = {
      inputOther: 100,
      output: 50,
      inputCacheRead: 200,
      inputCacheCreation: 30,
    };
    expect(grandTotal(usage)).toBe(380);
  });

  it('returns 0 for empty usage', () => {
    expect(grandTotal(emptyUsage())).toBe(0);
  });
});

describe('addUsage', () => {
  it('sums two usage values', () => {
    const a: TokenUsage = {
      inputOther: 10,
      output: 20,
      inputCacheRead: 30,
      inputCacheCreation: 40,
    };
    const b: TokenUsage = {
      inputOther: 5,
      output: 15,
      inputCacheRead: 25,
      inputCacheCreation: 35,
    };
    const result = addUsage(a, b);
    expect(result.inputOther).toBe(15);
    expect(result.output).toBe(35);
    expect(result.inputCacheRead).toBe(55);
    expect(result.inputCacheCreation).toBe(75);
  });

  it('adding empty usage returns the other', () => {
    const usage: TokenUsage = {
      inputOther: 100,
      output: 200,
      inputCacheRead: 300,
      inputCacheCreation: 400,
    };
    const result = addUsage(usage, emptyUsage());
    expect(result).toEqual(usage);
  });
});
