import {
  APIError as OpenAIAPIError,
  APIConnectionError as OpenAIConnectionError,
  APIConnectionTimeoutError as OpenAITimeoutError,
  APIUserAbortError as OpenAIUserAbortError,
} from 'openai';
import { describe, it, expect } from 'vitest';

import { APIConnectionError, APITimeoutError, ChatProviderError } from '../src/errors.js';
import { convertOpenAIError } from '../src/providers/openai-common.js';
import {
  OpenAILegacyChatProvider,
  OpenAILegacyStreamedMessage,
} from '../src/providers/openai-legacy.js';

// ── Test: client creation ────────────────────────────────────────────

describe('OpenAI client creation', () => {
  it('does not inject max_retries into OpenAI client', () => {
    // The OpenAI constructor is called with apiKey and baseURL only —
    // we verify that the provider does not set max_retries.
    const provider = new OpenAILegacyChatProvider({
      model: 'gpt-4.1',
      apiKey: 'test-key',
      baseUrl: 'https://example.com/v1',
    });

    // Access internal client and verify it was created without max_retries
    const client = (provider as any)._client;
    expect(client).toBeDefined();
    // The client should have been created with default retries (SDK default),
    // not an injected value. We verify we don't override it.
    // In the TS SDK, maxRetries is a property on the client
    expect((client as unknown as Record<string, unknown>)['maxRetries']).not.toBe(0);
  });
});

// ── Test: retry recovery ─────────────────────────────────────────────

describe('retry recovery', () => {
  it('does not close shared http client on retryable error', () => {
    const provider = new OpenAILegacyChatProvider({
      model: 'gpt-4.1',
      apiKey: 'test-key',
    });

    const oldClient = (provider as any)._client;
    provider.onRetryableError(new APIConnectionError('Connection error.'));

    // Client should be replaced
    expect((provider as any)._client).not.toBe(oldClient);
  });
});

// ── Test: convertOpenAIError base APIError mapping ───────────────────

describe('convertOpenAIError: base APIError mapping', () => {
  const cases: Array<{ message: string; expectedType: typeof ChatProviderError; id: string }> = [
    {
      message: 'Network connection lost.',
      expectedType: APIConnectionError,
      id: 'network_connection_lost',
    },
    { message: 'Connection error.', expectedType: APIConnectionError, id: 'connection_error' },
    { message: 'network error', expectedType: APIConnectionError, id: 'network_error' },
    { message: 'disconnected from server', expectedType: APIConnectionError, id: 'disconnected' },
    {
      message: 'connection reset by peer',
      expectedType: APIConnectionError,
      id: 'connection_reset_by_peer',
    },
    {
      message: 'connection closed unexpectedly',
      expectedType: APIConnectionError,
      id: 'connection_closed_unexpectedly',
    },
    { message: 'Request timed out.', expectedType: APITimeoutError, id: 'request_timed_out' },
    { message: 'timed out', expectedType: APITimeoutError, id: 'timed_out' },
    // Timeout must take priority over network when both patterns match.
    {
      message: 'connection timed out',
      expectedType: APITimeoutError,
      id: 'connection_timed_out_timeout_priority',
    },
    {
      message: 'Something completely unrelated',
      expectedType: ChatProviderError,
      id: 'unrelated_error',
    },
    {
      message: 'Internal server error',
      expectedType: ChatProviderError,
      id: 'internal_server_error',
    },
    // Bare "reset"/"closed" must NOT match — they are too broad
    {
      message: 'Your session has been reset',
      expectedType: ChatProviderError,
      id: 'bare_reset_no_match',
    },
    {
      message: 'Stream closed by server due to policy violation',
      expectedType: ChatProviderError,
      id: 'bare_closed_no_match',
    },
  ];

  for (const { message, expectedType, id } of cases) {
    it(`classifies "${id}": ${message}`, () => {
      // Base APIError with no status and no body (transport-layer failure)
      const err = new OpenAIAPIError(undefined, undefined, message, undefined);
      const result = convertOpenAIError(err);
      expect(result).toBeInstanceOf(expectedType);
    });
  }
});

// ── Test: subclass errors still match first ──────────────────────────

describe('convertOpenAIError: subclass errors still match first', () => {
  it('APIConnectionError matches its own case', () => {
    const connErr = new OpenAIConnectionError({ message: 'Connection error.' });
    const result = convertOpenAIError(connErr);
    expect(result).toBeInstanceOf(APIConnectionError);
  });

  it('APIConnectionTimeoutError matches as timeout', () => {
    const timeoutErr = new OpenAITimeoutError({ message: 'Request timed out.' });
    const result = convertOpenAIError(timeoutErr);
    expect(result).toBeInstanceOf(APITimeoutError);
  });
});

// ── Test: APIError with body skips heuristic ─────────────────────────

describe('convertOpenAIError: APIError with body skips heuristic', () => {
  it('does not heuristically reclassify when error has a body', () => {
    // SSE error events carry a body — they must NOT be reclassified
    // even if the message contains network keywords.
    const err = new OpenAIAPIError(
      undefined,
      { error: { message: 'Connection limit exceeded', type: 'server_error' } },
      'Connection limit exceeded',
      undefined,
    );
    const result = convertOpenAIError(err);
    // Should NOT be APIConnectionError despite "Connection" in message
    expect(result.constructor).toBe(ChatProviderError);
  });
});

// ── Test: subclass error with network keywords falls through ─────────

describe('convertOpenAIError: subclass errors fall through', () => {
  it('APIUserAbortError is not heuristically reclassified', () => {
    // APIUserAbortError is a subclass of APIError (not exact APIError),
    // so the heuristic branch should not apply even with network keywords.
    const err = new OpenAIUserAbortError({ message: 'connection aborted by user' });
    const result = convertOpenAIError(err);
    // Should fall through to generic handling, not become APIConnectionError
    expect(result.constructor).toBe(ChatProviderError);
  });
});

// ── Test: streaming error propagation ────────────────────────────────

describe('OpenAI streaming error propagation', () => {
  it('base APIError("Network connection lost.") during streaming becomes APIConnectionError', async () => {
    // Simulates: streaming for ~33 minutes, then SSE connection drops
    // and the SDK raises openai.APIError("Network connection lost.")
    async function* failingStream(): AsyncGenerator<never> {
      throw new OpenAIAPIError(undefined, undefined, 'Network connection lost.', undefined);
      // Make this an async generator (unreachable)
      yield undefined as never;
    }

    const msg = new OpenAILegacyStreamedMessage(
      failingStream() as AsyncIterable<never>,
      true,
      undefined,
    );

    await expect(async () => {
      for await (const _ of msg) {
        // consume
      }
    }).rejects.toThrow(APIConnectionError);

    // Verify the message is preserved
    await expect(async () => {
      async function* failingStream2(): AsyncGenerator<never> {
        throw new OpenAIAPIError(undefined, undefined, 'Network connection lost.', undefined);
        yield undefined as never;
      }
      const msg2 = new OpenAILegacyStreamedMessage(
        failingStream2() as AsyncIterable<never>,
        true,
        undefined,
      );
      for await (const _ of msg2) {
        // consume
      }
    }).rejects.toThrow(/Network connection lost/);
  });
});
