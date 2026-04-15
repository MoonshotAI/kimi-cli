/**
 * Simple chat scenario -- Markdown-rich text streaming.
 *
 * Flow: turn.begin -> step.begin -> content.delta(think) * N
 *       -> content.delta(text) * N -> status.update -> step.end -> turn.end
 */

import type { Scenario } from '../mock-event-generator.js';
import { evt, delay } from '../mock-event-generator.js';
import { createEvent } from '../types.js';
import type { TurnBeginData, StepBeginData, ContentDeltaData, StatusUpdateData, StepEndData, TurnEndData } from '../types.js';

export function simpleChatScenario(userInput: string, sessionId: string, turnId: string): Scenario {
  const opts = { session_id: sessionId, turn_id: turnId };

  return {
    name: 'simple-chat',
    description: 'Simple text conversation with Markdown formatting',
    steps: [
      evt(createEvent('turn.begin', { turn_id: turnId, user_input: userInput, input_kind: 'user' } satisfies TurnBeginData, opts)),
      delay(100),
      evt(createEvent('step.begin', { step: 1 } satisfies StepBeginData, opts)),
      delay(800),
      // Thinking phase
      evt(createEvent('content.delta', { type: 'think', think: 'Let me think about how to respond to this...' } satisfies ContentDeltaData, opts)),
      delay(300),
      evt(createEvent('content.delta', { type: 'think', think: ' I should provide a helpful and detailed answer.' } satisfies ContentDeltaData, opts)),
      delay(500),
      evt(createEvent('content.delta', { type: 'think', think: ' Let me organize my thoughts and give a clear response.' } satisfies ContentDeltaData, opts)),
      delay(400),
      // Text response with rich Markdown
      evt(createEvent('content.delta', { type: 'text', text: '# Hello from Kimi\n\n' } satisfies ContentDeltaData, opts)),
      delay(80),
      evt(createEvent('content.delta', { type: 'text', text: 'I am **Kimi**, your AI coding assistant. ' } satisfies ContentDeltaData, opts)),
      delay(60),
      evt(createEvent('content.delta', { type: 'text', text: 'I can help you with a wide range of *software engineering* tasks.\n\n' } satisfies ContentDeltaData, opts)),
      delay(80),
      evt(createEvent('content.delta', { type: 'text', text: '## What I Can Do\n\n' } satisfies ContentDeltaData, opts)),
      delay(80),
      evt(createEvent('content.delta', { type: 'text', text: 'Here are some things I can help with:\n\n' } satisfies ContentDeltaData, opts)),
      delay(80),
      evt(createEvent('content.delta', { type: 'text', text: '- **Read and understand code** -- I can analyze your codebase\n' } satisfies ContentDeltaData, opts)),
      delay(60),
      evt(createEvent('content.delta', { type: 'text', text: '- **Write and edit code** -- from fixing bugs to new features\n' } satisfies ContentDeltaData, opts)),
      delay(60),
      evt(createEvent('content.delta', { type: 'text', text: '- **Run commands** -- execute shell commands and manage workflows\n' } satisfies ContentDeltaData, opts)),
      delay(60),
      evt(createEvent('content.delta', { type: 'text', text: '- **Search and research** -- find files and look up documentation\n\n' } satisfies ContentDeltaData, opts)),
      delay(80),
      evt(createEvent('content.delta', { type: 'text', text: '### Quick Example\n\n' } satisfies ContentDeltaData, opts)),
      delay(80),
      evt(createEvent('content.delta', { type: 'text', text: 'Here is a simple TypeScript function:\n\n' } satisfies ContentDeltaData, opts)),
      delay(60),
      evt(createEvent('content.delta', { type: 'text', text: '```typescript\n' } satisfies ContentDeltaData, opts)),
      delay(40),
      evt(createEvent('content.delta', { type: 'text', text: 'function greet(name: string): string {\n' } satisfies ContentDeltaData, opts)),
      delay(40),
      evt(createEvent('content.delta', { type: 'text', text: '  return `Hello, ${name}!`;\n' } satisfies ContentDeltaData, opts)),
      delay(40),
      evt(createEvent('content.delta', { type: 'text', text: '}\n' } satisfies ContentDeltaData, opts)),
      delay(40),
      evt(createEvent('content.delta', { type: 'text', text: '```\n\n' } satisfies ContentDeltaData, opts)),
      delay(80),
      evt(createEvent('content.delta', { type: 'text', text: 'You can call it with `greet("World")`. ' } satisfies ContentDeltaData, opts)),
      delay(60),
      evt(createEvent('content.delta', { type: 'text', text: 'Check the [TypeScript docs](https://www.typescriptlang.org) for more info.\n\n' } satisfies ContentDeltaData, opts)),
      delay(80),
      evt(createEvent('content.delta', { type: 'text', text: '> **Tip**: Use `--strict` mode for better type safety.\n\n' } satisfies ContentDeltaData, opts)),
      delay(80),
      evt(createEvent('content.delta', { type: 'text', text: 'What would you like to work on today?' } satisfies ContentDeltaData, opts)),
      delay(200),
      // Status update
      evt(createEvent('status.update', {
        context_usage: 0.08,
        context_tokens: 1250,
        max_context_tokens: 100000,
        token_usage: {
          input_other: 350,
          output: 280,
          input_cache_read: 0,
          input_cache_creation: 0,
        },
      } satisfies StatusUpdateData, opts)),
      delay(50),
      evt(createEvent('step.end', {} satisfies StepEndData, opts)),
      delay(10),
      evt(createEvent('turn.end', { turn_id: turnId, reason: 'done', success: true } satisfies TurnEndData, opts)),
    ],
  };
}
