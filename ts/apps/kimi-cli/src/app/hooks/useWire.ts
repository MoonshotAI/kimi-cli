/**
 * Wire client integration hook.
 *
 * Manages the streaming lifecycle:
 *  1. User calls `sendMessage(input)`.
 *  2. The hook calls `wireClient.prompt(input)` and iterates the event stream.
 *  3. ContentPart(text) events are appended to `streamingText`.
 *  4. On TurnEnd the accumulated text is pushed into `completedBlocks` and
 *     `streamingText` is reset.
 *
 * Also handles cancellation via `cancelStream()`.
 */

import { useCallback, useRef, useState } from 'react';

import type { WireClient, WireEvent } from '@moonshot-ai/kimi-wire-mock';

import type { AppState, CompletedBlock } from '../context.js';

export interface UseWireResult {
  completedBlocks: CompletedBlock[];
  pushBlock: (block: CompletedBlock) => void;
  streamingText: string;
  setStreamingText: (text: string) => void;
  sendMessage: (input: string) => void;
  cancelStream: () => void;
}

let blockIdCounter = 0;

function nextBlockId(): string {
  blockIdCounter += 1;
  return `block-${String(blockIdCounter)}`;
}

export function useWire(
  wireClient: WireClient,
  setState: (patch: Partial<AppState>) => void,
): UseWireResult {
  const [completedBlocks, setCompletedBlocks] = useState<CompletedBlock[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const isStreamingRef = useRef(false);
  const accumulatedTextRef = useRef('');
  const accumulatedThinkRef = useRef('');

  const pushBlock = useCallback((block: CompletedBlock) => {
    setCompletedBlocks((prev) => [...prev, block]);
  }, []);

  const cancelStream = useCallback(() => {
    wireClient.cancel();
  }, [wireClient]);

  const sendMessage = useCallback(
    (input: string) => {
      if (isStreamingRef.current) {
        return; // Already streaming, ignore.
      }

      // Push user message as a completed block.
      const userBlock: CompletedBlock = {
        id: nextBlockId(),
        type: 'user',
        content: input,
      };
      setCompletedBlocks((prev) => [...prev, userBlock]);

      // Reset streaming state.
      accumulatedTextRef.current = '';
      accumulatedThinkRef.current = '';
      setStreamingText('');
      isStreamingRef.current = true;
      setState({ isStreaming: true });

      // Consume the event stream asynchronously.
      const eventStream = wireClient.prompt(input);

      void (async () => {
        try {
          for await (const event of eventStream) {
            processEvent(event);
          }
        } catch {
          // Stream was cancelled or errored -- treat as end-of-turn.
        } finally {
          // Finalize: push any remaining streamed text as a completed block.
          finalizeTurn();
        }
      })();
    },
    [wireClient, setState],
  );

  function processEvent(event: WireEvent): void {
    switch (event.type) {
      case 'ContentPart': {
        if (event.part.type === 'text') {
          accumulatedTextRef.current += event.part.text;
          setStreamingText(accumulatedTextRef.current);
        } else if (event.part.type === 'think') {
          accumulatedThinkRef.current += event.part.think;
        }
        break;
      }
      case 'StatusUpdate': {
        if (event.contextUsage !== undefined) {
          setState({ contextUsage: event.contextUsage });
        }
        break;
      }
      case 'TurnEnd': {
        finalizeTurn();
        break;
      }
      default:
        // Other events (StepBegin, ToolCall, etc.) are not handled in Phase 4.
        break;
    }
  }

  function finalizeTurn(): void {
    if (!isStreamingRef.current) {
      return;
    }

    // Push thinking block if any thinking content was accumulated.
    if (accumulatedThinkRef.current.length > 0) {
      const thinkBlock: CompletedBlock = {
        id: nextBlockId(),
        type: 'thinking',
        content: accumulatedThinkRef.current,
      };
      setCompletedBlocks((prev) => [...prev, thinkBlock]);
    }

    // Push assistant text block if any text was streamed.
    if (accumulatedTextRef.current.length > 0) {
      const assistantBlock: CompletedBlock = {
        id: nextBlockId(),
        type: 'assistant',
        content: accumulatedTextRef.current,
      };
      setCompletedBlocks((prev) => [...prev, assistantBlock]);
    }

    // Reset streaming state.
    accumulatedTextRef.current = '';
    accumulatedThinkRef.current = '';
    setStreamingText('');
    isStreamingRef.current = false;
    setState({ isStreaming: false });
  }

  return {
    completedBlocks,
    pushBlock,
    streamingText,
    setStreamingText,
    sendMessage,
    cancelStream,
  };
}
