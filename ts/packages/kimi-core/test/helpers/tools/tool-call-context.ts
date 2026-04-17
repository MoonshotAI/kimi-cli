/**
 * Tool-call context stubs — Phase 9 §2.
 *
 * Python's `tool_call_context()` is a `ContextVar` used to thread the
 * current `ToolCall` through implicit state. TS tools receive
 * `toolCallId` / args / signal as explicit execute() parameters, so the
 * equivalent in TS is just a small set of factories that build the
 * values a test would otherwise have to construct by hand.
 */

import { randomUUID } from 'node:crypto';

export interface ToolCallStub {
  readonly id: string;
  readonly name: string;
  /** Stringified JSON (matches Python `tool_call_context` args field). */
  readonly arguments: string;
  /** Parsed args, handed back for ergonomic assertions. */
  readonly args: unknown;
}

function uniqueToolCallId(): string {
  return `tc_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
}

export function makeToolCallStub(
  name: string,
  args: unknown = {},
  id?: string,
): ToolCallStub {
  const safeId = id ?? uniqueToolCallId();
  return {
    id: safeId,
    name,
    arguments: JSON.stringify(args),
    args,
  };
}

/**
 * Fresh never-aborted `AbortSignal`. Convenience for tests that need to
 * pass a signal through but don't care about cancellation.
 */
export function makeAbortSignal(): AbortSignal {
  return new AbortController().signal;
}

export interface AbortableSignal {
  readonly signal: AbortSignal;
  readonly controller: AbortController;
}

/**
 * `AbortSignal` paired with the controller, so a test can trigger an
 * abort mid-execute.
 */
export function makeAbortableSignal(): AbortableSignal {
  const controller = new AbortController();
  return { signal: controller.signal, controller };
}
