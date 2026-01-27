import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient } from "@/lib/apiClient";
import type { ConfigToml, UpdateConfigTomlResponse } from "@/lib/api/models";

export type UseConfigTomlReturn = {
  configToml: ConfigToml | null;
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  save: (args: {
    toml: string;
    restartRunningSessions: boolean;
    forceRestartBusySessions: boolean;
  }) => Promise<UpdateConfigTomlResponse>;
};

export function useConfigToml(): UseConfigTomlReturn {
  const [configToml, setConfigToml] = useState<ConfigToml | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isInitializedRef = useRef(false);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const next = await apiClient.config.getConfigTomlApiConfigTomlGet();
      setConfigToml(next);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load config.toml";
      setError(message);
      console.error("[useConfigToml] Failed to load config.toml:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const save = useCallback(
    async (args: {
      toml: string;
      restartRunningSessions: boolean;
      forceRestartBusySessions: boolean;
    }): Promise<UpdateConfigTomlResponse> => {
      setIsSaving(true);
      setError(null);
      try {
        const resp = await apiClient.config.updateConfigTomlApiConfigTomlPut({
          updateConfigTomlRequest: {
            toml: args.toml,
            restartRunningSessions: args.restartRunningSessions,
            forceRestartBusySessions: args.forceRestartBusySessions,
          },
        });
        setConfigToml((prev) =>
          prev
            ? { ...prev, toml: resp.toml }
            : { path: "", toml: resp.toml },
        );
        return resp;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to save config.toml";
        setError(message);
        console.error("[useConfigToml] Failed to save config.toml:", err);
        throw err;
      } finally {
        setIsSaving(false);
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
    configToml,
    isLoading,
    isSaving,
    error,
    refresh,
    save,
  };
}

