import { describe, expect, test } from 'vitest';

import { WIRE_PROTOCOL_VERSION } from '../src/index.js';

describe('SDK exports', () => {
  test('re-exports WIRE_PROTOCOL_VERSION', () => {
    expect(WIRE_PROTOCOL_VERSION).toBe('2.1');
  });
});
