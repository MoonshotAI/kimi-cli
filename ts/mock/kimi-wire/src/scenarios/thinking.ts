/**
 * Thinking scenario -- extended thinking process before responding.
 *
 * Flow: turn.begin -> step.begin -> content.delta(think) * many
 *       -> content.delta(text) * N -> status.update -> step.end -> turn.end
 */

import type { Scenario } from '../mock-event-generator.js';
import { evt, delay } from '../mock-event-generator.js';
import { createEvent } from '../types.js';
import type { TurnBeginData, StepBeginData, StepEndData, ContentDeltaData, StatusUpdateData, TurnEndData } from '../types.js';

export function thinkingScenario(userInput: string, sessionId: string = '__mock__', turnId: string = 'turn_0'): Scenario {
  const opts = { session_id: sessionId, turn_id: turnId };

  return {
    name: 'thinking',
    description: 'Extended thinking before responding',
    steps: [
      evt(createEvent('turn.begin', { turn_id: turnId, user_input: userInput, input_kind: 'user' } satisfies TurnBeginData, opts)),
      delay(50),
      evt(createEvent('step.begin', { step: 1 } satisfies StepBeginData, opts)),
      delay(30),
      // Long thinking phase with multiple chunks
      evt(createEvent('content.delta', { type: 'think', think: 'This is an interesting question. ' } satisfies ContentDeltaData, opts)),
      delay(40),
      evt(createEvent('content.delta', { type: 'think', think: 'Let me break it down step by step.\n\n' } satisfies ContentDeltaData, opts)),
      delay(40),
      evt(createEvent('content.delta', { type: 'think', think: 'First, I should consider the requirements:\n' } satisfies ContentDeltaData, opts)),
      delay(30),
      evt(createEvent('content.delta', { type: 'think', think: '1. The user wants a thorough analysis\n' } satisfies ContentDeltaData, opts)),
      delay(30),
      evt(createEvent('content.delta', { type: 'think', think: '2. I need to provide practical examples\n' } satisfies ContentDeltaData, opts)),
      delay(30),
      evt(createEvent('content.delta', { type: 'think', think: '3. The answer should be well-structured\n\n' } satisfies ContentDeltaData, opts)),
      delay(40),
      evt(createEvent('content.delta', { type: 'think', think: 'Now, let me formulate a comprehensive response that addresses all these points.' } satisfies ContentDeltaData, opts)),
      delay(50),
      // Actual text response
      evt(createEvent('content.delta', { type: 'text', text: 'After careful consideration, here is my analysis:\n\n' } satisfies ContentDeltaData, opts)),
      delay(20),
      evt(createEvent('content.delta', { type: 'text', text: '## Key Points\n\n' } satisfies ContentDeltaData, opts)),
      delay(15),
      evt(createEvent('content.delta', { type: 'text', text: '1. **Requirement Analysis**: Understanding what you need is the first step.\n' } satisfies ContentDeltaData, opts)),
      delay(15),
      evt(createEvent('content.delta', { type: 'text', text: '2. **Practical Examples**: Concrete code snippets help illustrate the concepts.\n' } satisfies ContentDeltaData, opts)),
      delay(15),
      evt(createEvent('content.delta', { type: 'text', text: '3. **Best Practices**: Following established patterns ensures maintainability.\n' } satisfies ContentDeltaData, opts)),
      delay(20),
      evt(createEvent('status.update', {
        context_usage: 0.10,
        context_tokens: 1000,
        max_context_tokens: 100000,
        token_usage: {
          input_other: 200,
          output: 300,
          input_cache_read: 0,
          input_cache_creation: 0,
        },
      } satisfies StatusUpdateData, opts)),
      delay(10),
      evt(createEvent('step.end', {} satisfies StepEndData, opts)),
      delay(10),
      evt(createEvent('turn.end', { turn_id: turnId, reason: 'done', success: true } satisfies TurnEndData, opts)),
    ],
  };
}
