import { useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
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

  // if no pending approval request, do not render anything
  if (!pendingApproval) return null;

  const { approval, toolCall } = pendingApproval;
  const approvalPending = approval.id
    ? pendingApprovalMap[approval.id] === true
    : false;
  const disableActions =
    !(canRespondToApproval && onApprovalResponse) || approvalPending;

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
          "relative w-full border border-border/60 bg-background/80 shadow-md",
          "rounded-lg px-4 py-3",
          "transition-all duration-200",
          "max-h-[70vh]",
          "overflow-hidden",
        )}
      >
        <div className="flex flex-col gap-3">
          {/* Header */}
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <div className="size-2 rounded-full bg-blue-500 animate-pulse" />
                <div className="font-semibold text-foreground">
                  Allow this {approval.action}?
                </div>
              </div>
              {approval.sender && (
                <div className="mt-1 text-xs text-muted-foreground">
                  Requested by <span className="font-medium">{approval.sender}</span>
                </div>
              )}
            </div>
          </div>

          {/* Description */}
          {approval.description && (
            <div className="rounded-md bg-muted/40 p-3 text-sm text-foreground border border-border/60 w-full max-h-44 overflow-auto">
              <pre className="font-mono text-xs whitespace-pre-wrap">
                {approval.description}
              </pre>
            </div>
          )}

          {/* Display blocks (if any) */}
          {toolCall.display && toolCall.display.length > 0 && (
            <div className="rounded-md border border-border/60 bg-muted/30 p-3 text-sm max-h-40 overflow-auto">
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
          <div className="flex flex-wrap items-center gap-4">
            {options.map((option) => (
              <Button
                key={option.key}
                size="sm"
                variant="outline"
                disabled={disableActions}
                onClick={() => handleResponse(option.key)}
                className={cn(
                  "relative transition-all",
                  option.key === "reject" &&
                    "text-destructive hover:bg-destructive/10 hover:text-destructive",
                )}
              >
                {approvalPending
                  ? `${option.label}ing...`
                  : option.label}
              </Button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
