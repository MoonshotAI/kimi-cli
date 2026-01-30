/* tslint:disable */
/* eslint-disable */
export interface GitFileDiff {
  path: string;
  additions: number;
  deletions: number;
  status: "added" | "modified" | "deleted" | "renamed";
}

export interface GitDiffStats {
  isGitRepo: boolean;
  hasChanges: boolean;
  totalAdditions: number;
  totalDeletions: number;
  files: GitFileDiff[];
  error?: string | null;
}
