---
name: codex-worker
description: Spawn and manage multiple Codex CLI agents via tmux to work on tasks in parallel. Use whenever a task can be decomposed into independent subtasks (e.g. batch triage, parallel fixes, multi-file refactors). When codex and tmux are available, prefer this over the built-in Task tool for parallelism.
---

# codex-worker

Orchestrate multiple Codex CLI (`codex`) agents running in parallel, each in its
own git worktree and tmux session.

**When to use:** Whenever you identify that a task can be split into independent
subtasks — don't wait for the user to ask for parallelism. Examples:
- User says "triage all open issues updated in the last 7 days" → fetch the
  issue list, then spawn one codex worker per issue.
- User says "refactor these 5 modules" → one worker per module.
- User says "fix lint errors across packages" → one worker per package.

**Replaces Task tool:** When `codex` and `tmux` are available in the
environment, use codex workers instead of the built-in Task (subagent) tool.
Codex workers are full-featured agents with their own file system access, shell,
and isolated worktree — far more capable than subagents.

## Preflight check

```bash
command -v codex && codex login status && command -v tmux
```

All three must succeed. The project must be a git repository.

## Naming convention

Git branch and worktree directory share a **task name**:

```
<type>-<issue number (optional)>-<short description>
```

The tmux session adds a `codex-worker-` prefix so workers are easy to filter:

| | Format | Example |
|---|---|---|
| Task name | `<type>-<number>-<desc>` | `issue-836-prompt-dollar-sign` |
| Git branch | same as task name | `issue-836-prompt-dollar-sign` |
| Worktree dir | `<project>.worktrees/<task>` | `kimi-cli.worktrees/issue-836-prompt-dollar-sign` |
| tmux session | `codex-worker-<task>` | `codex-worker-issue-836-prompt-dollar-sign` |

More examples:
- `issue-518-mcp-config-isolation`
- `fix-share-dir-skills-path`
- `feat-ask-user-tool`
- `refactor-jinja-templates`

List only codex workers: `tmux ls | grep ^codex-worker-`

## Usage

Prefer tmux + interactive codex for all tasks. It supports multi-turn dialogue,
the user can `tmux attach` to inspect or intervene, and you can send follow-up
prompts from outside.

### Spawn a worker

```bash
NAME="issue-836-prompt-dollar-sign"        # task name
SESSION="codex-worker-$NAME"               # tmux session name
PROJECT_DIR="$(pwd)"
WORKTREE_DIR="$PROJECT_DIR.worktrees"

# 1. Create worktree (skip if exists)
git worktree add "$WORKTREE_DIR/$NAME" -b "$NAME" main 2>/dev/null

# 2. Launch interactive codex inside tmux
tmux new-session -d -s "$SESSION" -x 200 -y 50 \
  "cd $WORKTREE_DIR/$NAME && codex --dangerously-bypass-approvals-and-sandbox"
```

### Send a prompt

```bash
tmux send-keys -t "$SESSION" "Your prompt here" Enter
```

### Peek at output

```bash
tmux capture-pane -t "$SESSION" -p | tail -30
```

### Attach for hands-on interaction

```bash
tmux attach -t "$SESSION"
```

### Parallel fan-out

```bash
TASKS=(
  "issue-518-mcp-config-isolation|Triage #518: MCP config 被子 agent 继承的隔离问题。分析根因，给出修复方案。"
  "issue-836-prompt-dollar-sign|Triage #836: prompt 包含 $ 时启动静默失败。分析根因，给出修复方案。"
)

PROJECT_DIR="$(pwd)"
WORKTREE_DIR="$PROJECT_DIR.worktrees"

for entry in "${TASKS[@]}"; do
  NAME="${entry%%|*}"
  PROMPT="${entry#*|}"
  SESSION="codex-worker-$NAME"
  git worktree add "$WORKTREE_DIR/$NAME" -b "$NAME" main 2>/dev/null
  tmux new-session -d -s "$SESSION" -x 200 -y 50 \
    "cd $WORKTREE_DIR/$NAME && codex --dangerously-bypass-approvals-and-sandbox"
  sleep 2  # let codex TUI initialize
  tmux send-keys -t "$SESSION" "$PROMPT" Enter
done
```

### Fallback: `codex exec`

Only use `codex exec` when you explicitly don't need follow-up (e.g. CI, pure
analysis with `-o` output). It does not support multi-turn dialogue.

```bash
codex exec --dangerously-bypass-approvals-and-sandbox \
  -o "/tmp/$NAME-result.md" \
  "Your prompt here"
```

## Lifecycle management

List active workers:

```bash
tmux ls | grep ^codex-worker-
```

Kill a finished worker:

```bash
tmux kill-session -t "codex-worker-$NAME"
```

Clean up worktree after merging:

```bash
tmux kill-session -t "codex-worker-$NAME" 2>/dev/null
git worktree remove "$WORKTREE_DIR/$NAME"
git branch -d "$NAME"
```

Batch cleanup of dead sessions:

```bash
tmux list-sessions -F '#{session_name}:#{pane_dead}' \
  | grep ':1$' \
  | cut -d: -f1 \
  | xargs -I{} tmux kill-session -t {}
```
