/**
 * useWire hook — subscribes to Wire EventBus and accumulates renderable messages.
 * Corresponds to the event-processing logic in Python's visualize.py.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type {
  UIMessage,
  WireUIEvent,
  TextSegment,
  ThinkSegment,
  ToolCallSegment,
} from "../shell/events";
import type { StatusUpdate, ApprovalRequest } from "../../wire/types";
import type { Toast } from "../components/NotificationStack";
import { nanoid } from "nanoid";

export interface WireState {
  messages: UIMessage[];
  isStreaming: boolean;
  pendingApproval: ApprovalRequest | null;
  status: StatusUpdate | null;
  stepCount: number;
  isCompacting: boolean;
  notifications: Toast[];
}

export interface UseWireOptions {
  /** External event source — call pushEvent to feed events */
  onReady?: (pushEvent: (event: WireUIEvent) => void) => void;
}

/**
 * Hook that accumulates wire events into a renderable message list.
 */
export function useWire(options?: UseWireOptions): WireState & {
  pushEvent: (event: WireUIEvent) => void;
  clearMessages: () => void;
  dismissNotification: (id: string) => void;
} {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingApproval, setPendingApproval] =
    useState<ApprovalRequest | null>(null);
  const [status, setStatus] = useState<StatusUpdate | null>(null);
  const [stepCount, setStepCount] = useState(0);
  const [isCompacting, setIsCompacting] = useState(false);
  const [notifications, setNotifications] = useState<Toast[]>([]);

  // Use ref for current assistant message being built
  const currentAssistantRef = useRef<UIMessage | null>(null);

  const pushEvent = useCallback((event: WireUIEvent) => {
    switch (event.type) {
      case "turn_begin": {
        // Add user message
        const userMsg: UIMessage = {
          id: nanoid(),
          role: "user",
          segments: [{ type: "text", text: event.userInput }],
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, userMsg]);
        setIsStreaming(true);
        setStepCount(0);
        // Start new assistant message
        const assistantMsg: UIMessage = {
          id: nanoid(),
          role: "assistant",
          segments: [],
          timestamp: Date.now(),
        };
        currentAssistantRef.current = assistantMsg;
        setMessages((prev) => [...prev, assistantMsg]);
        break;
      }

      case "turn_end": {
        currentAssistantRef.current = null;
        setIsStreaming(false);
        break;
      }

      case "step_begin": {
        setStepCount(event.n);
        break;
      }

      case "step_interrupted": {
        setIsStreaming(false);
        break;
      }

      case "text_delta": {
        if (!currentAssistantRef.current) break;
        const msg = currentAssistantRef.current;
        const lastSeg = msg.segments[msg.segments.length - 1];
        if (lastSeg && lastSeg.type === "text") {
          (lastSeg as TextSegment).text += event.text;
        } else {
          msg.segments.push({ type: "text", text: event.text });
        }
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === msg.id);
          if (idx === -1) return prev;
          return [...prev.slice(0, idx), { ...msg }, ...prev.slice(idx + 1)];
        });
        break;
      }

      case "think_delta": {
        if (!currentAssistantRef.current) break;
        const msg = currentAssistantRef.current;
        const lastSeg = msg.segments[msg.segments.length - 1];
        if (lastSeg && lastSeg.type === "think") {
          (lastSeg as ThinkSegment).text += event.text;
        } else {
          msg.segments.push({ type: "think", text: event.text });
        }
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === msg.id);
          if (idx === -1) return prev;
          return [...prev.slice(0, idx), { ...msg }, ...prev.slice(idx + 1)];
        });
        break;
      }

      case "tool_call": {
        if (!currentAssistantRef.current) break;
        const msg = currentAssistantRef.current;
        msg.segments.push({
          type: "tool_call",
          id: event.id,
          name: event.name,
          arguments: event.arguments,
          collapsed: false,
        });
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === msg.id);
          if (idx === -1) return prev;
          return [...prev.slice(0, idx), { ...msg }, ...prev.slice(idx + 1)];
        });
        break;
      }

      case "tool_result": {
        if (!currentAssistantRef.current) break;
        const msg = currentAssistantRef.current;
        const toolSeg = msg.segments.find(
          (s) =>
            s.type === "tool_call" &&
            (s as ToolCallSegment).id === event.toolCallId,
        ) as ToolCallSegment | undefined;
        if (toolSeg) {
          toolSeg.result = event.result;
          toolSeg.collapsed = true;
        }
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === msg.id);
          if (idx === -1) return prev;
          return [...prev.slice(0, idx), { ...msg }, ...prev.slice(idx + 1)];
        });
        break;
      }

      case "approval_request": {
        setPendingApproval(event.request);
        break;
      }

      case "approval_response": {
        setPendingApproval(null);
        break;
      }

      case "status_update": {
        setStatus(event.status);
        break;
      }

      case "compaction_begin": {
        setIsCompacting(true);
        break;
      }

      case "compaction_end": {
        setIsCompacting(false);
        break;
      }

      case "notification": {
        // Add to notification stack instead of message stream
        const toast: Toast = {
          id: nanoid(),
          title: event.title,
          body: event.body,
          severity: (event.severity as Toast["severity"]) || "info",
          duration: 5000,
          position: "left",
          topic: event.title, // deduplicate by title
          createdAt: Date.now(),
        };
        setNotifications((prev) => {
          // Topic dedup: remove existing toast with same topic
          const filtered = toast.topic
            ? prev.filter((t) => t.topic !== toast.topic)
            : prev;
          return [...filtered, toast];
        });
        break;
      }

      case "slash_result": {
        // Atomically insert a user+assistant message pair (for slash command feedback)
        const userMsg: UIMessage = {
          id: nanoid(),
          role: "user",
          segments: [{ type: "text", text: event.userInput }],
          timestamp: Date.now(),
        };
        const assistantMsg: UIMessage = {
          id: nanoid(),
          role: "assistant",
          segments: [{ type: "text", text: event.text }],
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, userMsg, assistantMsg]);
        break;
      }

      case "error": {
        // Errors are also shown as notifications with longer duration
        const toast: Toast = {
          id: nanoid(),
          title: "Error",
          body: event.message,
          severity: "error",
          duration: event.retryable ? 0 : 6000, // retryable errors don't auto-dismiss
          position: "left",
          createdAt: Date.now(),
        };
        setNotifications((prev) => [...prev, toast]);
        setIsStreaming(false);
        break;
      }
    }
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
    currentAssistantRef.current = null;
    setIsStreaming(false);
    setPendingApproval(null);
    setStepCount(0);
  }, []);

  const dismissNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  // Notify caller that pushEvent is ready
  const onReady = options?.onReady;
  useEffect(() => {
    onReady?.(pushEvent);
  }, [pushEvent, onReady]);

  return {
    messages,
    isStreaming,
    pendingApproval,
    status,
    stepCount,
    isCompacting,
    notifications,
    pushEvent,
    clearMessages,
    dismissNotification,
  };
}
