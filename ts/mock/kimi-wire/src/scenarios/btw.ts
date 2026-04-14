/**
 * BTW (side question) scenario -- a quick side question that does not
 * interrupt the main conversation.
 *
 * Flow: BtwBegin -> ContentPart(think) -> ContentPart(text) * N -> BtwEnd
 *
 * Note: BTW events are emitted outside the normal turn lifecycle.
 */

import type { Scenario } from '../mock-event-generator.js';
import { event, delay } from '../mock-event-generator.js';

export function btwScenario(question: string): Scenario {
  const btwId = `btw-${Date.now().toString(36)}`;

  return {
    name: 'btw',
    description: 'Side question (/btw) flow',
    steps: [
      event({
        type: 'BtwBegin',
        id: btwId,
        question,
      }),
      delay(50),
      // BTW thinking
      event({
        type: 'ContentPart',
        part: {
          type: 'think',
          think: 'The user has a quick side question. Let me answer it concisely.',
        },
      }),
      delay(30),
      // BTW response text
      event({
        type: 'ContentPart',
        part: {
          type: 'text',
          text: 'Quick answer: ',
        },
      }),
      delay(15),
      event({
        type: 'ContentPart',
        part: {
          type: 'text',
          text: 'TypeScript is a typed superset of JavaScript ',
        },
      }),
      delay(15),
      event({
        type: 'ContentPart',
        part: {
          type: 'text',
          text: 'that compiles to plain JavaScript.',
        },
      }),
      delay(20),
      event({
        type: 'BtwEnd',
        id: btwId,
        response:
          'Quick answer: TypeScript is a typed superset of JavaScript that compiles to plain JavaScript.',
        error: null,
      }),
    ],
  };
}
