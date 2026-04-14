/**
 * Simple chat scenario -- Markdown-rich text streaming.
 *
 * Flow: TurnBegin -> StepBegin -> ThinkPart -> TextPart * N -> StatusUpdate -> TurnEnd
 *
 * The response includes various Markdown elements (headings, lists, code blocks,
 * bold, inline code, links, blockquotes) to exercise the MarkdownRenderer.
 */

import type { Scenario } from '../mock-event-generator.js';
import { event, delay } from '../mock-event-generator.js';

export function simpleChatScenario(userInput: string): Scenario {
  return {
    name: 'simple-chat',
    description: 'Simple text conversation with Markdown formatting',
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
      // Text response with rich Markdown
      event({
        type: 'ContentPart',
        part: { type: 'text', text: '# Hello from Kimi\n\n' },
      }),
      delay(80),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: 'I am **Kimi**, your AI coding assistant. ' },
      }),
      delay(60),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: 'I can help you with a wide range of *software engineering* tasks.\n\n' },
      }),
      delay(80),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: '## What I Can Do\n\n' },
      }),
      delay(80),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: 'Here are some things I can help with:\n\n' },
      }),
      delay(80),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: '- **Read and understand code** -- I can analyze your codebase\n' },
      }),
      delay(60),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: '- **Write and edit code** -- from fixing bugs to new features\n' },
      }),
      delay(60),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: '- **Run commands** -- execute shell commands and manage workflows\n' },
      }),
      delay(60),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: '- **Search and research** -- find files and look up documentation\n\n' },
      }),
      delay(80),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: '### Quick Example\n\n' },
      }),
      delay(80),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: 'Here is a simple TypeScript function:\n\n' },
      }),
      delay(60),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: '```typescript\n' },
      }),
      delay(40),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: 'function greet(name: string): string {\n' },
      }),
      delay(40),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: '  return `Hello, ${name}!`;\n' },
      }),
      delay(40),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: '}\n' },
      }),
      delay(40),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: '```\n\n' },
      }),
      delay(80),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: 'You can call it with `greet("World")`. ' },
      }),
      delay(60),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: 'Check the [TypeScript docs](https://www.typescriptlang.org) for more info.\n\n' },
      }),
      delay(80),
      event({
        type: 'ContentPart',
        part: { type: 'text', text: '> **Tip**: Use `--strict` mode for better type safety.\n\n' },
      }),
      delay(80),
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
