import { useCallback, useMemo, useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ApprovalResponseDecision } from "@/hooks/wireTypes";
import type { LiveMessage } from "@/hooks/types";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";

type ToolApproval = NonNullable<LiveMessage["toolCall"]>["approval"];

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
  const [expanded, setExpanded] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(1);

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
      if (!pendingApproval || !onApprovalResponse) return;

      const { approval } = pendingApproval;
      if (!approval.id) return;

      try {
        await onApprovalResponse(approval.id, decision);
        setSelectedIndex(1);
        setExpanded(false);
      } catch (error) {
        console.error("[ApprovalDialog] Failed to respond", error);
      }
    },
    [pendingApproval, onApprovalResponse],
  );

  // keyboard shortcuts support
  useEffect(() => {
    if (!pendingApproval || !canRespondToApproval || !onApprovalResponse) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      // ignore key events when focused on input elements
      const target = event.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }

      const { approval } = pendingApproval;
      const approvalPending = approval.id
        ? pendingApprovalMap[approval.id] === true
        : false;

      if (approvalPending) return;

      switch (event.key) {
        case "1":
          event.preventDefault();
          handleResponse("approve");
          break;
        case "2":
          event.preventDefault();
          handleResponse("approve_for_session");
          break;
        case "3":
          event.preventDefault();
          handleResponse("reject");
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    pendingApproval,
    canRespondToApproval,
    onApprovalResponse,
    pendingApprovalMap,
    handleResponse,
  ]);

  // if no pending approval request, do not render anything
  if (!pendingApproval) return null;

  const { approval, toolCall } = pendingApproval;
  const approvalPending = approval.id
    ? pendingApprovalMap[approval.id] === true
    : false;
  const disableActions =
    !canRespondToApproval || !onApprovalResponse || approvalPending;

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
          "relative w-full border-2 border-blue-500/50 bg-blue-50/80 shadow-lg dark:border-blue-500/30 dark:bg-blue-950/40",
          "rounded-lg px-4 py-3",
          "transition-all duration-200",
          expanded ? "max-h-[70vh]" : "max-h-[320px]",
          "overflow-auto",
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
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-6 shrink-0 hover:bg-blue-100 dark:hover:bg-blue-900"
              onClick={() => setExpanded(!expanded)}
              aria-label={expanded ? "Collapse details" : "Expand details"}
            >
              {expanded ? (
                <ChevronDownIcon className="size-4" />
              ) : (
                <ChevronUpIcon className="size-4" />
              )}
            </Button>
          </div>

          {/* Description */}
          {approval.description && (
            <div className="rounded-md bg-background/60 p-3 text-sm text-foreground border border-blue-200 dark:border-blue-800 w-full">
              <pre className="font-mono text-xs whitespace-pre-wrap overflow-x-auto">
                {approval.description}
              </pre>
            </div>
          )}

          {/* Display blocks (if any) */}
          {toolCall.display && toolCall.display.length > 0 && (
            <div className="rounded-md border border-blue-200 bg-background/50 p-3 text-sm dark:border-blue-800">
              {toolCall.display.map((item, index) => (
                <div key={index} className="font-mono text-xs">
                  {JSON.stringify(item, null, 2)}
                </div>
              ))}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex flex-wrap items-center gap-2">
            {options.map((option) => (
              <Button
                key={option.key}
                size="sm"
                variant={selectedIndex === option.index ? "default" : "outline"}
                disabled={disableActions}
                onClick={() => handleResponse(option.key)}
                onMouseEnter={() => setSelectedIndex(option.index)}
                className={cn(
                  "relative transition-all",
                  selectedIndex === option.index &&
                    "bg-blue-500 hover:bg-blue-600 dark:bg-blue-600 dark:hover:bg-blue-700 shadow-md scale-105",
                  option.key === "reject" &&
                    selectedIndex === option.index &&
                    "bg-red-500 hover:bg-red-600 dark:bg-red-600 dark:hover:bg-red-700",
                )}
              >
                <span className="mr-1.5 rounded bg-background/20 px-1 text-xs font-bold">
                  {option.index}
                </span>
                {approvalPending
                  ? `${option.label}ing...`
                  : option.label}
              </Button>
            ))}
          </div>

          {/* Hint text */}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <kbd className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-xs">
              1
            </kbd>
            <kbd className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-xs">
              2
            </kbd>
            <kbd className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-xs">
              3
            </kbd>
            <span>Press to respond quickly</span>
          </div>
        </div>
      </div>
    </div>
  );
}
