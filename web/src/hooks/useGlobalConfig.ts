import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient } from "@/lib/apiClient";
import type {
  GlobalConfig,
  UpdateGlobalConfigRequest,
  UpdateGlobalConfigResponse,
} from "@/lib/api/models";

type UpdateGlobalConfigArgs = {
  defaultModel?: string;
  defaultThinking?: boolean;
  restartRunningSessions?: boolean;
  forceRestartBusySessions?: boolean;
};

export type UseGlobalConfigReturn = {
  config: GlobalConfig | null;
  isLoading: boolean;
  isUpdating: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  update: (args: UpdateGlobalConfigArgs) => Promise<UpdateGlobalConfigResponse>;
};

export function useGlobalConfig(): UseGlobalConfigReturn {
  const [config, setConfig] = useState<GlobalConfig | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isInitializedRef = useRef(false);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const nextConfig = await apiClient.config.getGlobalConfigApiConfigGet();
      setConfig(nextConfig);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load global config";
      setError(message);
      console.error("[useGlobalConfig] Failed to load global config:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const update = useCallback(
    async (
      args: UpdateGlobalConfigArgs,
    ): Promise<UpdateGlobalConfigResponse> => {
      setIsUpdating(true);
      setError(null);
      try {
        const body: UpdateGlobalConfigRequest = {
          defaultModel: args.defaultModel ?? undefined,
          defaultThinking: args.defaultThinking ?? undefined,
          restartRunningSessions: args.restartRunningSessions ?? undefined,
          forceRestartBusySessions: args.forceRestartBusySessions ?? undefined,
        };

        const resp = await apiClient.config.updateGlobalConfigApiConfigPatch({
          updateGlobalConfigRequest: body,
        });
        setConfig(resp.config);
        return resp;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to update global config";
        setError(message);
        console.error("[useGlobalConfig] Failed to update global config:", err);
        throw err;
      } finally {
        setIsUpdating(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (isInitializedRef.current) {
      return;
    }
    isInitializedRef.current = true;
    refresh();
  }, [refresh]);

  return {
    config,
    isLoading,
    isUpdating,
    error,
    refresh,
    update,
  };
}
