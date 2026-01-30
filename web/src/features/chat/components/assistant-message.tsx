import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type { ApprovalResponseDecision } from "@/hooks/wireTypes";
import type { LiveMessage } from "@/hooks/types";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtSearchResult,
  ChainOfThoughtSearchResults,
  ChainOfThoughtStep as ChainOfThoughtStepItem,
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
  CodeBlock,
  MessageContent,
  MessageResponse,
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
  Tool,
  ToolContent,
  ToolDisplay,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@ai-elements";

export type ToolApproval = NonNullable<LiveMessage["toolCall"]>["approval"];

export type AssistantApprovalHandler = (
  approval: ToolApproval,
  decision: ApprovalResponseDecision,
) => void | Promise<void>;

const assistantContentClass =
  "w-full max-w-full text-sm leading-relaxed";
const assistantMetaTextClass = "text-xs text-muted-foreground";

type AssistantMessageProps = {
  message: LiveMessage;
  pendingApprovalMap: Record<string, boolean>;
  onApprovalAction?: AssistantApprovalHandler;
  canRespondToApproval: boolean;
  blocksExpanded: boolean;
};

export function AssistantMessage({
  message,
  pendingApprovalMap,
  onApprovalAction,
  canRespondToApproval,
  blocksExpanded,
}: AssistantMessageProps) {
  const content = useMemo(() => {
    switch (message.variant) {
      case "chain-of-thought":
        return renderChainOfThoughtMessage(message);
      case "tool":
        return renderToolMessage({
          message,
          pendingApprovalMap,
          onApprovalAction,
          canRespondToApproval,
          blocksExpanded,
        });
      case "code":
        return renderCodeMessage(message);
      case "thinking":
        return renderThinkingMessage(message, blocksExpanded);
      default:
        return renderAssistantText(message);
    }
  }, [
    message,
    pendingApprovalMap,
    onApprovalAction,
    canRespondToApproval,
    blocksExpanded,
  ]);

  return content;
}

const renderAssistantText = (message: LiveMessage) => (
  <MessageContent className={assistantContentClass}>
    <div className="flex items-start gap-2">
      <span
        className={cn(
          "mt-1.5 size-2 shrink-0 rounded-full bg-muted-foreground/60",
          message.isStreaming && "bg-green-500 step-indicator-active",
        )}
      />
      <div className="flex-1 min-w-0">
        <MessageResponse
          className="wrap-break-word"
          mode={message.isStreaming ? "streaming" : "static"}
          parseIncompleteMarkdown={Boolean(message.isStreaming)}
        >
          {message.content || "Thinking through the response..."}
        </MessageResponse>
        {message.isStreaming ? (
          <div className={`mt-2 ${assistantMetaTextClass}`}>
            Streaming response…
          </div>
        ) : null}
      </div>
    </div>
  </MessageContent>
);

const renderChainOfThoughtMessage = (message: LiveMessage) => {
  const details = message.chainOfThought;
  if (!details) {
    return renderAssistantText(message);
  }
  const visibleSteps = details.steps.slice(0, details.revealedSteps);

  return (
    <MessageContent className={assistantContentClass}>
      <ChainOfThought className="space-y-3">
        <ChainOfThoughtHeader>{details.title}</ChainOfThoughtHeader>
        <ChainOfThoughtContent>
          {visibleSteps.map((step, index) => {
            const isLast = index === visibleSteps.length - 1;
            const status: "complete" | "active" =
              message.isStreaming && isLast ? "active" : "complete";
            return (
              <ChainOfThoughtStepItem
                description={step.description}
                key={`${message.id}-cot-${index}`}
                label={step.label}
                status={status}
              />
            );
          })}
          {details.relatedSources && details.relatedSources.length > 0 ? (
            <ChainOfThoughtSearchResults className="pt-1">
              {details.relatedSources.map((source) => (
                <ChainOfThoughtSearchResult key={`${message.id}-${source}`}>
                  {source}
                </ChainOfThoughtSearchResult>
              ))}
            </ChainOfThoughtSearchResults>
          ) : null}
        </ChainOfThoughtContent>
      </ChainOfThought>
      {message.isStreaming ? (
        <div className={`mt-2 ${assistantMetaTextClass}`}>
          Reasoning through the request…
        </div>
      ) : null}
    </MessageContent>
  );
};

const renderToolMessage = ({
  message,
  pendingApprovalMap,
  onApprovalAction,
  canRespondToApproval,
  blocksExpanded,
}: {
  message: LiveMessage;
  pendingApprovalMap: Record<string, boolean>;
  onApprovalAction?: AssistantApprovalHandler;
  canRespondToApproval: boolean;
  blocksExpanded: boolean;
}) => {
  const toolCall = message.toolCall;
  if (!toolCall) {
    return renderAssistantText(message);
  }

  const shouldShowOutput = Boolean(
    toolCall.output ?? toolCall.errorText ?? toolCall.display,
  );
  const approval = toolCall.approval;
  const approvalId = approval?.id;
  const approvalResponse =
    typeof approval?.response === "string" ? approval.response : undefined;
  const isApprovalRequested = toolCall.state === "approval-requested";
  const isApprovalDenied = toolCall.state === "output-denied";
  const approvalPending =
    approvalId !== undefined ? pendingApprovalMap[approvalId] === true : false;
  const disableApprovalActions = !(
    canRespondToApproval &&
    onApprovalAction &&
    !approvalPending &&
    !approval?.submitted &&
    isApprovalRequested
  );

  return (
    <>
      <Tool
        key={`${message.id}-${blocksExpanded}`}
        defaultOpen={blocksExpanded}
      >
        <ToolHeader
          state={toolCall.state}
          title={toolCall.title}
          type={toolCall.type}
          input={toolCall.input}
        />
        <ToolContent>
          {toolCall.input ? <ToolInput input={toolCall.input} /> : null}
          <ToolDisplay display={toolCall.display} isError={toolCall.isError} />
          {shouldShowOutput ? (
            <ToolOutput
              errorText={toolCall.errorText}
              output={toolCall.output}
            />
          ) : null}
          {approval ? (
            <Confirmation
              approval={approval}
              state={toolCall.state}
              className="rounded-md bg-muted/30 px-3 py-2.5 text-sm"
            >
              <ConfirmationTitle>
                Manual approval required by {approval.sender}
              </ConfirmationTitle>
              <ConfirmationRequest>
                <div className="text-sm text-muted-foreground">
                  <p>
                    <span className="font-medium text-foreground">Action:</span>{" "}
                    {approval.action}
                  </p>
                  {approval.description ? (
                    <p className="mt-2 text-foreground">
                      {approval.description}
                    </p>
                  ) : null}
                </div>
                <ConfirmationActions className="mt-2 gap-2">
                  <ConfirmationAction
                    disabled={disableApprovalActions}
                    onClick={() =>
                      approval && onApprovalAction?.(approval, "reject")
                    }
                    variant="outline"
                  >
                    {approvalPending ? "Declining…" : "Decline"}
                  </ConfirmationAction>
                  <ConfirmationAction
                    disabled={disableApprovalActions}
                    onClick={() =>
                      approval && onApprovalAction?.(approval, "approve")
                    }
                  >
                    {approvalPending ? "Confirming…" : "Approve"}
                  </ConfirmationAction>
                  <ConfirmationAction
                    disabled={disableApprovalActions}
                    onClick={() =>
                      approval &&
                      onApprovalAction?.(approval, "approve_for_session")
                    }
                    variant="secondary"
                    className="hover:bg-primary/30"
                  >
                    {approvalPending
                      ? "Approving session…"
                      : "Approve for session"}
                  </ConfirmationAction>
                </ConfirmationActions>
              </ConfirmationRequest>
              <ConfirmationAccepted>
                <div className="rounded-md bg-success/10 px-3 py-2 text-xs text-success">
                  {approvalResponse === "approve_for_session"
                    ? "Session approved. Future matching requests auto-approve."
                    : "Approval confirmed. Continuing execution…"}
                </div>
              </ConfirmationAccepted>
              <ConfirmationRejected>
                <div className="rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
                  Request denied
                  {approval.reason ? `: ${approval.reason}` : "."}
                </div>
              </ConfirmationRejected>
            </Confirmation>
          ) : null}
        </ToolContent>
      </Tool>
      {isApprovalRequested ? (
        <div className={assistantMetaTextClass}>Waiting for your approval…</div>
      ) : message.isStreaming && toolCall.state !== "output-available" ? (
        <div className={assistantMetaTextClass}>Tool call running…</div>
      ) : isApprovalDenied ? (
        <div className={assistantMetaTextClass}>Tool execution cancelled.</div>
      ) : null}
    </>
  );
};

const renderCodeMessage = (message: LiveMessage) => {
  const snippet = message.codeSnippet;
  if (!snippet) {
    return renderAssistantText(message);
  }

  return (
    <MessageContent className={assistantContentClass}>
      <MessageResponse
        className="wrap-break-word font-medium"
        mode={message.isStreaming ? "streaming" : "static"}
        parseIncompleteMarkdown={Boolean(message.isStreaming)}
      >
        {message.content ?? snippet.title ?? "Generated code"}
      </MessageResponse>
      {snippet.code ? (
        <div className="mt-3">
          <CodeBlock
            code={snippet.code}
            language={snippet.language}
            showLineNumbers
          />
        </div>
      ) : (
        <div className={`mt-3 ${assistantMetaTextClass}`}>
          Assembling snippet…
        </div>
      )}
    </MessageContent>
  );
};

const renderThinkingMessage = (
  message: LiveMessage,
  blocksExpanded: boolean,
) => {
  const thinkingContent = message.thinking;
  if (!thinkingContent) {
    return renderAssistantText(message);
  }

  return (
    <MessageContent className={assistantContentClass}>
      <Reasoning
        key={`${message.id}-${blocksExpanded}`}
        isStreaming={message.isStreaming}
        duration={message.thinkingDuration}
        defaultOpen={blocksExpanded}
        disableAutoClose
      >
        <ReasoningTrigger />
        <ReasoningContent>{thinkingContent}</ReasoningContent>
      </Reasoning>
    </MessageContent>
  );
};
