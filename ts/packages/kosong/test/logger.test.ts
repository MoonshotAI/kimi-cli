import { afterEach, describe, expect, test } from 'vitest';

import { getLogger, setLogger, type Logger } from '../src/logger.js';

describe('Logger', () => {
  afterEach(() => {
    setLogger(null);
  });

  test('default logger is no-op', () => {
    const logger = getLogger();
    // Should not throw.
    expect(() => {
      logger.trace('test');
      logger.debug('test');
      logger.info('test');
      logger.warn('test');
      logger.error('test');
    }).not.toThrow();
  });

  test('setLogger replaces the global logger', () => {
    const calls: Array<[string, string]> = [];
    const customLogger: Logger = {
      trace: (msg) => calls.push(['trace', msg]),
      debug: (msg) => calls.push(['debug', msg]),
      info: (msg) => calls.push(['info', msg]),
      warn: (msg) => calls.push(['warn', msg]),
      error: (msg) => calls.push(['error', msg]),
    };

    setLogger(customLogger);
    const logger = getLogger();
    logger.info('hello');
    logger.error('boom');

    expect(calls).toEqual([
      ['info', 'hello'],
      ['error', 'boom'],
    ]);
  });

  test('setLogger(null) resets to the no-op logger', () => {
    const customLogger: Logger = {
      trace: () => {
        throw new Error('should not be called');
      },
      debug: () => {
        throw new Error('should not be called');
      },
      info: () => {
        throw new Error('should not be called');
      },
      warn: () => {
        throw new Error('should not be called');
      },
      error: () => {
        throw new Error('should not be called');
      },
    };
    setLogger(customLogger);
    setLogger(null);

    // Must not throw.
    expect(() => {
      getLogger().info('hi');
      getLogger().error('bye');
    }).not.toThrow();
  });

  test('logger context object is passed through', () => {
    const calls: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    setLogger({
      trace: () => {},
      debug: () => {},
      info: (msg, ctx) => calls.push({ msg, ...(ctx !== undefined && { ctx }) }),
      warn: () => {},
      error: () => {},
    });

    getLogger().info('streaming', { provider: 'kimi', tokens: 100 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.ctx).toEqual({ provider: 'kimi', tokens: 100 });
  });
});
