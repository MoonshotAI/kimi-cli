import { useCallback, useEffect, useMemo } from "react";
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

  const handleResponse = useCallback(
    async (decision: ApprovalResponseDecision) => {
      if (!(pendingApproval && onApprovalResponse)) return;

      const { approval } = pendingApproval;
      if (!approval.id) return;

      try {
        await onApprovalResponse(approval.id, decision);
      } catch (error) {
        console.error("[ApprovalDialog] Failed to respond", error);
      }
    },
    [pendingApproval, onApprovalResponse],
  );

  // Compute disable state before early return (hooks must run unconditionally)
  const approvalId = pendingApproval?.approval?.id;
  const approvalPending = approvalId
    ? pendingApprovalMap[approvalId] === true
    : false;
  const disableActions =
    !(canRespondToApproval && onApprovalResponse) || approvalPending;

  // Keyboard shortcuts: 1=Approve, 2=Approve for session, 3=Decline
  useEffect(() => {
    if (!pendingApproval || disableActions) return;

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
  }, [pendingApproval, disableActions, handleResponse]);

  // if no pending approval request, do not render anything
  if (!pendingApproval) return null;

  const { approval, toolCall } = pendingApproval;

  const options = [
    { key: "approve", label: "Approve", index: 1 },
    {
      key: "approve_for_session",
      label: "Approve for session",
      index: 2,
    },
    { key: "reject", label: "Decline", index: 3 },
  ] as const;

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
            {options.map((option) => (
              <Button
                key={option.key}
                size="sm"
                variant={option.key === "reject" ? "ghost" : "outline"}
                disabled={disableActions}
                onClick={() => handleResponse(option.key)}
                className={cn(
                  "transition-all",
                  option.key === "reject" &&
                    "text-muted-foreground hover:text-destructive hover:bg-destructive/10",
                )}
              >
                {approvalPending
                  ? `${option.label}ing...`
                  : option.label}
                {!approvalPending && (
                  <Kbd className="ml-1.5">{option.index}</Kbd>
                )}
              </Button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
