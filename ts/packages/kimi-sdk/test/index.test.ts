import { describe, expect, test } from 'vitest';

import { CollectingSink, WIRE_PROTOCOL_VERSION } from '../src/index.js';

describe('SDK exports', () => {
  test('re-exports WIRE_PROTOCOL_VERSION', () => {
    expect(WIRE_PROTOCOL_VERSION).toBe('2.1');
  });

  test('re-exports CollectingSink', () => {
    const sink = new CollectingSink();
    sink.emit({ type: 'step.begin', stepNumber: 0 });
    expect(sink.events).toHaveLength(1);
  });
});
