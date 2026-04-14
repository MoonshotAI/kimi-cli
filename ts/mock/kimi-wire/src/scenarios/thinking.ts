/**
 * Thinking scenario -- extended thinking process before responding.
 *
 * Flow: TurnBegin -> StepBegin -> ThinkPart * many -> TextPart * N
 *       -> StatusUpdate -> TurnEnd
 */

import type { Scenario } from '../mock-event-generator.js';
import { event, delay } from '../mock-event-generator.js';

export function thinkingScenario(userInput: string): Scenario {
  return {
    name: 'thinking',
    description: 'Extended thinking before responding',
    steps: [
      event({ type: 'TurnBegin', userInput }),
      delay(50),
      event({ type: 'StepBegin', n: 1 }),
      delay(30),
      // Long thinking phase with multiple chunks
      event({
        type: 'ContentPart',
        part: {
          type: 'think',
          think: 'This is an interesting question. ',
        },
      }),
      delay(40),
      event({
        type: 'ContentPart',
        part: {
          type: 'think',
          think: 'Let me break it down step by step.\n\n',
        },
      }),
      delay(40),
      event({
        type: 'ContentPart',
        part: {
          type: 'think',
          think: 'First, I should consider the requirements:\n',
        },
      }),
      delay(30),
      event({
        type: 'ContentPart',
        part: {
          type: 'think',
          think: '1. The user wants a thorough analysis\n',
        },
      }),
      delay(30),
      event({
        type: 'ContentPart',
        part: {
          type: 'think',
          think: '2. I need to provide practical examples\n',
        },
      }),
      delay(30),
      event({
        type: 'ContentPart',
        part: {
          type: 'think',
          think: '3. The answer should be well-structured\n\n',
        },
      }),
      delay(40),
      event({
        type: 'ContentPart',
        part: {
          type: 'think',
          think: 'Now, let me formulate a comprehensive response that addresses all these points.',
        },
      }),
      delay(50),
      // Actual text response
      event({
        type: 'ContentPart',
        part: {
          type: 'text',
          text: 'After careful consideration, here is my analysis:\n\n',
        },
      }),
      delay(20),
      event({
        type: 'ContentPart',
        part: {
          type: 'text',
          text: '## Key Points\n\n',
        },
      }),
      delay(15),
      event({
        type: 'ContentPart',
        part: {
          type: 'text',
          text: '1. **Requirement Analysis**: Understanding what you need is the first step.\n',
        },
      }),
      delay(15),
      event({
        type: 'ContentPart',
        part: {
          type: 'text',
          text: '2. **Practical Examples**: Concrete code snippets help illustrate the concepts.\n',
        },
      }),
      delay(15),
      event({
        type: 'ContentPart',
        part: {
          type: 'text',
          text: '3. **Best Practices**: Following established patterns ensures maintainability.\n',
        },
      }),
      delay(20),
      event({
        type: 'StatusUpdate',
        contextUsage: 0.10,
        contextTokens: 1000,
        maxContextTokens: 100000,
        tokenUsage: {
          inputOther: 200,
          output: 300,
          inputCacheRead: 0,
          inputCacheCreation: 0,
        },
      }),
      delay(10),
      event({ type: 'TurnEnd' }),
    ],
  };
}
