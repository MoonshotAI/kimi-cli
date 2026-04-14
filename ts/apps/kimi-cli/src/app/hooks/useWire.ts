/**
 * Wire client integration hook.
 *
 * Manages the streaming lifecycle:
 *  1. User calls `sendMessage(input)`.
 *  2. The hook calls `wireClient.prompt(input)` and iterates the event stream.
 *  3. ContentPart(text) events are appended to `streamingText`.
 *  4. ToolCall events push a tool_call block with structured data.
 *  5. ToolResult events push a tool_result block with structured data.
 *  6. ApprovalRequest events pause the stream and expose `pendingApproval`.
 *  7. On TurnEnd the accumulated text is pushed into `completedBlocks` and
 *     `streamingText` is reset.
 *
 * Also handles cancellation via `cancelStream()`.
 */

import { useCallback, useRef, useState } from 'react';

import type {
  WireClient,
  WireEvent,
  ApprovalRequestEvent,
  ApprovalResponsePayload,
  ToolCall,
} from '@moonshot-ai/kimi-wire-mock';

import type { AppState, CompletedBlock, ToolCallData } from '../context.js';

export interface UseWireResult {
  completedBlocks: CompletedBlock[];
  pushBlock: (block: CompletedBlock) => void;
  streamingThinkText: string;
  streamingText: string;
  setStreamingText: (text: string) => void;
  sendMessage: (input: string) => void;
  cancelStream: () => void;
  pendingToolCall: import('../context.js').ToolCallData | null;
  pendingApproval: ApprovalRequestEvent | null;
  handleApprovalResponse: (response: ApprovalResponsePayload) => void;
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
  const [streamingThinkText, setStreamingThinkText] = useState('');
  const [streamingText, setStreamingText] = useState('');
  const [pendingToolCall, setPendingToolCall] = useState<ToolCallData | null>(null);
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequestEvent | null>(null);
  const isStreamingRef = useRef(false);
  const accumulatedTextRef = useRef('');
  const accumulatedThinkRef = useRef('');

  // Track active tool calls by ID so we can pair them with results.
  const activeToolCallsRef = useRef<Map<string, ToolCall>>(new Map());

  // Approval resolution callback -- set during stream processing.
  const approvalResolverRef = useRef<((response: ApprovalResponsePayload) => void) | null>(null);

  const pushBlock = useCallback((block: CompletedBlock) => {
    setCompletedBlocks((prev) => [...prev, block]);
  }, []);

  const cancelStream = useCallback(() => {
    wireClient.cancel();
  }, [wireClient]);

  const handleApprovalResponse = useCallback(
    (response: ApprovalResponsePayload) => {
      const approval = pendingApproval;
      if (approval === null) return;

      // Send response to the wire client.
      wireClient.approvalResponse(approval.id, response);

      // Clear the pending approval state.
      setPendingApproval(null);

      // If there is a resolver (for the async stream pause), call it.
      if (approvalResolverRef.current !== null) {
        approvalResolverRef.current(response);
        approvalResolverRef.current = null;
      }
    },
    [pendingApproval, wireClient],
  );

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
      activeToolCallsRef.current.clear();
      setStreamingThinkText('');
      setStreamingText('');
      setPendingToolCall(null);
      setPendingApproval(null);
      isStreamingRef.current = true;
      setState({ isStreaming: true, streamingPhase: 'waiting', streamingStartTime: Date.now() });

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
          // If we were thinking, flush thinking to Static first
          if (accumulatedThinkRef.current.length > 0) {
            const thinkBlock: CompletedBlock = {
              id: nextBlockId(),
              type: 'thinking',
              content: accumulatedThinkRef.current,
            };
            setCompletedBlocks((prev) => [...prev, thinkBlock]);
            accumulatedThinkRef.current = '';
            setStreamingThinkText('');
          }
          accumulatedTextRef.current += event.part.text;
          setStreamingText(accumulatedTextRef.current);
          setState({ streamingPhase: 'composing', streamingStartTime: Date.now() });
        } else if (event.part.type === 'think') {
          accumulatedThinkRef.current += event.part.think;
          setStreamingThinkText(accumulatedThinkRef.current);
          setState({ streamingPhase: 'thinking' });
        }
        break;
      }
      case 'ToolCall': {
        const tc = event.toolCall;
        activeToolCallsRef.current.set(tc.id, tc);

        // Flush any accumulated text before showing tool call
        flushStreamingText();

        // Show in dynamic area with loading spinner (no result yet)
        setPendingToolCall({ toolCall: tc });
        break;
      }
      case 'ToolResult': {
        const matchedCall = activeToolCallsRef.current.get(event.toolCallId);
        const toolName = matchedCall?.function.name ?? 'unknown';

        // Move from dynamic area to Static — now with result (green/red)
        setPendingToolCall(null);

        if (matchedCall) {
          const toolCallBlock: CompletedBlock = {
            id: nextBlockId(),
            type: 'tool_call',
            content: `Used ${toolName}`,
            toolCallData: {
              toolCall: matchedCall,
              result: event.returnValue,
            },
          };
          setCompletedBlocks((prev) => [...prev, toolCallBlock]);
        }

        // Clean up the active tool call
        activeToolCallsRef.current.delete(event.toolCallId);
        break;
      }
      case 'ApprovalRequest': {
        // Flush any accumulated text before showing the approval panel.
        flushStreamingText();
        setPendingApproval(event);
        break;
      }
      case 'ApprovalResponse': {
        // This event comes from the mock scenario after we respond.
        // Just clear the approval state if it somehow wasn't cleared.
        setPendingApproval(null);
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
        // Other events not yet handled.
        break;
    }
  }

  function flushStreamingText(): void {
    if (accumulatedThinkRef.current.length > 0) {
      const thinkBlock: CompletedBlock = {
        id: nextBlockId(),
        type: 'thinking',
        content: accumulatedThinkRef.current,
      };
      setCompletedBlocks((prev) => [...prev, thinkBlock]);
      accumulatedThinkRef.current = '';
    }

    if (accumulatedTextRef.current.length > 0) {
      const assistantBlock: CompletedBlock = {
        id: nextBlockId(),
        type: 'assistant',
        content: accumulatedTextRef.current,
      };
      setCompletedBlocks((prev) => [...prev, assistantBlock]);
      accumulatedTextRef.current = '';
      setStreamingText('');
    }
  }

  function finalizeTurn(): void {
    if (!isStreamingRef.current) {
      return;
    }

    flushStreamingText();

    // Reset streaming state.
    accumulatedTextRef.current = '';
    accumulatedThinkRef.current = '';
    setStreamingText('');
    isStreamingRef.current = false;
    setState({ isStreaming: false, streamingPhase: 'idle' });
  }

  return {
    completedBlocks,
    pushBlock,
    streamingThinkText,
    streamingText,
    setStreamingText,
    sendMessage,
    cancelStream,
    pendingToolCall,
    pendingApproval,
    handleApprovalResponse,
  };
}
