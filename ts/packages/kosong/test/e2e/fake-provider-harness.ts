import * as node_http from 'node:http';
import { TextDecoder } from 'node:util';

export interface FakeProviderRequest {
  readonly index: number;
  readonly method: string;
  readonly url: string;
  readonly pathname: string;
  readonly search: string;
  readonly headers: Record<string, string>;
  readonly bodyText: string;
  readonly bodyJson: unknown;
}

export interface FakeProviderReply {
  json(status: number, body: unknown, headers?: Record<string, string>): Promise<void>;
  text(status: number, body: string, headers?: Record<string, string>): Promise<void>;
  raw(status: number, body: string | Uint8Array, headers?: Record<string, string>): Promise<void>;
  sseLines(status: number, lines: string[], headers?: Record<string, string>): Promise<void>;
  sseJson(status: number, events: unknown[], headers?: Record<string, string>): Promise<void>;
}

export type FakeProviderRouteHandler = (
  request: FakeProviderRequest,
  reply: FakeProviderReply,
) => void | Promise<void>;

export interface FakeProviderHarness {
  readonly baseUrl: string;
  readonly requests: FakeProviderRequest[];
  route(method: string, pathname: string, handler: FakeProviderRouteHandler): void;
  close(): Promise<void>;
}

function normalizeHeaders(headers: node_http.IncomingHttpHeaders): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    normalized[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return normalized;
}

function withDefaultHeaders(
  headers: Record<string, string>,
  contentType: string,
): Record<string, string> {
  return {
    'content-type': contentType,
    ...headers,
  };
}

function buildSseLines(events: unknown[]): string[] {
  const lines: string[] = [];
  for (const event of events) {
    lines.push(`data: ${JSON.stringify(event)}`);
    lines.push('');
  }
  lines.push('data: [DONE]');
  lines.push('');
  return lines;
}

export async function readSseData(response: Response): Promise<string[]> {
  if (response.body === null) {
    return [];
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events: string[] = [];

  const flushBlock = (block: string): void => {
    const dataLines = block
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.startsWith('data:'));

    if (dataLines.length === 0) {
      return;
    }

    const payload = dataLines.map((line) => line.slice('data:'.length).trimStart()).join('\n');
    if (payload !== '[DONE]') {
      events.push(payload);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    while (buffer.includes('\n\n')) {
      const splitIndex = buffer.indexOf('\n\n');
      const block = buffer.slice(0, splitIndex);
      buffer = buffer.slice(splitIndex + 2);
      flushBlock(block);
    }
  }

  buffer += decoder.decode();
  const trailingBlocks = buffer.split('\n\n');
  for (const block of trailingBlocks) {
    if (block.trim().length > 0) {
      flushBlock(block);
    }
  }

  return events;
}

export async function createFakeProviderHarness(): Promise<FakeProviderHarness> {
  const requests: FakeProviderRequest[] = [];
  const routes = new Map<string, FakeProviderRouteHandler>();

  const server = node_http.createServer((req, res) => {
    void (async () => {
    const method = (req.method ?? 'GET').toUpperCase();
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const key = `${method} ${requestUrl.pathname}`;
    const route = routes.get(key);

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bodyText = Buffer.concat(chunks).toString('utf8');
    let bodyJson: unknown = null;
    if (bodyText.length > 0) {
      try {
        bodyJson = JSON.parse(bodyText) as unknown;
      } catch {
        bodyJson = null;
      }
    }

    const request: FakeProviderRequest = {
      index: requests.length,
      method,
      url: requestUrl.toString(),
      pathname: requestUrl.pathname,
      search: requestUrl.search,
      headers: normalizeHeaders(req.headers),
      bodyText,
      bodyJson,
    };
    requests.push(request);

    let responded = false;
    const reply: FakeProviderReply = {
      async json(
        status: number,
        body: unknown,
        headers: Record<string, string> = {},
      ): Promise<void> {
        if (responded) {
          return;
        }
        responded = true;
        res.writeHead(status, withDefaultHeaders(headers, 'application/json; charset=utf-8'));
        res.end(JSON.stringify(body));
      },
      async text(
        status: number,
        body: string,
        headers: Record<string, string> = {},
      ): Promise<void> {
        if (responded) {
          return;
        }
        responded = true;
        res.writeHead(status, withDefaultHeaders(headers, 'text/plain; charset=utf-8'));
        res.end(body);
      },
      async raw(
        status: number,
        body: string | Uint8Array,
        headers: Record<string, string> = {},
      ): Promise<void> {
        if (responded) {
          return;
        }
        responded = true;
        res.writeHead(status, headers);
        res.end(body);
      },
      async sseLines(
        status: number,
        lines: string[],
        headers: Record<string, string> = {},
      ): Promise<void> {
        if (responded) {
          return;
        }
        responded = true;
        res.writeHead(status, {
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'content-type': 'text/event-stream; charset=utf-8',
          ...headers,
        });
        res.write(lines.join('\n'));
        res.end();
      },
      async sseJson(
        status: number,
        events: unknown[],
        headers: Record<string, string> = {},
      ): Promise<void> {
        await reply.sseLines(status, buildSseLines(events), headers);
      },
    };

    if (route === undefined) {
      await reply.text(404, `No fake route for ${method} ${requestUrl.pathname}`);
      return;
    }

    await route(request, reply);

    if (!responded) {
      await reply.text(500, `Fake route for ${method} ${requestUrl.pathname} did not respond.`);
    }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Fake provider harness failed to bind a TCP port.');
  }

  return {
    get baseUrl(): string {
      return `http://127.0.0.1:${address.port}`;
    },
    requests,
    route(method: string, pathname: string, handler: FakeProviderRouteHandler): void {
      routes.set(`${method.toUpperCase()} ${pathname}`, handler);
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}
