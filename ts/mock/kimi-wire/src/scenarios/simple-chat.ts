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
      delay(100),
      event({ type: 'StepBegin', n: 1 }),
      delay(800),
      // Thinking phase
      event({
        type: 'ContentPart',
        part: { type: 'think', think: 'Let me think about how to respond to this...' },
      }),
      delay(300),
      event({
        type: 'ContentPart',
        part: { type: 'think', think: ' I should provide a helpful and detailed answer.' },
      }),
      delay(500),
      event({
        type: 'ContentPart',
        part: { type: 'think', think: ' Let me organize my thoughts and give a clear response.' },
      }),
      delay(400),
      // Text response — longer, with realistic typing delays
      event({
        type: 'ContentPart',
        part: { type: 'text', text: 'Hello! ' },
      }),
      delay(80),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: 'I am Kimi, ' },
      }),
      delay(60),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: 'your AI coding assistant. ' },
      }),
      delay(80),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: 'I can help you with a wide range of software engineering tasks.\n\n' },
      }),
      delay(100),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: 'Here are some things I can do:\n\n' },
      }),
      delay(80),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: '1. **Read and understand code** — ' },
      }),
      delay(60),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: 'I can analyze your codebase, ' },
      }),
      delay(50),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: 'explain how things work, ' },
      }),
      delay(50),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: 'and help you navigate complex architectures.\n' },
      }),
      delay(80),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: '2. **Write and edit code** — ' },
      }),
      delay(60),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: 'From fixing bugs to implementing new features, ' },
      }),
      delay(50),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: 'I can write production-quality code.\n' },
      }),
      delay(80),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: '3. **Run commands** — ' },
      }),
      delay(60),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: 'I can execute shell commands, ' },
      }),
      delay(50),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: 'run tests, build your project, ' },
      }),
      delay(50),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: 'and manage your development workflow.\n' },
      }),
      delay(80),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: '4. **Search and research** — ' },
      }),
      delay(60),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: 'I can search through your codebase, ' },
      }),
      delay(50),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: 'find relevant files, and look up documentation.\n\n' },
      }),
      delay(100),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: 'What would you like to work on today?' },
      }),
      delay(200),
      // Status update
      event({
        type: 'StatusUpdate',
        contextUsage: 0.08,
        contextTokens: 1250,
        maxContextTokens: 100000,
        tokenUsage: {
          inputOther: 350,
          output: 280,
          inputCacheRead: 0,
          inputCacheCreation: 0,
        },
      }),
      delay(50),
      event({ type: 'TurnEnd' }),
    ],
  };
}
