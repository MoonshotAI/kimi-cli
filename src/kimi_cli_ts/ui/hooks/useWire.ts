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
import { extractKeyArgument } from "../../tools/types.ts";
import type {
	StatusUpdate,
	ApprovalRequest,
	QuestionRequest,
} from "../../wire/types";
import type { Toast } from "../components/NotificationStack";
import { nanoid } from "nanoid";

const MAX_SUBAGENT_TOOL_CALLS_TO_SHOW = 4;
export interface WireState {
	messages: UIMessage[];
	isStreaming: boolean;
	/** The approval request currently being shown to the user (head of queue). */
	pendingApproval: ApprovalRequest | null;
	/** Full queue of pending approval requests (including the current one). */
	approvalQueue: ApprovalRequest[];
	/** The question request currently being shown to the user (head of queue). */
	pendingQuestion: QuestionRequest | null;
	/** Full queue of pending question requests. */
	questionQueue: QuestionRequest[];
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
	// Approval queue — mirrors Python's deque[ApprovalRequest].
	// The first element is the one currently displayed to the user.
	const [approvalQueue, setApprovalQueue] = useState<ApprovalRequest[]>([]);
	const [questionQueue, setQuestionQueue] = useState<QuestionRequest[]>([]);
	const [status, setStatus] = useState<StatusUpdate | null>(null);
	const [stepCount, setStepCount] = useState(0);
	const [isCompacting, setIsCompacting] = useState(false);
	const [notifications, setNotifications] = useState<Toast[]>([]);

	// Use ref for current assistant message being built
	const currentAssistantRef = useRef<UIMessage | null>(null);

	const pushEvent = useCallback((event: WireUIEvent) => {
		switch (event.type) {
			case "turn_begin": {
				// Add user message (skip for slash commands where userInput is empty)
				if (event.userInput) {
					const userMsg: UIMessage = {
						id: nanoid(),
						role: "user",
						segments: [{ type: "text", text: event.userInput }],
						timestamp: Date.now(),
					};
					setMessages((prev) => [...prev, userMsg]);
				}
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
					// Keep expanded if result has display blocks (e.g. "Rejected: feedback")
					toolSeg.collapsed = event.result.display.length === 0;
				}
				setMessages((prev) => {
					const idx = prev.findIndex((m) => m.id === msg.id);
					if (idx === -1) return prev;
					return [...prev.slice(0, idx), { ...msg }, ...prev.slice(idx + 1)];
				});
				break;
			}

			case "approval_request": {
				// Enqueue — mirrors Python's _queue_approval_request()
				setApprovalQueue((prev) => {
					// Deduplicate: don't enqueue if already present
					if (prev.some((r) => r.id === event.request.id)) return prev;
					return [...prev, event.request];
				});
				break;
			}

			case "approval_response": {
				// Dequeue the resolved request — advances to the next one automatically
				setApprovalQueue((prev) =>
					prev.filter((r) => r.id !== event.requestId),
				);
				break;
			}

			case "question_request": {
				// Enqueue question request — mirrors approval queue pattern
				setQuestionQueue((prev) => {
					if (prev.some((r) => r.id === event.request.id)) return prev;
					return [...prev, event.request];
				});
				break;
			}

			case "question_response": {
				// Dequeue the resolved question
				setQuestionQueue((prev) =>
					prev.filter((r) => r.id !== event.requestId),
				);
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
				// Insert a system message for slash command feedback (matches Python's wire_send(TextPart(...)))
				const sysMsg: UIMessage = {
					id: nanoid(),
					role: "system",
					segments: [{ type: "text", text: event.text }],
					timestamp: Date.now(),
				};
				setMessages((prev) => [...prev, sysMsg]);
				break;
			}

			case "subagent_event": {
				if (!currentAssistantRef.current || !event.parentToolCallId) break;
				const msg = currentAssistantRef.current;
				const toolSeg = msg.segments.find(
					(s) =>
						s.type === "tool_call" &&
						(s as ToolCallSegment).id === event.parentToolCallId,
				) as ToolCallSegment | undefined;
				if (!toolSeg) break;

				// Store subagent metadata
				if (event.agentId) toolSeg.subagentId = event.agentId;
				if (event.subagentType) toolSeg.subagentType = event.subagentType;

				// Initialize tracking structures
				if (!toolSeg.ongoingSubCalls) toolSeg.ongoingSubCalls = {};
				if (!toolSeg.finishedSubCalls) toolSeg.finishedSubCalls = [];

				// Dispatch nested event by type (wire envelope: {type, payload})
				const nested = event.event as Record<string, unknown>;
				const nestedType = nested?.type as string | undefined;
				const nestedPayload = (nested?.payload ?? nested) as Record<
					string,
					unknown
				>;

				if (nestedType === "ToolCall") {
					// New subagent tool call
					const p = nestedPayload as {
						id?: string;
						function?: { name?: string; arguments?: string };
					};
					const callId = (p.id ?? "") as string;
					const fn = p.function;
					if (callId) {
						toolSeg.ongoingSubCalls[callId] = {
							id: callId,
							name: fn?.name ?? "unknown",
							arguments: fn?.arguments ?? "",
						};
					}
				} else if (nestedType === "ToolResult") {
					// Completed subagent tool call
					const p = nestedPayload as {
						tool_call_id?: string;
						return_value?: { isError?: boolean; is_error?: boolean };
					};
					const callId = (p.tool_call_id ?? "") as string;
					const ongoing = callId ? toolSeg.ongoingSubCalls[callId] : undefined;
					if (ongoing) {
						delete toolSeg.ongoingSubCalls[callId];
						const isError =
							p.return_value?.isError ?? p.return_value?.is_error ?? false;
						// Deque behavior: keep last MAX items, track overflow
						if (
							toolSeg.finishedSubCalls.length >= MAX_SUBAGENT_TOOL_CALLS_TO_SHOW
						) {
							toolSeg.finishedSubCalls.shift();
							toolSeg.nExtraSubCalls = (toolSeg.nExtraSubCalls ?? 0) + 1;
						}
						let keyArg = "";
						try {
							keyArg =
								extractKeyArgument(ongoing.arguments, ongoing.name) ?? "";
						} catch {
							/* ignore parse errors */
						}
						toolSeg.finishedSubCalls.push({
							callId: ongoing.id,
							toolName: ongoing.name,
							arguments: keyArg,
							isError,
						});
					}
				}
				// ToolCallPart: update ongoing call arguments
				else if (nestedType === "ToolCallPart") {
					const p = nestedPayload as { id?: string; arguments_part?: string };
					const callId = (p.id ?? "") as string;
					const ongoing = callId ? toolSeg.ongoingSubCalls[callId] : undefined;
					if (ongoing && p.arguments_part) {
						ongoing.arguments += p.arguments_part;
					}
				}

				// Trigger re-render
				setMessages((prev) => {
					const idx = prev.findIndex((m) => m.id === msg.id);
					if (idx === -1) return prev;
					return [...prev.slice(0, idx), { ...msg }, ...prev.slice(idx + 1)];
				});
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
		setApprovalQueue([]);
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

	// The head of the queue is the approval currently shown to the user
	const pendingApproval = approvalQueue.length > 0 ? approvalQueue[0]! : null;
	const pendingQuestion = questionQueue.length > 0 ? questionQueue[0]! : null;

	return {
		messages,
		isStreaming,
		pendingApproval,
		approvalQueue,
		pendingQuestion,
		questionQueue,
		status,
		stepCount,
		isCompacting,
		notifications,
		pushEvent,
		clearMessages,
		dismissNotification,
	};
}
