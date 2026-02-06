---
name: worktree-status
description: Audit all git worktrees in the current project. Use when the user asks about worktree status, which branches are merged, which have uncommitted changes, or which worktrees can be safely cleaned up.
---

# worktree-status

Report the status of every git worktree for the current project, covering
dirty state and merge status.

## When to use

- User asks "which worktrees can I clean up?"
- User asks "what's the status of my worktrees / branches?"
- Before batch-cleaning worktrees, to avoid losing uncommitted work

## Procedure

### 1. Pull latest main

```bash
cd "$(git rev-parse --show-toplevel)" && git pull origin main
```

### 2. Collect worktree info

```bash
PROJECT_DIR="$(git rev-parse --show-toplevel)"

for wt in $(git worktree list --porcelain | grep "^worktree " | sed 's/^worktree //' | grep -v "$PROJECT_DIR$"); do
  branch=$(git -C "$wt" branch --show-current 2>/dev/null)
  [ -z "$branch" ] && branch="(detached)"
  name=$(basename "$wt")

  # dirty?
  if [ -z "$(git -C "$wt" status --short 2>/dev/null)" ]; then
    dirty="clean"
  else
    dirty="DIRTY"
  fi

  # merged into origin/main?
  # NOTE: This project uses squash merges exclusively. `git merge-base
  # --is-ancestor` does NOT detect squash-merged branches. Always follow
  # up with a content diff (step 3) for branches that appear "not merged".
  if [ "$branch" != "(detached)" ]; then
    if git merge-base --is-ancestor "$branch" origin/main 2>/dev/null; then
      merged="merged"
    else
      merged="not merged (verify with content diff)"
    fi
  else
    merged="n/a"
  fi

  echo ""
  echo "[$name]  branch=$branch  $dirty  $merged"
  if [ "$dirty" = "DIRTY" ]; then
    git -C "$wt" status --short 2>/dev/null | sed 's/^/  /'
  fi
done
```

### 3. Detect squash-merged branches (content diff)

For any branch that shows "not merged", compare its content against
`origin/main`. An empty diff means the branch content is already in main
(i.e. it was squash-merged).

```bash
git diff origin/main <branch> -- | head -5
# Empty output = squash-merged
```

### 4. (Optional) Check for associated tmux sessions

Only run this if `tmux` is available and relevant (e.g. worktrees were
created by codex-worker or similar tooling). Skip if not applicable.

```bash
tmux ls 2>/dev/null | grep -E 'codex-worker|<other-pattern>' || true
```

### 5. Present results

**Always present results as a Markdown table.** Every worktree must appear
as a row. Never use abbreviated or prose-only summaries.

| Worktree | Branch | Dirty | Merged | Can clean? |
|---|---|---|---|---|
| `example-wt` | `feat-foo` | ✅ clean | ✅ squash-merged | ✅ |
| `another-wt` | `fix-bar` | ⚠️ 3 files | ❌ not merged | ❌ dirty + not merged |
| `detached-wt` | (detached) | ⚠️ 14 files | n/a | ❌ has uncommitted changes |

Column definitions:

- **Dirty**: `✅ clean` or `⚠️ N files`
- **Merged**: `✅ merged` / `✅ squash-merged` (confirmed via content diff) / `❌ not merged` / `n/a`
- **Can clean?**: `✅` only when merged (or squash-merged) AND clean

Add extra columns (e.g. tmux session, notes) only when relevant.

### 6. Cleanup (only when asked)

Only clean worktrees the user explicitly approves. For each:

```bash
NAME="<worktree-name>"
git worktree remove "/path/to/$NAME"
git branch -D "<branch>"  # only if the branch is no longer needed
```
