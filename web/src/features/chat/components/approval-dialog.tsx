import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import type { ApprovalResponseDecision } from "@/hooks/wireTypes";
import type { LiveMessage } from "@/hooks/types";

type ApprovalDialogProps = {
  messages: LiveMessage[];
  onApprovalResponse?: (
    requestId: string,
    decision: ApprovalResponseDecision,
    reason?: string,
  ) => Promise<void>;
  pendingApprovalMap: Record<string, boolean>;
  canRespondToApproval: boolean;
};

export function ApprovalDialog({
  messages,
  onApprovalResponse,
  pendingApprovalMap,
  canRespondToApproval,
}: ApprovalDialogProps) {
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const feedbackInputRef = useRef<HTMLTextAreaElement>(null);

  // from messages, extract the pending approval request
  const pendingApproval = useMemo(() => {
    for (const message of messages) {
      if (
        message.variant === "tool" &&
        message.toolCall?.approval &&
        message.toolCall.state === "approval-requested" &&
        !message.toolCall.approval.submitted
      ) {
        return {
          message,
          approval: message.toolCall.approval,
          toolCall: message.toolCall,
        };
      }
    }
    return null;
  }, [messages]);

  // Reset feedback state when the pending approval changes
  const currentApprovalId = pendingApproval?.approval?.id;
  const prevApprovalIdRef = useRef(currentApprovalId);
  if (prevApprovalIdRef.current !== currentApprovalId) {
    prevApprovalIdRef.current = currentApprovalId;
    // Always clear stale feedback text, not just when feedbackMode is active.
    // Otherwise old text leaks into the next approval's feedback input.
    if (feedbackMode || feedbackText) {
      setFeedbackMode(false);
      setFeedbackText("");
    }
  }

  const handleResponse = useCallback(
    async (decision: ApprovalResponseDecision, reason?: string) => {
      if (!(pendingApproval && onApprovalResponse)) return;

      const { approval } = pendingApproval;
      if (!approval.id) return;

      try {
        await onApprovalResponse(approval.id, decision, reason);
      } catch (error) {
        console.error("[ApprovalDialog] Failed to respond", error);
      }
    },
    [pendingApproval, onApprovalResponse],
  );

  const handleFeedbackSubmit = useCallback(() => {
    const trimmed = feedbackText.trim();
    if (!trimmed) return;
    setFeedbackMode(false);
    setFeedbackText("");
    handleResponse("reject", trimmed);
  }, [feedbackText, handleResponse]);

  // Compute disable state before early return (hooks must run unconditionally)
  const approvalId = pendingApproval?.approval?.id;
  const approvalPending = approvalId
    ? pendingApprovalMap[approvalId] === true
    : false;
  const disableActions =
    !(canRespondToApproval && onApprovalResponse) || approvalPending;

  // Focus the feedback input when feedback mode is activated
  useEffect(() => {
    if (feedbackMode) {
      // Use rAF to wait for the DOM to be ready after state update
      requestAnimationFrame(() => {
        feedbackInputRef.current?.focus();
      });
    }
  }, [feedbackMode]);

  // Keyboard shortcuts: 1=Approve, 2=Approve for session, 3=Decline, 4=Decline with feedback
  useEffect(() => {
    if (!pendingApproval || disableActions) return;
    // When in feedback mode, don't handle number shortcuts
    if (feedbackMode) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.repeat) return;
      if (event.isComposing) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      // Skip when any input element is focused
      const el = document.activeElement;
      if (el) {
        const tag = el.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if ((el as HTMLElement).isContentEditable) return;
      }

      if (event.key === "4") {
        event.preventDefault();
        setFeedbackMode(true);
        return;
      }

      const keyMap: Record<string, ApprovalResponseDecision> = {
        "1": "approve",
        "2": "approve_for_session",
        "3": "reject",
      };
      const decision = keyMap[event.key];
      if (decision) {
        event.preventDefault();
        handleResponse(decision);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [pendingApproval, disableActions, handleResponse, feedbackMode]);

  // if no pending approval request, do not render anything
  if (!pendingApproval) return null;

  const { approval, toolCall } = pendingApproval;

  const sourceLabel = (() => {
    if (approval.sourceDescription) return approval.sourceDescription;
    const agentType = toolCall.subagentType;
    const agentId = toolCall.subagentAgentId;
    const idSuffix = agentId ? ` (${agentId})` : "";
    if (approval.sourceKind === "background_agent") {
      return agentType
        ? `Background · ${agentType}${idSuffix}`
        : `Background agent${idSuffix}`;
    }
    // Foreground sub-agent approvals (isSubagentOrigin)
    if (toolCall.isSubagentOrigin) {
      return agentType
        ? `${agentType}${idSuffix}`
        : `Sub-agent${idSuffix}`;
    }
    return null;
  })();

  return (
    <div className="px-3 pb-2 w-full">
      <div
        role="alert"
        className={cn(
          "relative w-full border border-border/60 shadow-xs",
          "border-l border-l-blue-400/50",
          "rounded-lg px-4 py-3",
          "transition-all duration-200",
          "max-h-[70vh]",
          "overflow-hidden",
        )}
      >
        <div className="flex flex-col gap-2.5">
          {/* Header */}
          <div className="flex items-center gap-2">
            <div className="size-2 rounded-full bg-blue-400 animate-pulse flex-shrink-0" />
            <div className="font-semibold text-sm text-foreground">
              Allow this {approval.action}?
            </div>
            {approval.sender && (
              <span className="text-xs text-muted-foreground">
                · {approval.sender}
              </span>
            )}
            {sourceLabel && (
              <span className="text-xs text-muted-foreground/70 bg-muted/50 px-1.5 py-0.5 rounded">
                {sourceLabel}
              </span>
            )}
          </div>

          {/* Description */}
          {approval.description && (
            <div className="rounded-md bg-muted/50 px-3 py-2 w-full max-h-44 overflow-auto">
              <pre className="font-mono text-xs whitespace-pre-wrap text-foreground/90">
                {approval.description}
              </pre>
            </div>
          )}

          {/* Display blocks (if any) */}
          {toolCall.display && toolCall.display.length > 0 && (
            <div className="rounded-md bg-muted/30 px-3 py-2 text-sm max-h-40 overflow-auto">
              {toolCall.display.map((item) => {
                const displayKeyBase =
                  typeof item.data === "string" ||
                  typeof item.data === "number" ||
                  typeof item.data === "boolean"
                    ? `${item.type}:${item.data}`
                    : item.data == null
                      ? `${item.type}:null`
                      : (() => {
                          try {
                            return `${item.type}:${JSON.stringify(item.data)}`;
                          } catch {
                            return `${item.type}:unserializable`;
                          }
                        })();
                const displayKey = `${toolCall.toolCallId ?? toolCall.title}:${displayKeyBase}`;

                return (
                  <div key={displayKey} className="font-mono text-xs">
                    {JSON.stringify(item, null, 2)}
                  </div>
                );
              })}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={disableActions}
              onClick={() => handleResponse("approve")}
              className="transition-all"
            >
              {approvalPending ? "Approving..." : "Approve"}
              {!approvalPending && <Kbd className="ml-1.5">1</Kbd>}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={disableActions}
              onClick={() => handleResponse("approve_for_session")}
              className="transition-all"
            >
              {approvalPending ? "Approving..." : "Approve for session"}
              {!approvalPending && <Kbd className="ml-1.5">2</Kbd>}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={disableActions}
              onClick={() => handleResponse("reject")}
              className={cn(
                "transition-all",
                "text-muted-foreground hover:text-destructive hover:bg-destructive/10",
              )}
            >
              {approvalPending ? "Declining..." : "Decline"}
              {!approvalPending && <Kbd className="ml-1.5">3</Kbd>}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={disableActions}
              onClick={() => setFeedbackMode(!feedbackMode)}
              className={cn(
                "transition-all",
                feedbackMode
                  ? "text-foreground bg-muted"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {feedbackMode ? "Cancel feedback" : "Decline with feedback"}
              {!(feedbackMode || approvalPending) && (
                <Kbd className="ml-1.5">4</Kbd>
              )}
            </Button>
          </div>

          {/* Feedback input */}
          {feedbackMode && (
            <div className="flex flex-col gap-1.5">
              <textarea
                ref={feedbackInputRef}
                value={feedbackText}
                onChange={(e) => setFeedbackText(e.target.value)}
                onKeyDown={(e) => {
                  // Guard against IME composition (e.g. Chinese input)
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleFeedbackSubmit();
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setFeedbackMode(false);
                    setFeedbackText("");
                  }
                }}
                placeholder="Tell the model what to do instead..."
                className={cn(
                  "w-full rounded-md border border-border/60 bg-muted/30",
                  "px-3 py-2 text-sm text-foreground",
                  "placeholder:text-muted-foreground/50",
                  "focus:outline-none focus:ring-1 focus:ring-ring",
                  "resize-none",
                )}
                rows={2}
              />
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  Enter to submit · Shift+Enter for newline · Esc to cancel
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!feedbackText.trim()}
                  onClick={handleFeedbackSubmit}
                  className="text-xs"
                >
                  Submit feedback
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
