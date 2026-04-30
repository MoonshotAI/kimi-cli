# Web UI Worktree Feature — Design

**Date:** 2026-04-25
**Status:** Approved (pending implementation plan)
**Related work:** CLI worktree support landed on `feat/worktree-support` (commit `1886a8fb`). This spec extends that feature to the web UI.

## Goal

Expose the existing CLI worktree primitives (`--worktree`, `--worktree-branch`, `--worktree-name`) through the web UI with Codex App-style parity, so a web user can create a session inside an isolated git worktree, see which sessions are worktree-backed, and have worktrees automatically reaped when sessions are deleted.

## Non-goals

To keep scope tight, the following Codex-adjacent features are explicitly **out of scope**:

- "Hand off" flow between local and worktree contexts.
- "Create branch here" after the worktree exists.
- "Permanent worktrees" as their own top-level project entity.
- Snapshot / restore on archive.
- A worktree-management view listing all active worktrees across sessions.
- Remote-branch selection (only local branches are offered in the branch picker).

These can be layered on later once the base feature is in place.

## CLI feature recap

The already-merged CLI implementation provides everything the backend needs:

- `src/kimi_cli/worktree.py` — `find_git_root(path) -> KaosPath | None`, `create_worktree(repo_root, name=..., branch=...) -> KaosPath` (raises `WorktreeError`), `remove_worktree(...)`, `list_worktrees(...)`.
- Storage location: `<git-root>/.kimi/worktrees/<name>` — the name auto-generates as `kimi-YYYYMMDD-HHMMSS` (UTC) when omitted.
- Default state is detached HEAD (`git worktree add --detach`); a branch name passes through as `git worktree add <path> <branch>`.
- `SessionState.worktree_path` and `SessionState.parent_repo_path` persist the association on disk.
- `Session.delete(remove_worktree=True)` removes the git worktree before removing the session directory, and is best-effort (logs on failure).

The web path reuses all of it; no new worktree logic is required in `src/kimi_cli/worktree.py`.

## Backend design

### New endpoint: `GET /api/git/info`

**Purpose:** Probe a chosen working directory to (1) gate the worktree toggle on `is_git_repo`, and (2) populate the base-branch picker.

**Request:** `?work_dir=<absolute-path>`

**Response model (`GitInfo`):**

```python
class GitInfo(BaseModel):
    is_git_repo: bool
    git_root: str | None                # canonical path; None when not a repo
    current_branch: str | None          # None when detached
    branches: list[str]                 # local branches; unsorted, server returns as git emits
    head_sha: str | None                # short SHA; None when the repo has no commits
```

**Implementation notes:**

- Location: `src/kimi_cli/web/api/git.py` (new file, router mounted under `/api/git`).
- Runs the following commands via `asyncio.create_subprocess_exec` with `get_clean_env()` (already imported for the existing git-diff route), each with a 5-second timeout:
  - `git rev-parse --show-toplevel`
  - `git symbolic-ref --quiet --short HEAD` (empty stdout on detached)
  - `git branch --format=%(refname:short)`
  - `git rev-parse --short HEAD` (may fail on empty repos — tolerated)
- Any failure (non-repo, git missing, timeout, permission denied) returns `{ is_git_repo: false, git_root: null, current_branch: null, branches: [], head_sha: null }` with HTTP 200. The frontend only needs the boolean to gate the toggle, so a single predictable shape is simpler than mixing 404s/200s.
- Path handling mirrors the existing `create_session` validation: `Path(work_dir).expanduser().resolve()`; a non-existent path returns the empty/false response (no error).
- No caching. The endpoint is cheap and only hits when the user changes the selected path in the dialog (debounced client-side).
- Auth/LAN-only / origin checks inherit from the FastAPI app state just like the other routes.

### Extended endpoint: `POST /api/sessions/`

The existing `CreateSessionRequest` grows three optional fields:

```python
class CreateSessionRequest(BaseModel):
    work_dir: str | None = None
    create_dir: bool = False
    worktree: bool = False
    worktree_branch: str | None = None   # None → detached HEAD
    worktree_name: str | None = None     # None → auto-generated
```

**Flow when `worktree=True`:**

1. Resolve and validate `work_dir` using the existing branch (expanduser → resolve → existence → `create_dir` fallback → `is_dir`).
2. `git_root = await find_git_root(work_dir_kaos)`. If `None`, raise `HTTPException(400, "Selected directory is not inside a git repository")`. (The frontend already gates this with `/api/git/info`, so this path is defensive — covers races and direct API callers.)
3. `worktree_path = await create_worktree(git_root, name=worktree_name, branch=worktree_branch)`. If `WorktreeError` is raised, map to `HTTPException(400, str(exc))` — the message already contains actionable text ("Worktree directory already exists…", git stderr, etc.).
4. Create the session inside the worktree: `kimi_cli_session = await KimiCLISession.create(work_dir=worktree_path)`.
5. Persist the association — this is a NEW step that the web flow must do (the CLI does it inline in `cli/__init__.py`):
   - `kimi_cli_session.state.worktree_path = str(worktree_path)`
   - `kimi_cli_session.state.parent_repo_path = str(git_root)`
   - `kimi_cli_session.save_state()`
6. Return the usual `Session` response, now with `worktree_path` and `parent_repo_path` populated.

**Failure handling:** the worktree-create flow wraps steps 4 and 5 in a try/except. On any exception, call `remove_worktree(git_root, worktree_path)` inside the except (best-effort, logged on failure) before re-raising the original error as an `HTTPException(500, ...)`. This ensures a partially-created session does not leave a dangling worktree on disk.

**Concurrency / reload:** the CLI's `_worktree_created` guard is not relevant here — the web endpoint runs once per request, so there's no "Reload" re-entry concern.

### Extended endpoint: `DELETE /api/sessions/{id}`

Replace the current `shutil.rmtree(session_dir)` at `src/kimi_cli/web/api/sessions.py:581` with `await session.kimi_cli_session.delete()`. That method:

- Removes the git worktree first (best-effort, logged on failure) when `SessionState.worktree_path` / `parent_repo_path` are set.
- Removes the session directory afterward.

The surrounding logic (stopping the session process, clearing `last_session_id`, invalidating caches) stays unchanged. The response stays 204.

### Extended response model

`src/kimi_cli/web/models.py` — `Session` gains:

```python
worktree_path: str | None = Field(default=None, description="Absolute path to this session's git worktree, if any")
parent_repo_path: str | None = Field(default=None, description="Absolute path to the parent git repository root, if worktree-backed")
```

`src/kimi_cli/web/store/sessions.py` — the `JointSession` loader already reads `SessionState`; projecting the two new fields to the `Session` response is a ~4-line addition where other state fields are surfaced.

### Backend file impact summary

- **New:** `src/kimi_cli/web/api/git.py` (router).
- **Modified:** `src/kimi_cli/web/app.py` (register router), `src/kimi_cli/web/api/sessions.py` (extend `CreateSessionRequest`, wire worktree flow into `create_session`, switch `delete_session` to `Session.delete()`), `src/kimi_cli/web/models.py` (two fields on `Session`), `src/kimi_cli/web/store/sessions.py` (surface fields from `SessionState`).

No changes to `src/kimi_cli/worktree.py`, `src/kimi_cli/session.py`, or `src/kimi_cli/session_state.py` — the primitives are already there.

## Frontend design

### Generated client

The frontend uses an OpenAPI-generated client at `web/src/lib/api/`. After the backend changes land, regen via the existing `web/scripts` flow (standard project process). The new endpoint and extended fields appear in `models/Session.ts`, `apis/*`, etc.

### `useGitInfo(workDir)` hook

New file: `web/src/hooks/useGitInfo.ts`.

```ts
type GitInfo = {
  isGitRepo: boolean;
  gitRoot: string | null;
  currentBranch: string | null;
  branches: string[];
  headSha: string | null;
};

export function useGitInfo(workDir: string | null): {
  gitInfo: GitInfo | null;
  isLoading: boolean;
};
```

**Behavior:**
- Debounces `workDir` changes by 250ms (matches the existing `sessionSearch` debounce cadence in `sessions.tsx`).
- Fires `GET /api/git/info?work_dir=<encoded>` with `getAuthHeader()` and `getApiBaseUrl()` like `useSessions.createSession`.
- Cancels in-flight requests when `workDir` changes (AbortController).
- Returns `{ gitInfo: null, isLoading: true }` while the first probe is pending for the current path; subsequent probes keep the old `gitInfo` until the new result lands (stale-while-revalidate).
- Returns `{ gitInfo: null, isLoading: false }` when `workDir` is null/empty.
- Swallows fetch errors and returns `{ gitInfo: { isGitRepo: false, ... }, isLoading: false }` so the UI degrades gracefully.

### `CreateSessionDialog` — two-step flow

Location: `web/src/features/sessions/create-session-dialog.tsx`.

**Step 1 (unchanged):** the existing `CommandDialog` palette for path selection. The `onConfirm` contract widens so step 2 can forward the extra options:

```ts
type CreateSessionDialogProps = {
  // ... existing fields unchanged ...
  onConfirm: (
    workDir: string,
    options?: { createDir?: boolean; worktree?: WorktreeOptions }
  ) => Promise<void>;
};

type WorktreeOptions = {
  enabled: boolean;
  branch: string | null;   // null → detached HEAD
  name: string | null;     // null → auto-generate
};
```

`createDir` moves from a second positional arg to the options bag so the shape stays flat as more flags appear.

**Step 2 (new):** rendered when the user selects a path that turns out to be inside a git repo (`gitInfo.isGitRepo === true`). When the path is not a repo, the dialog calls `onConfirm(workDir)` directly and closes — the existing behavior is preserved for non-git dirs.

**Step 2 layout** (uses existing `shadcn/ui` primitives — `Switch`, `Select`, `Input`, `Button` — and the same `Command` container to avoid a separate dialog framing):

```
┌─────────────────────────────────────────────┐
│ [←]  New session in ~/kimi-cli              │   ← header row: IconButton back, CommandDialog title
├─────────────────────────────────────────────┤
│                                             │
│   ⎇  Create isolated git worktree    (○)   │   ← <Switch>; off by default
│       Runs the session in a detached        │   ← muted-foreground caption
│       git worktree under                    │
│       ~/kimi-cli/.kimi/worktrees/           │
│                                             │
│   Base branch                               │   ← label; foreground
│   ┌───────────────────────────────────────┐ │
│   │ Detached HEAD at 1886a8f          ▾  │ │   ← <Select>; disabled when toggle off
│   └───────────────────────────────────────┘ │
│                                             │
│   Worktree name  (optional)                 │   ← label + muted hint
│   ┌───────────────────────────────────────┐ │
│   │ kimi-20260425-110532                  │ │   ← <Input>; placeholder is preview of auto-name; disabled when toggle off
│   └───────────────────────────────────────┘ │
│                                             │
├─────────────────────────────────────────────┤
│                         [Cancel] [Create]   │   ← footer; Create is primary
└─────────────────────────────────────────────┘
```

**Color & token usage (explicit):** every surface uses the existing theme variables exposed in `web/src/index.css` (both light and dark). No new tokens, no hardcoded hex/rgb values.

- Dialog container: inherited from `CommandDialog` / `Dialog` → `bg-popover`, `text-popover-foreground`, `border-border`.
- Step-2 header strip: `border-b border-border`, title `text-sm font-medium text-foreground`, back button `text-muted-foreground hover:text-foreground hover:bg-accent` (matches the close-button treatment in `sessions.tsx`).
- Toggle row: `Switch` (stock `bg-input` off / `bg-primary` on — shadcn default).
- Caption under the toggle: `text-xs text-muted-foreground`.
- Labels: `text-xs font-medium text-foreground`.
- `Select` and `Input`: stock shadcn → `bg-background border-input text-foreground ring-ring`, with `disabled:opacity-50 disabled:cursor-not-allowed`.
- Branch select "Detached HEAD at <sha>" option: the "Detached HEAD" label is `text-foreground`, the short SHA is `text-muted-foreground` (so it reads visually as secondary metadata).
- Current-branch marker: suffix `(current)` in `text-muted-foreground` on the current branch option.
- Error region: `text-destructive text-xs` in a row above the footer, with an `AlertTriangle` icon (`text-destructive`). No background fill.
- Footer: `border-t border-border`; Cancel is `variant="outline"`, Create is default `variant="default"` (which already maps to `bg-primary text-primary-foreground`).

**Defaults and form behavior:**

- Switch defaults `off`. User opts in per session.
- Branch `Select` defaults to the "Detached HEAD at `<head_sha>`" option; this option is always first in the list.
- Branches list order: `Detached HEAD at <sha>` → `current_branch` (with `(current)` suffix) → remaining branches as returned by git.
- Name `Input` placeholder mirrors the server's auto-name format: `kimi-YYYYMMDD-HHMMSS` with the current UTC time at dialog-open, refreshed lazily on focus so a long-idle dialog shows a reasonable preview.
- When the toggle is off, both inputs render `disabled` so the user can see what's available without toggling.
- `Create` is disabled while `isLoading` for `git_info` is true; the button shows a `Loader2` spinner in its leading icon slot during the create POST.
- Validation: `worktree_name` client-side regex `/^[a-zA-Z0-9._-]+$/` (mirrors safe-filename conventions already used elsewhere). Empty passes through as auto-generate.
- Backend errors (`WorktreeError`, 400 "Not a git repository", etc.) render inline above the footer in the `text-destructive` row — not as a toast — because the user needs to adjust the form. Network errors still toast (via the existing `sessionsError` path).

**Keyboard:**
- Tab order: Switch → Base-branch Select → Name Input → Cancel → Create.
- `Escape` from step 2 returns to step 1 (path selection). `Escape` from step 1 closes the dialog (existing behavior).
- Back arrow is a real `<button>` with `aria-label="Back to directory selection"`.

**Edge cases:**
- Repo with zero commits: `headSha` is `null` → label becomes `Detached HEAD`. `branches` is likely empty; select shows only the detached option.
- `gitInfo` still loading when step 2 is rendered: toggle row shows a small `Loader2` (muted-foreground) next to the label; Create stays enabled for the non-worktree path but the toggle is `disabled`.
- User toggles on, then navigates back to step 1 and picks a non-git path: the stored options bag is cleared on path change so the next submit doesn't carry stale worktree intent.

### `useSessions.createSession`

Location: `web/src/hooks/useSessions.ts:416`.

Signature widens from `(workDir?: string, createDir?: boolean)` to:

```ts
createSession(
  workDir?: string,
  options?: { createDir?: boolean; worktree?: WorktreeOptions }
): Promise<Session>
```

The body builder adds:

```ts
if (options?.worktree?.enabled) {
  body.worktree = true;
  body.worktree_branch = options.worktree.branch;
  body.worktree_name = options.worktree.name;
}
```

All existing call sites (URL-param action handler at `App.tsx:124`, directory-group `+` click at `sessions.tsx`) pass no options and behave identically.

`App.tsx`'s `handleCreateSession` at line 298 forwards the options bag unchanged.

### Sidebar session row (sessions.tsx)

Add a `GitBranch` icon import from `lucide-react`. Inside both `itemContent` branches (list view + grouped view) where `SessionRunningIndicator` currently renders:

```tsx
{session.worktreePath && (
  <Tooltip>
    <TooltipTrigger asChild>
      <GitBranch className="size-3 shrink-0 text-muted-foreground" />
    </TooltipTrigger>
    <TooltipContent side="right">
      Worktree · {shortenPath(session.worktreePath)}
    </TooltipContent>
  </Tooltip>
)}
```

Color tokens: `text-muted-foreground` (matches the existing `updatedAt` metadata). On row hover the parent `hover:bg-secondary/60` stays; the icon does not brighten on hover (consistent with `SessionRunningIndicator`).

The `SessionSummary` type (defined in `sessions.tsx`) gains `worktreePath?: string | null`. `useSessions` populates this in its session-mapping block alongside `workDir` at lines ~251/293.

### Session info popover (session-info-popover.tsx)

When `session?.worktreePath` is truthy, add two `SessionInfoItem` rows right after "Working Directory":

```tsx
<SessionInfoItem
  label="Worktree"
  value={session.worktreePath}
  icon={<GitBranch className="size-3.5 text-muted-foreground" />}
/>
{session.parentRepoPath && (
  <SessionInfoItem
    label="Parent repo"
    value={session.parentRepoPath}
    icon={<Folder className="size-3.5 text-muted-foreground" />}
  />
)}
```

The current `SessionInfoItem` (at `session-info-popover.tsx:15-20`) accepts only `label` and `value`. The implementation adds an optional `icon?: ReactNode` prop rendered left of the label, then uses it for both rows above. If the icon prop adds meaningful complexity to existing rows, fall back to label-only rows — the important signal is the label text itself, not the icon.

The full worktree path is rendered via the existing `SessionInfoItem` value field (which already handles long-path truncation with a tooltip, per the current Working Directory row). No new color tokens.

### Delete-confirmation dialog (sessions.tsx)

The confirmation `Dialog` at the bottom of `sessions.tsx` (around the `deleteConfirm` state) gets a conditional warning line. `SessionSummary` already grew a `worktreePath` field in the step above, so it's available on the delete path:

```tsx
{session.worktreePath && (
  <div className="mt-3 flex items-start gap-2 text-xs text-destructive">
    <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
    <span>
      This session's git worktree (<code className="font-mono">{worktreeName(session.worktreePath)}</code>)
      will also be removed. Any uncommitted work in the worktree will be lost.
    </span>
  </div>
)}
```

Where `worktreeName(path)` extracts the final path segment. Color tokens: `text-destructive` only; no destructive background wash (keeps the dialog body weight lighter than the primary destructive-button action).

## Data flow summary

```
 ┌───────────────┐      dirs         ┌──────────────────────┐
 │  Create       │─── GET /api/work- │  FastAPI backend     │
 │  Session      │    dirs/,         │  src/kimi_cli/web    │
 │  Dialog       │    /startup       │                      │
 │  (step 1)     │                   │                      │
 └──────┬────────┘                   │                      │
        │ path chosen                │                      │
        ▼                            │                      │
 ┌───────────────┐   GET /api/git/   │                      │
 │ useGitInfo    │───info?work_dir──▶│ api/git.py           │
 │ (debounced)   │◀────GitInfo──────│                      │
 └──────┬────────┘                   │                      │
        │ isGitRepo?                 │                      │
        ▼                            │                      │
 ┌───────────────┐                   │                      │
 │  Create       │   POST /api/      │                      │
 │  Session      │   sessions/ ─────▶│ api/sessions.py      │
 │  Dialog       │   { work_dir,     │  ├─ find_git_root    │
 │  (step 2)     │     worktree,     │  ├─ create_worktree  │
 └───────────────┘     worktree_name │  ├─ KimiCLISession   │
                       worktree_bra- │  │  .create()        │
                       nch }         │  ├─ persist state    │
                         ◀── Session │  └─ return Session   │
                             (incl.  │                      │
                             worktr- │                      │
                             ee_pat- │                      │
                             h, par- │                      │
                             ent_re- │                      │
                             po_pat- │                      │
                             h)      │                      │
 ┌───────────────┐                   │                      │
 │ Sidebar row   │   shows GitBranch │                      │
 │ (sessions.tsx)│   icon when       │                      │
 │               │   worktreePath    │                      │
 └───────────────┘                   │                      │
                                     │                      │
 ┌───────────────┐   DELETE /api/    │                      │
 │ Delete dialog │   sessions/{id}──▶│ api/sessions.py      │
 │               │                   │  └─ Session.delete() │
 │ warns about   │                   │     removes          │
 │ worktree loss │                   │     worktree first   │
 └───────────────┘                   └──────────────────────┘
```

## Testing

### Backend

- New `tests/test_web_api_git_info.py`:
  - Non-existent path → `{ is_git_repo: false, ... }`.
  - Existing non-repo dir → `{ is_git_repo: false, ... }`.
  - Fresh `git init` dir, no commits → `{ is_git_repo: true, head_sha: null, branches: [], current_branch: null | "main" }` (depending on git's default init behavior).
  - Populated repo → `{ is_git_repo: true, head_sha: "<7-char>", branches: [...], current_branch: "..." }`.
  - Timeout path (git hangs) → `{ is_git_repo: false, ... }`. (May skip as an integration-only case if infeasible to simulate deterministically.)
- Extend `tests/test_web_api_sessions.py` (or create) to cover:
  - `POST /api/sessions/ {worktree: true}` on a non-git dir → 400.
  - `POST /api/sessions/ {worktree: true}` on a git repo → 200, response includes `worktree_path` and `parent_repo_path`, and a worktree directory exists on disk.
  - `POST /api/sessions/ {worktree: true, worktree_branch: "<nonexistent>"}` → 400 with `WorktreeError` message.
  - `DELETE /api/sessions/{id}` on a worktree session → worktree is gone afterward.
  - `DELETE /api/sessions/{id}` when worktree removal fails → session dir is still removed, no 500 raised.

### Frontend

- `create-session-dialog.test.tsx` (new file; matches the existing `session-running-indicator.test.tsx` convention):
  - Step 1 → picks a non-git path → step 2 is skipped, `onConfirm` called with no worktree options.
  - Step 1 → picks a git path → step 2 renders with toggle off.
  - Step 2 toggle on → branch select and name input enable; default option is "Detached HEAD at `<sha>`".
  - Step 2 submit → `onConfirm` is called with the worktree options bag.
  - Backend error from submit renders inline (not as toast).
- `useGitInfo.test.ts` (new): debounce, cancel-in-flight, graceful degrade on fetch failure.

### E2E / manual smoke

- Create a worktree-backed session via the web UI in a real git repo; confirm:
  - Session runs inside `<repo>/.kimi/worktrees/<name>`.
  - Sidebar row shows the `GitBranch` icon.
  - Session info popover shows Worktree + Parent repo rows.
  - Deleting the session removes the worktree directory and prunes `git worktree list`.

## Rollout notes

- No config flag needed — the feature is purely additive. Existing non-worktree session flows are unchanged.
- The OpenAPI regeneration step is part of the frontend PR; both the model addition and the new endpoint must regen cleanly.
- The backend changes (`DELETE` switching from `shutil.rmtree` to `Session.delete()`) affect all web-deleted sessions, not just worktree ones. This is a behavior correction — the CLI already calls `Session.delete()` — so this aligns the two paths.

## Open follow-ups (post-merge)

- Remote-branch picker (`git branch -r`) and "fetch and check out" behavior.
- "Create branch here" after a detached-HEAD worktree has been worked on.
- Worktree-management view or an "orphan worktree" reaper.
- Handoff between local and worktree (Codex's "Hand off" flow).
