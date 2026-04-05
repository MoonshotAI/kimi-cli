import { useCallback, useEffect, useRef, useState } from "react";
import { getApiBaseUrl } from "@/hooks/utils";
import { getAuthHeader } from "@/lib/auth";
import type { YoloStatus } from "@/lib/api/models";

export type UseYoloModeReturn = {
  yoloStatus: YoloStatus | null;
  isLoading: boolean;
  isUpdating: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  setYoloMode: (enabled: boolean) => Promise<void>;
};

export function useYoloMode(sessionId: string | null): UseYoloModeReturn {
  const [yoloStatus, setYoloStatus] = useState<YoloStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isInitializedRef = useRef(false);
  const sessionIdRef = useRef(sessionId);

  // Keep ref in sync for effect comparison
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setYoloStatus(null);
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `${getApiBaseUrl()}/api/sessions/${sessionId}/yolo`,
        {
          headers: {
            ...getAuthHeader(),
          },
        },
      );

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(
          data.detail || `Failed to load YOLO status: ${response.status}`,
        );
      }

      const data = await response.json();
      setYoloStatus({
        enabled: data.enabled,
        autoApproveActions: data.auto_approve_actions,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load YOLO status";
      setError(message);
      console.error("[useYoloMode] Failed to load YOLO status:", err);
    } finally {
      setIsLoading(false);
    }
  }, [sessionId]);

  const setYoloMode = useCallback(
    async (enabled: boolean) => {
      if (!sessionId) {
        throw new Error("No session selected");
      }

      setIsUpdating(true);
      setError(null);
      try {
        const response = await fetch(
          `${getApiBaseUrl()}/api/sessions/${sessionId}/yolo`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...getAuthHeader(),
            },
            body: JSON.stringify({ enabled }),
          },
        );

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(
            data.detail || `Failed to update YOLO mode: ${response.status}`,
          );
        }

        const data = await response.json();
        setYoloStatus({
          enabled: data.enabled,
          autoApproveActions: data.auto_approve_actions,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to update YOLO mode";
        setError(message);
        console.error("[useYoloMode] Failed to update YOLO mode:", err);
        throw err;
      } finally {
        setIsUpdating(false);
      }
    },
    [sessionId],
  );

  // Load initial data
  useEffect(() => {
    if (isInitializedRef.current && sessionIdRef.current === sessionId) {
      return;
    }
    isInitializedRef.current = true;
    refresh();
  }, [sessionId, refresh]);

  return {
    yoloStatus,
    isLoading,
    isUpdating,
    error,
    refresh,
    setYoloMode,
  };
}
