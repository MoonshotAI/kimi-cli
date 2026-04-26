import { useEffect, useRef, useState } from "react";
import { getAuthHeader } from "../lib/auth";
import { getApiBaseUrl } from "./utils";

export type GitInfo = {
  isGitRepo: boolean;
  gitRoot: string | null;
  currentBranch: string | null;
  branches: string[];
  headSha: string | null;
};

const EMPTY_GIT_INFO: GitInfo = {
  isGitRepo: false,
  gitRoot: null,
  currentBranch: null,
  branches: [],
  headSha: null,
};

const DEBOUNCE_MS = 250;

export function useGitInfo(workDir: string | null): {
  gitInfo: GitInfo | null;
  isLoading: boolean;
} {
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!workDir) {
      abortRef.current?.abort();
      abortRef.current = null;
      setGitInfo(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    const timer = window.setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const basePath = getApiBaseUrl();
      const params = new URLSearchParams({ work_dir: workDir });
      fetch(`${basePath}/api/git/info?${params}`, {
        headers: getAuthHeader(),
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          if (controller.signal.aborted) return;
          setGitInfo({
            isGitRepo: Boolean(data.is_git_repo),
            gitRoot: data.git_root ?? null,
            currentBranch: data.current_branch ?? null,
            branches: Array.isArray(data.branches) ? data.branches : [],
            headSha: data.head_sha ?? null,
          });
        })
        .catch((err) => {
          if ((err as { name?: string }).name === "AbortError") return;
          setGitInfo(EMPTY_GIT_INFO);
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setIsLoading(false);
          }
        });
    }, DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [workDir]);

  return { gitInfo, isLoading };
}
