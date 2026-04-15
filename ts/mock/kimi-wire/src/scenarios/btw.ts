/**
 * BTW (side question) scenario -- a quick side question that does not
 * interrupt the main conversation.
 *
 * Note: In Wire 2.1 there is no dedicated "btw" event type.
 * We model this as a mini turn with content.delta events.
 */

import type { Scenario } from '../mock-event-generator.js';
import { evt, delay } from '../mock-event-generator.js';
import { createEvent } from '../types.js';
import type { TurnBeginData, StepBeginData, StepEndData, ContentDeltaData, TurnEndData } from '../types.js';

export function btwScenario(question: string, sessionId: string = '__mock__', turnId: string = 'turn_btw'): Scenario {
  const opts = { session_id: sessionId, turn_id: turnId };

  return {
    name: 'btw',
    description: 'Side question (/btw) flow',
    steps: [
      evt(createEvent('turn.begin', { turn_id: turnId, user_input: question, input_kind: 'user' } satisfies TurnBeginData, opts)),
      delay(50),
      evt(createEvent('step.begin', { step: 1 } satisfies StepBeginData, opts)),
      delay(30),
      // BTW thinking
      evt(createEvent('content.delta', { type: 'think', think: 'The user has a quick side question. Let me answer it concisely.' } satisfies ContentDeltaData, opts)),
      delay(30),
      // BTW response text
      evt(createEvent('content.delta', { type: 'text', text: 'Quick answer: ' } satisfies ContentDeltaData, opts)),
      delay(15),
      evt(createEvent('content.delta', { type: 'text', text: 'TypeScript is a typed superset of JavaScript ' } satisfies ContentDeltaData, opts)),
      delay(15),
      evt(createEvent('content.delta', { type: 'text', text: 'that compiles to plain JavaScript.' } satisfies ContentDeltaData, opts)),
      delay(20),
      evt(createEvent('step.end', {} satisfies StepEndData, opts)),
      delay(10),
      evt(createEvent('turn.end', { turn_id: turnId, reason: 'done', success: true } satisfies TurnEndData, opts)),
    ],
  };
}
