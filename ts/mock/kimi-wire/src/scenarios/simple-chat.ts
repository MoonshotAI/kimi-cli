/**
 * Simple chat scenario -- pure text streaming.
 *
 * Flow: TurnBegin -> StepBegin -> ThinkPart -> TextPart * N -> StatusUpdate -> TurnEnd
 */

import type { Scenario } from '../mock-event-generator.js';
import { event, delay } from '../mock-event-generator.js';

export function simpleChatScenario(userInput: string): Scenario {
  return {
    name: 'simple-chat',
    description: 'Simple text conversation with thinking',
    steps: [
      event({ type: 'TurnBegin', userInput }),
      delay(50),
      event({ type: 'StepBegin', n: 1 }),
      delay(30),
      // Thinking phase
      event({
        type: 'ContentPart',
        part: { type: 'think', think: 'Let me think about this...' },
      }),
      delay(20),
      event({
        type: 'ContentPart',
        part: { type: 'think', think: ' The user is asking me to respond.' },
      }),
      delay(40),
      // Text response in multiple chunks (simulating streaming)
      event({
        type: 'ContentPart',
        part: { type: 'text', text: 'Hello! ' },
      }),
      delay(15),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: 'I am Kimi, ' },
      }),
      delay(15),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: 'your AI assistant. ' },
      }),
      delay(15),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: 'How can I help you today?' },
      }),
      delay(20),
      // Status update
      event({
        type: 'StatusUpdate',
        contextUsage: 0.05,
        contextTokens: 500,
        maxContextTokens: 100000,
        tokenUsage: {
          inputOther: 100,
          output: 50,
          inputCacheRead: 0,
          inputCacheCreation: 0,
        },
      }),
      delay(10),
      event({ type: 'TurnEnd' }),
    ],
  };
}
