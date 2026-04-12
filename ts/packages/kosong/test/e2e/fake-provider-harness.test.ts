import { describe, expect, it } from 'vitest';

import { createFakeProviderHarness, readSseData } from './fake-provider-harness.js';

class ToyJsonAdapter {
  constructor(private readonly baseUrl: string) {}

  async request(prompt: string): Promise<{ echo: unknown }> {
    const response = await fetch(`${this.baseUrl}/json`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ prompt }),
    });
    if (!response.ok) {
      throw new Error(`unexpected status ${response.status}`);
    }
    return (await response.json()) as { echo: unknown };
  }
}

class ToySseAdapter {
  constructor(private readonly baseUrl: string) {}

  async request(prompt: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/stream`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ prompt }),
    });
    if (!response.ok) {
      throw new Error(`unexpected status ${response.status}`);
    }
    const frames = await readSseData(response);
    return frames
      .map((frame) => JSON.parse(frame) as { delta: string })
      .map((part) => part.delta)
      .join('');
  }
}

describe('e2e: fake provider harness', () => {
  it('captures JSON requests and serves JSON responses', async () => {
    const harness = await createFakeProviderHarness();
    try {
      harness.route('POST', '/json', async (request, reply) => {
        expect(request.method).toBe('POST');
        expect(request.pathname).toBe('/json');
        expect(request.bodyJson).toEqual({ prompt: 'hello' });
        expect(request.headers['content-type']).toContain('application/json');

        await reply.json(200, {
          id: 'json-1',
          ok: true,
          echo: request.bodyJson,
        });
      });

      const adapter = new ToyJsonAdapter(harness.baseUrl);
      const result = await adapter.request('hello');
      expect(result).toEqual({
        id: 'json-1',
        ok: true,
        echo: { prompt: 'hello' },
      });

      expect(harness.requests).toHaveLength(1);
      expect(harness.requests[0]!.pathname).toBe('/json');
    } finally {
      await harness.close();
    }
  });

  it('streams SSE frames and lets clients consume them in order', async () => {
    const harness = await createFakeProviderHarness();
    try {
      harness.route('POST', '/stream', async (_request, reply) => {
        await reply.sseJson(200, [{ delta: 'hel' }, { delta: 'lo' }]);
      });

      const adapter = new ToySseAdapter(harness.baseUrl);
      const text = await adapter.request('stream');
      expect(text).toBe('hello');

      expect(harness.requests).toHaveLength(1);
      expect(harness.requests[0]!.pathname).toBe('/stream');
    } finally {
      await harness.close();
    }
  });
});
