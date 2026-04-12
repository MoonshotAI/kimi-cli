/**
 * Negative type-safety checks.
 *
 * Each @ts-expect-error below marks code that MUST be rejected by tsc.
 * If tsc does NOT reject it, the @ts-expect-error itself becomes an error
 * ("Unused '@ts-expect-error' directive"), proving the type system has a gap.
 *
 * Run: pnpm exec tsc --noEmit -p tsconfig.type-negative.json
 */

import type { Message, ToolCall, StreamedMessagePart, TextPart } from '../src/message.js';

// ── exactOptionalPropertyTypes ────────────────────────────────────────

// Assigning `undefined` to an optional property should be rejected
// when exactOptionalPropertyTypes is enabled.

// @ts-expect-error — toolCallId is optional but not `| undefined`
const msg1: Message = {
  role: 'user',
  content: [{ type: 'text', text: 'hi' }],
  toolCallId: undefined,
};

// @ts-expect-error — toolCalls is required ToolCall[] and cannot be undefined
const msg2: Message = {
  role: 'assistant',
  content: [],
  toolCalls: undefined,
};

// @ts-expect-error — name is optional but not `| undefined`
const msg3: Message = {
  role: 'user',
  content: [{ type: 'text', text: 'hi' }],
  name: undefined,
};

// @ts-expect-error — partial is optional but not `| undefined`
const msg4: Message = {
  role: 'assistant',
  content: [],
  partial: undefined,
};

// @ts-expect-error — extras on ToolCall is optional but not `| undefined`
const tc1: ToolCall = {
  type: 'function',
  id: 'call-1',
  function: { name: 'test', arguments: null },
  extras: undefined,
};

// ── Wrong discriminant access ─────────────────────────────────────────

// Accessing a property from the wrong variant should fail.

const textPart: TextPart = { type: 'text', text: 'hello' };

// @ts-expect-error — TextPart does not have 'think' property
const _badAccess1: string = textPart.think;

// @ts-expect-error — TextPart does not have 'imageUrl' property
const _badAccess2: string = textPart.imageUrl;

// ── Wrong role ────────────────────────────────────────────────────────

const msg5: Message = {
  // @ts-expect-error — 'invalid' is not a valid Role
  role: 'invalid',
  content: [],
};

// ── Wrong part type discriminant ──────────────────────────────────────

const badPart: StreamedMessagePart = {
  // @ts-expect-error — 'unknown_type' is not a valid part type
  type: 'unknown_type',
  text: 'hello',
};

// Suppress "unused variable" warnings — these variables exist only for type checking.
void msg1;
void msg2;
void msg3;
void msg4;
void tc1;
void _badAccess1;
void _badAccess2;
void msg5;
void badPart;
