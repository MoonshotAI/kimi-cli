import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CreateSessionDialog } from "./create-session-dialog";

describe("CreateSessionDialog two-step flow", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it("skips step 2 for non-git paths", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        is_git_repo: false,
        git_root: null,
        current_branch: null,
        branches: [],
        head_sha: null,
      }),
    }) as unknown as typeof fetch;

    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <CreateSessionDialog
        open
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
        fetchWorkDirs={async () => []}
        fetchStartupDir={async () => "/home/user"}
      />,
    );

    const input = await screen.findByPlaceholderText(/search directories/i);
    fireEvent.change(input, { target: { value: "/tmp/not-a-repo" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm).toHaveBeenCalledWith("/tmp/not-a-repo", undefined);
    expect(screen.queryByText(/isolated git worktree/i)).not.toBeInTheDocument();
  });

  it("shows step 2 for git repo paths", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        is_git_repo: true,
        git_root: "/repo",
        current_branch: "main",
        branches: ["main"],
        head_sha: "abc1234",
      }),
    }) as unknown as typeof fetch;

    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <CreateSessionDialog
        open
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
        fetchWorkDirs={async () => []}
        fetchStartupDir={async () => ""}
      />,
    );

    const input = await screen.findByPlaceholderText(/search directories/i);
    fireEvent.change(input, { target: { value: "/repo" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Advance timers for git info debounce and wait for the step 2 to appear
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    await screen.findByText(/isolated git worktree/i);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
