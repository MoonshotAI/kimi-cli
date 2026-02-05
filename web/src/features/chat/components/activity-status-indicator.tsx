import { memo, type ReactElement } from "react";
import type { ChatStatus } from "ai";
import { AnimatePresence, motion } from "motion/react";
import { Loader } from "@/components/ai-elements/loader";
import type { LiveMessage } from "@/hooks/types";
import { cn } from "@/lib/utils";

// --- Type Definitions ---

export type ActivityStatus = "idle" | "connecting" | "processing" | "waiting_input";

export type ActivityDetail = {
  status: ActivityStatus;
  description: string;
};

// --- Tool Name Mapping ---

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  Read: "Reading files...",
  Write: "Writing files...",
  Edit: "Editing code...",
  Bash: "Running command...",
  Glob: "Searching files...",
  Grep: "Searching content...",
  WebFetch: "Fetching web content...",
  WebSearch: "Searching the web...",
  Task: "Running agent...",
  NotebookEdit: "Editing notebook...",
};

// --- Status Derivation ---

type DeriveActivityStatusParams = {
  chatStatus: ChatStatus;
  isAwaitingFirstResponse: boolean;
  isUploadingFiles: boolean;
  messages: LiveMessage[];
};

/**
 * Derives the current activity status from chat state and messages.
 */
export function deriveActivityStatus({
  chatStatus,
  isAwaitingFirstResponse,
  isUploadingFiles,
  messages,
}: DeriveActivityStatusParams): ActivityDetail {
  // Check for pending approval requests (search from end for efficiency)
  if (findPendingApproval(messages)) {
    return {
      status: "waiting_input",
      description: "Waiting for approval...",
    };
  }

  // Handle uploading files state
  if (isUploadingFiles) {
    return {
      status: "processing",
      description: "Uploading files...",
    };
  }

  // Handle error state
  if (chatStatus === "error") {
    return {
      status: "idle",
      description: "An error occurred",
    };
  }

  // Handle submitted state (waiting for first response)
  if (chatStatus === "submitted" || isAwaitingFirstResponse) {
    return {
      status: "connecting",
      description: "Connecting...",
    };
  }

  // Handle streaming state
  if (chatStatus === "streaming") {
    // Find the most recent in-progress tool call
    const activeToolCall = findActiveToolCall(messages);

    if (activeToolCall) {
      const toolName = extractToolName(activeToolCall);
      const displayText = TOOL_DISPLAY_NAMES[toolName] || `Running ${toolName}...`;
      return {
        status: "processing",
        description: displayText,
      };
    }

    // No active tool call - model is thinking
    return {
      status: "processing",
      description: "Thinking...",
    };
  }

  // Default idle state
  return {
    status: "idle",
    description: "Ready",
  };
}

/**
 * Finds the most recent pending approval request.
 * Searches from end for efficiency since pending approvals are likely in recent messages.
 */
function findPendingApproval(messages: LiveMessage[]): LiveMessage["toolCall"] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      msg.toolCall?.approval &&
      !msg.toolCall.approval.resolved &&
      msg.toolCall.state === "approval-requested"
    ) {
      return msg.toolCall;
    }
  }
  return null;
}

/**
 * Finds the most recent tool call that is in progress.
 * Active states are: "input-streaming" (streaming input) or "input-available" (executing).
 */
function findActiveToolCall(messages: LiveMessage[]): LiveMessage["toolCall"] | null {
  // Iterate from the end to find the most recent active tool
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      msg.toolCall &&
      (msg.toolCall.state === "input-streaming" ||
        msg.toolCall.state === "input-available") &&
      msg.role === "assistant"
    ) {
      return msg.toolCall;
    }
  }
  return null;
}

/**
 * Extracts the tool name from a tool call.
 */
function extractToolName(toolCall: NonNullable<LiveMessage["toolCall"]>): string {
  // The title often contains the tool name, e.g., "Read: /path/to/file"
  const title = toolCall.title || "";
  const colonIndex = title.indexOf(":");
  if (colonIndex > 0) {
    return title.substring(0, colonIndex).trim();
  }
  // Fallback to full title
  return title || "Tool";
}

// --- Status Indicator Component ---

type ActivityStatusIndicatorProps = {
  activity: ActivityDetail;
  showDescription?: boolean;
  className?: string;
};

const STATUS_COLORS: Record<ActivityStatus, string> = {
  idle: "bg-muted-foreground/50",
  connecting: "bg-blue-500",
  processing: "bg-green-500",
  waiting_input: "bg-yellow-500",
};

const STATUS_PULSE_COLORS: Record<ActivityStatus, string> = {
  idle: "",
  connecting: "bg-blue-500/50",
  processing: "bg-green-500/50",
  waiting_input: "bg-yellow-500/50",
};

export const ActivityStatusIndicator = memo(function ActivityStatusIndicatorComponent({
  activity,
  showDescription = true,
  className,
}: ActivityStatusIndicatorProps): ReactElement {
  const { status, description } = activity;
  const isActive = status !== "idle";
  const showSpinner = status === "processing";

  return (
    <output
      aria-live="polite"
      aria-atomic="true"
      className={cn("flex items-center gap-1.5", className)}
    >
      {/* Status indicator dot with optional pulse animation */}
      <div className="relative flex items-center justify-center">
        {isActive && (
          <motion.div
            className={cn(
              "absolute size-2.5 rounded-full",
              STATUS_PULSE_COLORS[status]
            )}
            animate={{
              scale: [1, 1.8, 1],
              opacity: [0.6, 0, 0.6],
            }}
            transition={{
              duration: 1.5,
              repeat: Number.POSITIVE_INFINITY,
              ease: "easeInOut",
            }}
          />
        )}
        <div
          className={cn(
            "size-2 rounded-full transition-colors duration-200",
            STATUS_COLORS[status]
          )}
        />
      </div>

      {/* Spinner for processing state */}
      {showSpinner && (
        <Loader size={12} className="text-muted-foreground" />
      )}

      {/* Description text */}
      <AnimatePresence mode="wait">
        {showDescription && (
          <motion.span
            key={description}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.15 }}
            className="text-xs text-muted-foreground select-none"
          >
            {description}
          </motion.span>
        )}
      </AnimatePresence>
    </output>
  );
});
