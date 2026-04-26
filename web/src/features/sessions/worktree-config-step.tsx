import { type ReactElement, useMemo, useState } from "react";
import { ArrowLeft, GitBranch, Loader2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { GitInfo } from "@/hooks/useGitInfo";

export type WorktreeOptions = {
  enabled: boolean;
  branch: string | null;
  name: string | null;
};

const DETACHED_VALUE = "__detached__";
const NAME_REGEX = /^[a-zA-Z0-9._-]+$/;

type Props = {
  workDir: string;
  gitInfo: GitInfo;
  isLoading: boolean;
  submitting: boolean;
  submitError: string | null;
  onBack: () => void;
  onSubmit: (options: WorktreeOptions) => Promise<void> | void;
};

function autoNamePreview(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = now.getUTCFullYear();
  const m = pad(now.getUTCMonth() + 1);
  const d = pad(now.getUTCDate());
  const hh = pad(now.getUTCHours());
  const mm = pad(now.getUTCMinutes());
  const ss = pad(now.getUTCSeconds());
  return `kimi-${y}${m}${d}-${hh}${mm}${ss}`;
}

export function WorktreeConfigStep({
  workDir,
  gitInfo,
  isLoading,
  submitting,
  submitError,
  onBack,
  onSubmit,
}: Props): ReactElement {
  const [enabled, setEnabled] = useState(false);
  const [branchValue, setBranchValue] = useState<string>(DETACHED_VALUE);
  const [name, setName] = useState("");

  const branches = useMemo(() => {
    const all = [...gitInfo.branches];
    const current = gitInfo.currentBranch;
    if (current) {
      const rest = all.filter((b) => b !== current);
      return [current, ...rest];
    }
    return all;
  }, [gitInfo.branches, gitInfo.currentBranch]);

  const namePreview = useMemo(() => autoNamePreview(), []);
  const nameInvalid = name !== "" && !NAME_REGEX.test(name);

  const handleSubmit = () => {
    if (submitting) return;
    const options: WorktreeOptions = enabled
      ? {
          enabled: true,
          branch: branchValue === DETACHED_VALUE ? null : branchValue,
          name: name.trim() || null,
        }
      : { enabled: false, branch: null, name: null };
    void onSubmit(options);
  };

  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex min-w-0 items-center gap-2 border-b border-border px-4 py-3">
        <button
          type="button"
          aria-label="Back to directory selection"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onBack}
        >
          <ArrowLeft className="size-4" />
        </button>
        <span
          className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
          title={workDir}
        >
          New session in <span className="font-mono text-muted-foreground">{workDir}</span>
        </span>
      </div>

      <div className="flex flex-col gap-4 px-4 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <label
              className="flex cursor-pointer items-center gap-2 text-sm font-medium text-foreground"
              htmlFor="worktree-toggle"
            >
              <GitBranch className="size-4" />
              Create isolated git worktree
            </label>
            <p className="mt-1 text-xs text-muted-foreground">
              Runs the session in its own detached git worktree so file changes stay isolated.
              {isLoading && (
                <>
                  {" "}
                  <Loader2 className="inline size-3 animate-spin" />
                </>
              )}
            </p>
          </div>
          <Switch
            id="worktree-toggle"
            aria-label="Create isolated git worktree"
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={isLoading}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="worktree-branch" className="text-xs font-medium text-foreground">
            Base branch
          </label>
          <Select value={branchValue} onValueChange={setBranchValue} disabled={!enabled}>
            <SelectTrigger id="worktree-branch" aria-label="Base branch" className="disabled:opacity-50">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DETACHED_VALUE}>
                <span className="text-foreground">Detached HEAD</span>
                {gitInfo.headSha && (
                  <span className="ml-2 text-muted-foreground">at {gitInfo.headSha}</span>
                )}
              </SelectItem>
              {branches.map((branch) => (
                <SelectItem key={branch} value={branch}>
                  <span>{branch}</span>
                  {branch === gitInfo.currentBranch && (
                    <span className="ml-2 text-muted-foreground">(current)</span>
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="worktree-name" className="text-xs font-medium text-foreground">
            Worktree name <span className="text-muted-foreground">(optional)</span>
          </label>
          <Input
            id="worktree-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={namePreview}
            disabled={!enabled}
            className="disabled:opacity-50"
          />
          {nameInvalid && (
            <p className="text-xs text-destructive">
              Use only letters, digits, dot, underscore, and dash.
            </p>
          )}
        </div>

        {submitError && (
          <div className="flex items-start gap-2 text-xs text-destructive">
            <AlertTriangle className="size-3.5 shrink-0" />
            <span>{submitError}</span>
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
        <Button variant="outline" onClick={onBack} disabled={submitting}>
          Cancel
        </Button>
        <Button onClick={handleSubmit} disabled={submitting || nameInvalid || isLoading}>
          {submitting && <Loader2 className="size-4 animate-spin" />}
          Create
        </Button>
      </div>
    </div>
  );
}
