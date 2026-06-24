import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useGitInfo } from "./useGitInfo";

describe("useGitInfo", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it("returns null gitInfo when workDir is null", () => {
    const { result } = renderHook(() => useGitInfo(null));
    expect(result.current.gitInfo).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it("fetches git info after debounce when workDir is provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        is_git_repo: true,
        git_root: "/repo",
        current_branch: "main",
        branches: ["main"],
        head_sha: "abc1234",
      }),
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const { result } = renderHook(() => useGitInfo("/repo"));

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      await vi.runOnlyPendingTimersAsync();
    });

    expect(result.current.gitInfo?.isGitRepo).toBe(true);
    expect(result.current.gitInfo?.currentBranch).toBe("main");
    expect(result.current.gitInfo?.branches).toEqual(["main"]);
    expect(result.current.isLoading).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("cancels in-flight request when workDir changes", async () => {
    const calls: string[] = [];
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      calls.push(url);
      return new Promise(() => {
        // never resolves
      });
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const { rerender } = renderHook(
      ({ dir }: { dir: string }) => useGitInfo(dir),
      { initialProps: { dir: "/first" } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("work_dir=%2Ffirst");

    rerender({ dir: "/second" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("work_dir=%2Fsecond");
  });

  it("degrades gracefully when fetch rejects", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("boom")) as unknown as typeof fetch;

    const { result } = renderHook(() => useGitInfo("/repo"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      await vi.runOnlyPendingTimersAsync();
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.gitInfo).toEqual({
      isGitRepo: false,
      gitRoot: null,
      currentBranch: null,
      branches: [],
      headSha: null,
    });
  });
});
