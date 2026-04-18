/**
 * Local OAuth callback server — Phase 19 Slice D.
 *
 * The PKCE Authorization Code Flow uses a browser redirect back to a
 * loopback `redirect_uri`. This module spins up an ephemeral `http`
 * listener on `127.0.0.1` (auto-picked port) that captures the
 * `code`/`error`/`state` query params from the `/callback` GET and
 * resolves a pending waiter. The `redirectUri` is plumbed into the
 * {@link McpOAuthProvider} so MCP SDK knows where to send the user.
 *
 * Design notes:
 * - Ephemeral port: `listen(0)` lets the OS pick — avoids fixed-port
 *   clashes and makes concurrent flows safe.
 * - Timeout default is 5 min (300_000 ms) — a conservative value for
 *   a real interactive flow; tests override with much shorter values.
 * - `close()` force-rejects every pending waiter with a "server closed"
 *   error so callers unwind cleanly even if the user never visited the
 *   browser tab.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface OAuthCallbackPayload {
  readonly code: string;
  readonly state?: string;
}

export interface OAuthCallbackServerHandle {
  readonly port: number;
  readonly redirectUri: string;
  waitForCode(opts?: { timeoutMs?: number }): Promise<OAuthCallbackPayload>;
  close(): Promise<void>;
}

export interface StartOAuthCallbackServerOptions {
  readonly port?: number;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 300_000; // 5 min

interface PendingWaiter {
  readonly resolve: (value: OAuthCallbackPayload) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: NodeJS.Timeout;
}

const SUCCESS_BODY = [
  '<!doctype html>',
  '<html><head><meta charset="utf-8"><title>Authentication complete</title></head>',
  '<body style="font-family:system-ui,sans-serif;text-align:center;padding:3em;">',
  '<h1>✓ Authentication successful.</h1>',
  '<p>You may close this window and return to the terminal.</p>',
  '</body></html>',
].join('\n');

/**
 * Escape HTML in attacker-controlled text before embedding in the
 * success / error pages. `&` MUST be replaced first so that legitimate
 * `&` characters aren't double-encoded and attempts to inject things
 * like `&lt;script&gt;` by feeding `<script>` through the url's
 * `error_description` query parameter don't round-trip into live HTML.
 */
function htmlEscape(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function errorBody(message: string): string {
  const safe = htmlEscape(message);
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><title>Authentication failed</title></head>',
    '<body style="font-family:system-ui,sans-serif;text-align:center;padding:3em;">',
    '<h1>Authentication failed</h1>',
    `<p>${safe}</p>`,
    '</body></html>',
  ].join('\n');
}

export function startOAuthCallbackServer(
  opts: StartOAuthCallbackServerOptions = {},
): Promise<OAuthCallbackServerHandle> {
  const defaultTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const desiredPort = opts.port ?? 0;

  return new Promise((resolveListen, rejectListen) => {
    let resolvedPayload: OAuthCallbackPayload | null = null;
    let rejectedError: Error | null = null;
    const waiters = new Set<PendingWaiter>();
    let closed = false;

    const server: Server = createServer((req, res) => {
      handleRequest(req, res);
    });

    function settleResolve(payload: OAuthCallbackPayload): void {
      if (resolvedPayload !== null || rejectedError !== null) return;
      resolvedPayload = payload;
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.resolve(payload);
      }
      waiters.clear();
    }

    function settleReject(error: Error): void {
      if (resolvedPayload !== null || rejectedError !== null) return;
      rejectedError = error;
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.reject(error);
      }
      waiters.clear();
    }

    function handleRequest(req: IncomingMessage, res: ServerResponse): void {
      const rawUrl = req.url ?? '/';
      // Parse against an arbitrary base so relative URLs resolve.
      const parsed = new URL(rawUrl, 'http://127.0.0.1');
      if (parsed.pathname !== '/callback') {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Not found');
        return;
      }

      const code = parsed.searchParams.get('code');
      const errorParam = parsed.searchParams.get('error');
      const errorDesc = parsed.searchParams.get('error_description');
      const state = parsed.searchParams.get('state');

      if (errorParam !== null) {
        const detail = errorDesc !== null && errorDesc.length > 0 ? `: ${errorDesc}` : '';
        const err = new Error(`OAuth callback error: ${errorParam}${detail}`);
        res.statusCode = 400;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(errorBody(`${errorParam}${detail}`));
        settleReject(err);
        return;
      }

      if (code !== null && code.length > 0) {
        const payload: OAuthCallbackPayload =
          state !== null ? { code, state } : { code };
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(SUCCESS_BODY);
        settleResolve(payload);
        return;
      }

      // Neither code nor error — reject waiters (test #5 allows either path).
      res.statusCode = 400;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Invalid callback: missing code');
      settleReject(new Error('OAuth callback missing "code" and "error"'));
    }

    server.on('error', (err: Error) => {
      if (closed) return;
      rejectListen(err);
    });

    server.listen(desiredPort, '127.0.0.1', () => {
      const address = server.address() as AddressInfo | null;
      if (address === null || typeof address === 'string') {
        server.close();
        rejectListen(new Error('OAuth callback server failed to report an address'));
        return;
      }
      const port = address.port;
      const redirectUri = `http://127.0.0.1:${port}/callback`;

      const handle: OAuthCallbackServerHandle = {
        port,
        redirectUri,
        waitForCode(waitOpts) {
          const timeoutMs = waitOpts?.timeoutMs ?? defaultTimeoutMs;
          if (rejectedError !== null) {
            return Promise.reject(rejectedError);
          }
          if (resolvedPayload !== null) {
            return Promise.resolve(resolvedPayload);
          }
          const p = new Promise<OAuthCallbackPayload>((resolve, reject) => {
            const timer = setTimeout(() => {
              waiters.delete(waiter);
              reject(new Error(`OAuth callback timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            const waiter: PendingWaiter = { resolve, reject, timer };
            waiters.add(waiter);
          });
          // Attach a noop catch guard so that if the waiter rejects before
          // the caller awaits (request can arrive in the same microtask
          // cycle as the `await` on its first fetch), Node does not log
          // the rejection as unhandled. The caller's `await p` still
          // propagates the original error normally.
          p.catch(() => {});
          return p;
        },
        async close() {
          if (closed) return;
          closed = true;
          // Reject anyone still waiting BEFORE the server.close callback —
          // in tests the waiter assertion fires synchronously after
          // close() returns, so the rejection must have landed already.
          const closedError = new Error('OAuth callback server closed');
          for (const w of waiters) {
            clearTimeout(w.timer);
            w.reject(closedError);
          }
          waiters.clear();
          await new Promise<void>((r) => {
            server.close(() => {
              r();
            });
          });
        },
      };
      resolveListen(handle);
    });
  });
}
