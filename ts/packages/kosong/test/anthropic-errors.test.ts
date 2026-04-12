import {
  APIConnectionError as AnthropicConnectionError,
  APIConnectionTimeoutError as AnthropicTimeoutError,
  APIError as AnthropicAPIError,
  AnthropicError,
  AuthenticationError as AnthropicAuthenticationError,
  RateLimitError as AnthropicRateLimitError,
} from '@anthropic-ai/sdk';
import { describe, it, expect, vi } from 'vitest';

import {
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  ChatProviderError,
} from '../src/errors.js';
import { convertAnthropicError, AnthropicChatProvider } from '../src/providers/anthropic.js';

// ── convertAnthropicError ────────────────────────────────────────────

describe('convertAnthropicError', () => {
  it('APIConnectionTimeoutError -> APITimeoutError (not misclassified as connection)', () => {
    const err = new AnthropicTimeoutError({ message: 'timed out' });
    const result = convertAnthropicError(err);
    expect(result).toBeInstanceOf(APITimeoutError);
    // Must NOT be a plain APIConnectionError
    expect(result.constructor).toBe(APITimeoutError);
  });

  it('APIConnectionError -> APIConnectionError', () => {
    const err = new AnthropicConnectionError({ message: 'connection refused' });
    const result = convertAnthropicError(err);
    expect(result).toBeInstanceOf(APIConnectionError);
  });

  it('APIError with status -> APIStatusError', () => {
    const err = AnthropicAPIError.generate(
      502,
      { type: 'error', error: { type: 'api_error', message: 'bad gateway' } },
      'bad gateway',
      new Headers(),
    );
    const result = convertAnthropicError(err);
    expect(result).toBeInstanceOf(APIStatusError);
    expect((result as APIStatusError).statusCode).toBe(502);
  });

  it('AuthenticationError -> APIStatusError with 401', () => {
    const err = new AnthropicAuthenticationError(
      401,
      { type: 'error', error: { type: 'authentication_error', message: 'invalid key' } },
      'invalid key',
      new Headers(),
    );
    const result = convertAnthropicError(err);
    expect(result).toBeInstanceOf(APIStatusError);
    expect((result as APIStatusError).statusCode).toBe(401);
  });

  it('RateLimitError -> APIStatusError with 429', () => {
    const err = new AnthropicRateLimitError(
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } },
      'rate limited',
      new Headers(),
    );
    const result = convertAnthropicError(err);
    expect(result).toBeInstanceOf(APIStatusError);
    expect((result as APIStatusError).statusCode).toBe(429);
  });

  it('generic AnthropicError -> ChatProviderError', () => {
    const err = new AnthropicError('something went wrong');
    const result = convertAnthropicError(err);
    expect(result).toBeInstanceOf(ChatProviderError);
    expect(result.message).toContain('something went wrong');
  });

  it('plain Error -> ChatProviderError', () => {
    const err = new Error('unexpected');
    const result = convertAnthropicError(err);
    expect(result).toBeInstanceOf(ChatProviderError);
    expect(result.message).toContain('unexpected');
  });

  it('non-Error value -> ChatProviderError', () => {
    const result = convertAnthropicError('string error');
    expect(result).toBeInstanceOf(ChatProviderError);
    expect(result.message).toContain('string error');
  });
});

// ── Non-stream error propagation ────────────────────────────────────

describe('non-stream error propagation', () => {
  function createNonStreamProvider(): AnthropicChatProvider {
    return new AnthropicChatProvider({
      model: 'claude-sonnet-4-20250514',
      apiKey: 'test-key',
      defaultMaxTokens: 1024,
      stream: false,
    });
  }

  it('APIConnectionTimeoutError during generate is converted', async () => {
    const provider = createNonStreamProvider();
    const sdkError = new AnthropicTimeoutError({ message: 'stream timed out' });
    (provider as any)._client.messages.create = vi.fn().mockRejectedValue(sdkError);

    await expect(
      provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
      ),
    ).rejects.toThrow(APITimeoutError);
  });

  it('APIConnectionError during generate is converted', async () => {
    const provider = createNonStreamProvider();
    const sdkError = new AnthropicConnectionError({ message: 'connection reset' });
    (provider as any)._client.messages.create = vi.fn().mockRejectedValue(sdkError);

    await expect(
      provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
      ),
    ).rejects.toThrow(APIConnectionError);
  });

  it('APIError with status during generate is converted to APIStatusError', async () => {
    const provider = createNonStreamProvider();
    const sdkError = AnthropicAPIError.generate(
      500,
      { type: 'error', error: { type: 'api_error', message: 'internal error' } },
      'internal error',
      new Headers(),
    );
    (provider as any)._client.messages.create = vi.fn().mockRejectedValue(sdkError);

    await expect(
      provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
      ),
    ).rejects.toThrow(APIStatusError);
  });

  it('RateLimitError during generate is converted to APIStatusError(429)', async () => {
    const provider = createNonStreamProvider();
    const sdkError = new AnthropicRateLimitError(
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'too many requests' } },
      'too many requests',
      new Headers(),
    );
    (provider as any)._client.messages.create = vi.fn().mockRejectedValue(sdkError);

    try {
      await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
      );
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(APIStatusError);
      expect((error as APIStatusError).statusCode).toBe(429);
    }
  });

  it('AuthenticationError during generate is converted to APIStatusError(401)', async () => {
    const provider = createNonStreamProvider();
    const sdkError = new AnthropicAuthenticationError(
      401,
      { type: 'error', error: { type: 'authentication_error', message: 'invalid' } },
      'invalid',
      new Headers(),
    );
    (provider as any)._client.messages.create = vi.fn().mockRejectedValue(sdkError);

    try {
      await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
      );
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(APIStatusError);
      expect((error as APIStatusError).statusCode).toBe(401);
    }
  });
});

// ── Stream error propagation ────────────────────────────────────────

describe('stream error propagation', () => {
  function createStreamProvider(): AnthropicChatProvider {
    return new AnthropicChatProvider({
      model: 'claude-sonnet-4-20250514',
      apiKey: 'test-key',
      defaultMaxTokens: 1024,
      stream: true,
    });
  }

  function makeErrorStream(error: Error) {
    return {
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'message_start',
          message: { id: 'msg_err', usage: { input_tokens: 0 } },
        };
        throw error;
      },
    };
  }

  it('APIConnectionTimeoutError during stream iteration is converted', async () => {
    const provider = createStreamProvider();
    const sdkError = new AnthropicTimeoutError({ message: 'stream timed out' });
    (provider as any)._client.messages.stream = vi
      .fn()
      .mockReturnValue(makeErrorStream(sdkError)) as never;

    const result = await provider.generate(
      '',
      [],
      [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
    );
    const parts: unknown[] = [];
    await expect(
      (async () => {
        for await (const part of result) {
          parts.push(part);
        }
      })(),
    ).rejects.toThrow(APITimeoutError);
  });

  it('APIConnectionError during stream iteration is converted', async () => {
    const provider = createStreamProvider();
    const sdkError = new AnthropicConnectionError({ message: 'connection reset' });
    (provider as any)._client.messages.stream = vi
      .fn()
      .mockReturnValue(makeErrorStream(sdkError)) as never;

    const result = await provider.generate(
      '',
      [],
      [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
    );
    await expect(
      (async () => {
        for await (const _ of result) {
          /* drain */
        }
      })(),
    ).rejects.toThrow(APIConnectionError);
  });

  it('APIError with status during stream iteration is converted to APIStatusError', async () => {
    const provider = createStreamProvider();
    const sdkError = AnthropicAPIError.generate(
      500,
      { type: 'error', error: { type: 'api_error', message: 'internal error' } },
      'internal error',
      new Headers(),
    );
    (provider as any)._client.messages.stream = vi
      .fn()
      .mockReturnValue(makeErrorStream(sdkError)) as never;

    const result = await provider.generate(
      '',
      [],
      [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
    );
    await expect(
      (async () => {
        for await (const _ of result) {
          /* drain */
        }
      })(),
    ).rejects.toThrow(APIStatusError);
  });

  it('RateLimitError during stream iteration is converted to APIStatusError(429)', async () => {
    const provider = createStreamProvider();
    const sdkError = new AnthropicRateLimitError(
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'too many requests' } },
      'too many requests',
      new Headers(),
    );
    (provider as any)._client.messages.stream = vi
      .fn()
      .mockReturnValue(makeErrorStream(sdkError)) as never;

    const result = await provider.generate(
      '',
      [],
      [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
    );
    try {
      for await (const _ of result) {
        /* drain */
      }
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(APIStatusError);
      expect((error as APIStatusError).statusCode).toBe(429);
    }
  });

  it('AuthenticationError during stream iteration is converted to APIStatusError(401)', async () => {
    const provider = createStreamProvider();
    const sdkError = new AnthropicAuthenticationError(
      401,
      { type: 'error', error: { type: 'authentication_error', message: 'invalid' } },
      'invalid',
      new Headers(),
    );
    (provider as any)._client.messages.stream = vi
      .fn()
      .mockReturnValue(makeErrorStream(sdkError)) as never;

    const result = await provider.generate(
      '',
      [],
      [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
    );
    try {
      for await (const _ of result) {
        /* drain */
      }
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(APIStatusError);
      expect((error as APIStatusError).statusCode).toBe(401);
    }
  });
});
