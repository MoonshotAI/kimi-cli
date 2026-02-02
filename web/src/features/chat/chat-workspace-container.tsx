/**
 * Container component that subscribes to useSessionStream.
 *
 * This exists to isolate high-frequency message updates from App, preventing
 * unnecessary re-renders of SessionsSidebar. When messages update, only this
 * container and ChatWorkspace re-render, not App.
 *
 * TODO: This layer could be simplified by moving useSessionStream directly
 * into ChatWorkspace. The Container/Presentational split here doesn't provide
 * much value since ChatWorkspace receives `messages` as a prop and re-renders
 * on every update anyway.
 */
import { type ReactElement, useCallback, useEffect, useState } from "react";
import type { ChatStatus, FileUIPart } from "ai";
import type { PromptInputMessage } from "@ai-elements";
import { toast } from "sonner";
import type {
  Session,
  SessionStatus,
  UploadSessionFileResponse,
} from "@/lib/api/models";
import type { SessionFileEntry } from "@/hooks/useSessions";
import { getApiBaseUrl, isMacOS } from "@/hooks/utils";
import { useSessionStream } from "@/hooks/useSessionStream";
import { useToolEventsStore } from "@/features/tool/store";
import { ChatWorkspace } from "./chat";

type PendingMessage = {
  text: string;
  targetSessionId: string;
};

type ChatWorkspaceContainerProps = {
  selectedSessionId: string;
  currentSession?: Session;
  sessionDescription?: string;
  onSessionStatus: (status: SessionStatus) => void;
  onStreamStatusChange?: (status: ChatStatus) => void;
  uploadSessionFile: (
    sessionId: string,
    file: File,
  ) => Promise<UploadSessionFileResponse>;
  onListSessionDirectory?: (
    sessionId: string,
    path?: string,
  ) => Promise<SessionFileEntry[]>;
  onGetSessionFileUrl?: (sessionId: string, path: string) => string;
  onGetSessionFile?: (sessionId: string, path: string) => Promise<Blob>;
  onOpenCreateDialog?: () => void;
  onOpenSidebar?: () => void;
};

export function ChatWorkspaceContainer({
  selectedSessionId,
  currentSession,
  sessionDescription,
  onSessionStatus,
  onStreamStatusChange,
  uploadSessionFile,
  onListSessionDirectory,
  onGetSessionFileUrl,
  onGetSessionFile,
  onOpenCreateDialog,
  onOpenSidebar,
}: ChatWorkspaceContainerProps): ReactElement {
  const [isUploadingFiles, setIsUploadingFiles] = useState(false);
  // Pending message state for when we need to create a session first
  const [pendingMessage, setPendingMessage] = useState<PendingMessage | null>(
    null,
  );
  const sessionId = selectedSessionId || null;

  const handleStreamError = useCallback((error: Error) => {
    toast.error("Connection Error", {
      description: error.message,
    });
  }, []);

  const sessionStream = useSessionStream({
    sessionId,
    baseUrl: getApiBaseUrl(),
    onError: handleStreamError,
    onSessionStatus,
  });

  const {
    messages,
    status,
    isAwaitingFirstResponse,
    sendMessage,
    respondToApproval,
    cancel: cancelStream,
    contextUsage,
    tokenUsage,
    currentStep,
    isConnected: isStreamConnected,
    isReplayingHistory,
  } = sessionStream;

  const clearNewFiles = useToolEventsStore((state) => state.clearNewFiles);
  useEffect(() => {
    if (status === "streaming") {
      clearNewFiles();
    }
  }, [status, clearNewFiles]);

  useEffect(() => {
    onStreamStatusChange?.(status);
  }, [status, onStreamStatusChange]);

  useEffect(() => {
    if (
      !pendingMessage ||
      pendingMessage.targetSessionId !== selectedSessionId ||
      !isStreamConnected ||
      (status !== "ready" && status !== "streaming")
    ) {
      return;
    }

    // Send only when the stream is connected to the intended session.
    // Using state (not ref) ensures this effect re-runs even if connection
    // happens before the pending message is set.
    setPendingMessage(null);
    sendMessage(pendingMessage.text);
  }, [
    isStreamConnected,
    status,
    selectedSessionId,
    sendMessage,
    pendingMessage,
  ]);

  useEffect(() => {
    if (
      !pendingMessage ||
      pendingMessage.targetSessionId === selectedSessionId
    ) {
      return;
    }

    // Drop stale pending messages if the user switches away before it is sent.
    setPendingMessage(null);
  }, [pendingMessage, selectedSessionId]);

  const uploadFilesToSession = useCallback(
    async (targetSessionId: string, files: FileUIPart[]) => {
      if (files.length === 0) {
        return 0;
      }

      setIsUploadingFiles(true);
      try {
        const uploadResults = await Promise.all(
          files.map(async (filePart) => {
            if (!filePart.url) return false;

            const response = await fetch(filePart.url);
            const blob = await response.blob();
            const file = new File([blob], filePart.filename ?? "unnamed_file", {
              type: filePart.mediaType ?? blob.type,
            });

            const uploadResult = await uploadSessionFile(targetSessionId, file);
            console.log(
              "[ChatWorkspaceContainer] File uploaded:",
              uploadResult,
            );
            return true;
          }),
        );

        const uploadedCount = uploadResults.filter(Boolean).length;
        if (uploadedCount > 0) {
          toast.success("Files uploaded", {
            description:
              uploadedCount === 1
                ? "1 file uploaded successfully."
                : `${uploadedCount} files uploaded successfully.`,
          });
        }
        return uploadedCount;
      } catch (error) {
        console.error(
          "[ChatWorkspaceContainer] Failed to upload files:",
          error,
        );
        toast.error("Failed to Upload Files", {
          description:
            error instanceof Error ? error.message : "File upload failed",
        });
        return 0;
      } finally {
        setIsUploadingFiles(false);
      }
    },
    [uploadSessionFile],
  );

  const handlePromptSubmit = useCallback(
    async (message: PromptInputMessage) => {
      const hasPayload =
        message.text.trim().length > 0 || message.files.length > 0;
      if (!hasPayload) {
        toast.info("Empty Message", {
          description: "Please enter a message or attach a file.",
        });
        return;
      }

      if (
        status === "streaming" ||
        status === "submitted" ||
        isUploadingFiles
      ) {
        toast.info("Still processing", {
          description: "Please wait until uploads and responses finish.",
        });
        return;
      }

      // Note: This check is defensive - the submit button is disabled when no session exists
      if (!selectedSessionId) {
        return;
      }

      const targetSessionId = selectedSessionId;

      if (message.files.length > 0 && targetSessionId) {
        await uploadFilesToSession(targetSessionId, message.files);
      }

      const messageText =
        message.text.trim() ||
        (message.files.length > 0 ? "KIMI_FILE_UPLOAD_WITHOUT_MESSAGE" : "");

      await sendMessage(messageText);
    },
    [status, isUploadingFiles, selectedSessionId, uploadFilesToSession, sendMessage],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }

      if (event.key.toLowerCase() !== "o") {
        return;
      }

      const hasModifier = isMacOS() ? event.metaKey : event.ctrlKey;
      if (!(hasModifier && event.shiftKey)) {
        return;
      }

      event.preventDefault();
      onOpenCreateDialog?.();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onOpenCreateDialog]);

  return (
    <ChatWorkspace
      selectedSessionId={selectedSessionId}
      messages={messages}
      onSubmit={handlePromptSubmit}
      status={status}
      isUploadingFiles={isUploadingFiles}
      onCreateSession={onOpenCreateDialog}
      onCancel={cancelStream}
      onApprovalResponse={respondToApproval}
      sessionDescription={sessionDescription}
      contextUsage={contextUsage}
      tokenUsage={tokenUsage}
      currentStep={currentStep}
      currentSession={currentSession}
      isReplayingHistory={isReplayingHistory}
      isAwaitingFirstResponse={isAwaitingFirstResponse}
      onListSessionDirectory={onListSessionDirectory}
      onGetSessionFileUrl={onGetSessionFileUrl}
      onGetSessionFile={onGetSessionFile}
      onOpenSidebar={onOpenSidebar}
    />
  );
}
