import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { WorktreeConfigStep } from "./worktree-config-step";

const gitInfo = {
  isGitRepo: true,
  gitRoot: "/repo",
  currentBranch: "main",
  branches: ["main", "feature/x"],
  headSha: "abc1234",
};

describe("WorktreeConfigStep", () => {
  it("renders workDir in header and toggle is off by default", () => {
    render(
      <WorktreeConfigStep
        workDir="/repo"
        gitInfo={gitInfo}
        isLoading={false}
        onBack={vi.fn()}
        onSubmit={vi.fn()}
        submitting={false}
        submitError={null}
      />,
    );
    expect(screen.getByText(/\/repo/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /isolated git worktree/i })).not.toBeChecked();
  });

  it("enables branch select when toggle is on", () => {
    render(
      <WorktreeConfigStep
        workDir="/repo"
        gitInfo={gitInfo}
        isLoading={false}
        onBack={vi.fn()}
        onSubmit={vi.fn()}
        submitting={false}
        submitError={null}
      />,
    );
    const toggle = screen.getByRole("switch", { name: /isolated git worktree/i });
    expect(screen.getByRole("combobox", { name: /base branch/i })).toBeDisabled();

    fireEvent.click(toggle);
    expect(screen.getByRole("combobox", { name: /base branch/i })).toBeEnabled();
  });

  it("calls onSubmit with disabled options when toggle off", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <WorktreeConfigStep
        workDir="/repo"
        gitInfo={gitInfo}
        isLoading={false}
        onBack={vi.fn()}
        onSubmit={onSubmit}
        submitting={false}
        submitError={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith({
      enabled: false,
      branch: null,
      name: null,
    });
  });

  it("calls onSubmit with enabled options when toggle on", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <WorktreeConfigStep
        workDir="/repo"
        gitInfo={gitInfo}
        isLoading={false}
        onBack={vi.fn()}
        onSubmit={onSubmit}
        submitting={false}
        submitError={null}
      />,
    );
    fireEvent.click(screen.getByRole("switch", { name: /isolated git worktree/i }));
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const arg = onSubmit.mock.calls[0][0];
    expect(arg.enabled).toBe(true);
    expect(arg.branch).toBeNull();
  });

  it("renders submitError inline", () => {
    render(
      <WorktreeConfigStep
        workDir="/repo"
        gitInfo={gitInfo}
        isLoading={false}
        onBack={vi.fn()}
        onSubmit={vi.fn()}
        submitting={false}
        submitError="Branch not found"
      />,
    );
    expect(screen.getByText(/branch not found/i)).toBeInTheDocument();
  });

  it("calls onBack when back button clicked", () => {
    const onBack = vi.fn();
    render(
      <WorktreeConfigStep
        workDir="/repo"
        gitInfo={gitInfo}
        isLoading={false}
        onBack={onBack}
        onSubmit={vi.fn()}
        submitting={false}
        submitError={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(onBack).toHaveBeenCalled();
  });
});
