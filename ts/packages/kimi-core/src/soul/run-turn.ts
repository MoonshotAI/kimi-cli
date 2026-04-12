import type { Message, TokenUsage } from '@moonshot-ai/kosong';
import {
  addUsage,
  createToolMessage,
  createUserMessage,
  emptyUsage,
  step,
} from '@moonshot-ai/kosong';

import type { EventSink } from './event-sink.js';
import type { Runtime } from './runtime.js';
import type { TurnResult } from './types.js';

export async function runTurn(
  input: string,
  runtime: Runtime,
  sink: EventSink,
  signal: AbortSignal,
): Promise<TurnResult> {
  const history: Message[] = [createUserMessage(input)];
  let stepCount = 0;
  // Accumulate usage across every step in this turn, so multi-step turns
  // correctly report the total cost (Codex P2 review finding).
  let accumulatedUsage: TokenUsage | null = null;

  while (stepCount < runtime.maxStepsPerTurn) {
    if (signal.aborted) {
      return { stopReason: 'cancelled', stepCount, usage: accumulatedUsage };
    }

    sink.emit({ type: 'step.begin', stepNumber: stepCount });

    const result = await step(runtime.llm, '', runtime.toolset, history, undefined, { signal });

    if (result.usage !== null) {
      accumulatedUsage = addUsage(accumulatedUsage ?? emptyUsage(), result.usage);
    }
    history.push(result.message);

    // Emit all content parts (text, think, image_url, audio_url, video_url)
    // so downstream UIs don't silently lose reasoning or media output.
    for (const part of result.message.content) {
      sink.emit({ type: 'content.delta', part });
    }

    // Emit tool call events
    for (const tc of result.toolCalls) {
      sink.emit({ type: 'tool.call', toolCall: tc });
    }

    if (result.toolCalls.length === 0) {
      sink.emit({ type: 'step.end' });
      stepCount++;
      return { stopReason: 'done', stepCount, usage: accumulatedUsage };
    }

    // Await tool results and append to history
    const toolResults = await result.toolResults();
    for (const tr of toolResults) {
      // Forward the raw output verbatim. It may be a plain string or a
      // list of ContentParts (multimodal tool result). Stringifying here
      // would silently drop image/audio/video parts and leave downstream
      // consumers with an empty `output` field.
      sink.emit({
        type: 'tool.result',
        toolCallId: tr.toolCallId,
        output: tr.returnValue.output,
        isError: tr.returnValue.isError,
      });
      history.push(createToolMessage(tr.toolCallId, tr.returnValue.output));
    }

    sink.emit({ type: 'step.end' });
    stepCount++;
  }

  return { stopReason: 'max_steps', stepCount, usage: accumulatedUsage };
}
