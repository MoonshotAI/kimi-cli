# Changelog

This page documents the changes in each Kimi Code CLI release.

## Unreleased

- Shell: Show active background agent task count in the prompt status bar — the existing `⚙ bash: N` badge only counted background Shell tasks and filtered out background Agent subagents, so when many subagents were running the prompt looked idle and users could not tell work was in progress; the toolbar now renders `⚙ bash: N` and `⚙ agent: N` as two independent badges (each hidden when its count is 0) and drops the agent badge first when the terminal is too narrow to fit both
- Auth: Fix managed model list refresh silently failing for OAuth users with expired tokens — the background `/models` sync now detects 401 responses, forces an OAuth token refresh, and retries with the refreshed token; if the refresh fails or the refreshed token is still rejected, it falls back to the originally configured static API key instead of skipping the provider
- Core: Fix connection recovery not triggering OAuth refresh when the retry returns 401 — after recreating the HTTP client on `APIConnectionError` or `APITimeoutError`, the retry now re-enters the full recovery path so a subsequent 401 correctly refreshes the OAuth token instead of bubbling to the user as an unrecoverable error

## 1.39.0 (2026-04-24)

- Skill: Fix project-scope skills being ignored and user-scope skills silently winning name conflicts — the system prompt now groups discovered skills under `### Project` / `### User` / `### Extra` / `### Built-in` headings so the model can tell where each skill came from, and when the same name exists in multiple scopes the more specific scope wins (Project > User > Extra > Built-in) so a project's own `.kimi/skills/foo` or `.claude/skills/foo` correctly overrides a user-level or bundled `foo` instead of the other way around
- Skill: Accept single-file `<name>.md` skills alongside the canonical `<name>/SKILL.md` subdirectory layout — useful when migrating a flat markdown collection into a skills directory; `name` defaults to the filename stem (frontmatter `name:` still wins if set), description follows the same three-step chain as subdirectory skills (frontmatter `description:` → first non-empty body line, capped at 240 characters → `"No description provided."` placeholder), and if a flat and a subdirectory skill share a name in the same directory the subdirectory wins with a warning
- Skill: Add `extra_skill_dirs` config field for pulling in custom skill directories on top of the built-in / user / project auto-discovery — each entry may be an absolute path, a `~`-prefixed path (expanded against `$HOME`), or a path relative to the project root (the nearest `.git` ancestor of the work directory, not the current working directory); non-existent entries are silently skipped and symlink/trailing-slash duplicates canonicalize to a single root so a path listed twice or aliased to an already-discovered directory does not render twice in the system prompt
- Skill: Harden discovery against `OSError` from `is_dir` / `iterdir` (for example when an `extra_skill_dirs` entry points at a directory with restricted permissions) — affected entries are logged and skipped instead of aborting the whole skill-discovery pass
- Core: Fix DeepSeek V4 (and other OpenAI-compatible thinking-mode backends) returning 400 `The reasoning_content in the thinking mode must be passed back to the API` when a tool call follows a reasoning turn — `openai_legacy` providers now default `reasoning_key` to `"reasoning_content"` so the response's reasoning is stored in history and round-tripped automatically on subsequent turns. An optional `reasoning_key` field is also added to `LLMProvider` to override the field name (e.g. `"reasoning"` for non-standard gateways) or disable round-tripping entirely by setting it to `""`
- Core: Add `skip_yolo_prompt_injection` config option to suppress the system reminder normally injected when yolo mode is active — useful when building custom applications on top of `KimiSoul` that do not need the non-interactive mode hint
- Kimi: Add `KIMI_MODEL_THINKING_KEEP` environment variable that forwards its value verbatim to the Moonshot API as `thinking.keep`, enabling Preserved Thinking (e.g. `export KIMI_MODEL_THINKING_KEEP=all` to retain historical `reasoning_content` across turns); effective only for Moonshot models supporting Preserved Thinking (e.g. `kimi-k2.6` / `kimi-k2-thinking`), unset or empty string preserves the previous behavior and omits the field, and the override only applies when the current model is actually in thinking mode so the API never receives a `thinking.keep` without the companion `thinking.type`. Note that `keep=all` increases input tokens and API cost because history reasoning is resent
- Kosong: Fix `Kimi.with_extra_body` silently dropping previously set `thinking.type` when a later call added another `thinking.*` field — the `thinking` sub-dict is now merged field-by-field instead of shallow-replaced, so composing `with_thinking(...)` with `with_extra_body({"thinking": {...}})` preserves both contributions
- Kosong: Fix Kimi provider sending empty `content` alongside `tool_calls`, which caused 400 "text content is empty" errors from the Moonshot API. When an assistant message has tool calls and its visible content is effectively empty (no text or only whitespace/think parts), the `content` field is now omitted entirely
- Shell: Fix approval request feedback text cursor rendering — the block cursor now correctly renders at the actual cursor position instead of always being pinned to the end of the line; when the cursor is in the middle of the text, the character under the cursor is drawn with reverse video (mimicking a terminal's native block cursor)
- Kosong: Fix Moonshot 400 `At path 'properties.X': type is not defined` when an MCP server exposes tools whose parameter schemas have enum-only or otherwise type-less properties (seen with the JetBrains Rider MCP's `truncateMode`) — the Kimi provider now patches each tool's schema in-flight to fill in a JSON Schema `type` (inferred from `enum`/`const` values when possible, else defaulted to `"string"`), so the whole session no longer fails every request with a schema validation error; OpenAI and Anthropic paths are unaffected
- Skill: Project-scope skill discovery now walks up to the nearest `.git` ancestor before looking for `.kimi/skills` / `.claude/skills` / `.codex/skills` / `.agents/skills`, so skills defined at the repository root are picked up even when kimi-cli is launched from a subdirectory (for example inside a monorepo package). Falls back to the work directory itself when no `.git` marker is found, so we never walk up into an unrelated parent tree.
- Skill: Change the default of `merge_all_available_skills` from `false` to `true`. kimi-cli now merges all existing user- and project-level brand skill directories (`.kimi/skills`, `.claude/skills`, `.codex/skills`) by default instead of only using the first one found, so users who keep skills in multiple brand directories — for example both `~/.kimi/skills` and `~/.claude/skills` — see every skill out of the box. **Behavior change**: users who previously relied on the first-match default can restore it by setting `merge_all_available_skills = false` in their config.

## 1.38.0 (2026-04-22)

- Shell: Fix `Rejected by user` misleading message when an approval modal times out — after the 300s safety timeout, the tool call now rejects with `Rejected: approval timed out`, so users returning to their session after stepping away can tell the rejection was a timeout rather than a manual rejection. Pass `--yolo`/`-y` to auto-approve tool calls if you regularly leave sessions unattended
- Auth: Fix OAuth users being forced to `/login` again after an unrelated refresh-token rotation race — when a concurrently-running kimi-cli instance (terminal, VS Code extension, or `kimi -p` one-shot) legitimately rotated the refresh token, the current instance's now-stale refresh request would come back with a 401, and a TOCTOU window between the "did another instance rotate?" disk check and the `delete_tokens` call could wipe the credentials file even though a valid rotated token was about to be written to it; the in-memory cache is still cleared so truly revoked tokens surface on the next request, but the file is preserved so a concurrent instance's freshly-rotated token can be recovered, and an eventual `/login` still overwrites it atomically
- Kosong: Fix parallel tool results being split into multiple user messages in Anthropic provider — consecutive tool-result-only user messages are now merged into a single message, complying with the Anthropic Messages API spec that all `tool_use` blocks in an assistant turn must be answered within one user message; this fixes 400 errors on strict Anthropic-compatible backends (e.g. DeepSeek `/anthropic` endpoint) and prevents the official backend from silently teaching the model to avoid parallel tool calls

## 1.37.0 (2026-04-20)

- Print: Wait for background tasks before exiting — in one-shot `--print` mode, the process now waits for running background agents to finish and lets the model process their results, instead of exiting and killing them. The wait is capped at `min(max(active_task.timeout_s or agent_task_timeout_s), print_wait_ceiling_s)` (default ceiling 1h); on timeout the tasks are killed and the model gets one more turn via a `<system-reminder>` to summarise before exit
- Shell/Print: On exit the CLI now lists each background task being killed (id + description) on stderr and waits out the configured grace period before reporting any tasks that have not reached terminal state (split into "still terminating" for workers mid-shutdown vs "stop request failed" for genuinely leaking tasks); `keep_alive_on_exit=true` still skips the entire path
- Auth: Auto-refresh the managed model list at startup for OAuth-logged-in users — the CLI now fetches the latest models from the provider's `/models` endpoint as a background task when the shell launches, so newly released models become available without needing to log out and log back in; failures are silent and never block startup, and custom `--config` sessions keep their previous behavior
- Shell: Show the provider-supplied `display_name` (e.g. `k2.6-code-preview`) for managed models across the welcome panel, prompt status bar, `/model` picker, and `/model` switch confirmation messages; when the backend does not return one, the CLI falls back to the internal model ID as before

## 1.36.0 (2026-04-17)

- Anthropic: Fix Claude Opus 4.7 returning `invalid_request_error` — Opus 4.7 (which rejects the legacy `{type: "enabled", budget_tokens: N}` thinking config) now correctly uses adaptive thinking, and the client explicitly sets `display: "summarized"` so thinking content still streams back (Opus 4.7 silently changed the default to `"omitted"`); Bedrock/Vertex name variants (e.g., `aws/claude-opus-4-7`, `anthropic.claude-opus-4-7-v1:0`) and `claude-mythos-preview` are also recognised, and future Claude versions ≥ 4.6 are detected automatically via version extrapolation instead of hard-coded substring matching
- Web: Fix markdown rendering spacing in the web UI — restore proper vertical spacing between paragraphs, lists, code blocks, blockquotes, and headings instead of collapsing all margins to zero
- Shell: Fix missing loading indicator during active turns — the moon spinner now shows as a fallback whenever the model is working but no other indicator is visible, covering gaps after tool calls finish, between turn start and first step, and when an empty thinking block arrives from the provider
- Core: Increase default `max_steps_per_turn` from 100 to 500 to allow longer uninterrupted agent runs out of the box
- Web: Fix unresponsive copy, download, and preview buttons on rendered code blocks

## 1.35.0 (2026-04-15)

- Shell: Flip `show_thinking_stream` default to `true` so fresh installs see the streaming reasoning preview out of the box; set it to `false` in your config to keep the compact 1.32 indicator
- Web: Prevent stream watchdog from reconnecting during pending approval or question — the 45-second inactivity watchdog no longer triggers a reconnect while the user is actively handling an approval request or answering a question, preventing interrupted interactions
- Web: Fix session recovery after stream errors — when a session process exits or hits a read-loop error, stale in-flight prompt IDs are now cleared before broadcasting the error, allowing the frontend to send new messages instead of getting "Session is busy"; the activity status indicator also surfaces the actual error message from the stream
- Core: Fix Wire server prompt handler leaving sessions stuck busy on uncaught exceptions — SSL errors, connection errors, and other unexpected failures are now caught by a fallback handler and returned as `INTERNAL_ERROR`, allowing the session to recover instead of hanging indefinitely

## 1.34.0 (2026-04-14)

- Core: Fix CLI crash on `TaskStop` — stopping a stuck background agent no longer prints `Unhandled exception in event loop / Exception None` and freezes the terminal; the cancelled task is now kept in the manager's live-tasks dict until its runner finishes cleaning up, preventing Python's GC from reaping the still-pending task
- Shell: Fix inline diff highlights misaligned on lines containing tabs — raw-code diff offsets are now mapped to rendered positions via expandtabs column tracking so highlight spans land correctly after tab expansion
- Shell: Add `show_thinking_stream` config option to opt back into the legacy streaming reasoning preview — when set to `true`, the live area shows the classic `Thinking...` spinner above a 6-line scrolling preview of the raw reasoning text and the full reasoning markdown is committed to history when the block ends; defaults to `false` to keep the compact 1.32 indicator

## 1.33.0 (2026-04-13)

- Shell: Unify managed model display as "Kimi for Code" and drop hardcoded `kimi-k2.5` version references from the welcome screen and `/login` tip

## 1.32.0 (2026-04-13)

- Core: Truncate MCP tool output to 100K characters to prevent context overflow — all content types (text and inline media such as image/audio/video data URLs) share a single character budget; tools like Playwright that return full DOMs (500KB+) or large base64 screenshots are now capped with a truncation notice; oversized media parts are dropped; unsupported MCP content types are gracefully handled instead of crashing the turn
- CLI: Fix PyInstaller binary missing lazy CLI subcommands — `kimi info`, `kimi export`, `kimi mcp`, `kimi plugin`, `kimi vis`, and `kimi web` now work correctly in the standalone binary distribution
- Shell: Streamline the thinking indicator into a compact single-line layout — shows a `Thinking` label with animated dots, elapsed time, token count, and a live tokens/second pulse; finalises with a `Thought for Xs · N tokens` trace in history

## 1.31.0 (2026-04-10)

- Core: Cap `list_directory` output as a depth-limited tree to prevent token-limit blowup in large directories — replaces the unbounded flat listing with a 2-level tree (root: 30 entries, child: 10 per subdirectory), dirs-first alphabetical sorting, and `"... and N more"` truncation hints so the model knows to explore further (fixes #1809)
- Shell: Add blocking update gate on interactive shell startup — when a newer version is detected (from the existing background check cache), a blocking prompt appears before the shell loads, offering `[Enter]` to upgrade immediately, `[q]` to continue and be reminded next time, or `[s]` to skip reminders for that version; respects the `KIMI_CLI_NO_AUTO_UPDATE` environment variable; replaces the previous repeating toast notification for available updates
- Auth: Harden OAuth token refresh to prevent unnecessary re-login — 401 errors now trigger automatic token refresh and retry instead of forcing `/login`; multiple simultaneous CLI instances coordinate refresh via a cross-process file lock to avoid race conditions; token persistence uses atomic writes with `fsync` to prevent corruption; adds dynamic refresh threshold, 5xx retry during token refresh, and proper token revocation cleanup
- Core: Fix agent loop silently stopping when model response contains only thinking content — detect think-only responses (reasoning content with no text or tool calls) as an incomplete response error and retry automatically
- Core: Fix crash on streaming mid-flight network disconnection — when the OpenAI SDK raises a base `APIError` (instead of `APIConnectionError`) during long-running streams, the error is now correctly classified as retryable, enabling automatic retry and connection recovery instead of an unrecoverable crash
- Shell: Exclude empty current session from `/sessions` picker — completely empty sessions (no conversation history and no custom title) are no longer shown in the session list; sessions with a custom title are still displayed
- Shell: Fix slash command completion Enter key behavior — accepting a completion now submits in a single Enter press; auto-submit is limited to slash command completions only; file mention completions (`@`) accept without submitting so the user can continue editing; re-completion after accepting is suppressed to prevent stale completion state
- Shell: Add directory scope toggle to `/sessions` picker — press `Ctrl+A` to switch between showing sessions for the current working directory only or across all known directories; uses a new full-screen session picker UI with header scope indicator and footer hint bar
- Shell: Add `/btw` side question command — ask a quick question during streaming without interrupting the main conversation; uses the same system prompt and tool definitions for prompt cache alignment; responses display in a scrollable modal panel with streaming support
- Shell: Redesign bottom dynamic area — split the monolithic `visualize.py` (1865 lines) into a modular package (`visualize/`) with dedicated modules for input routing, interactive prompts, approval/question panels, and btw modal; unify input semantics with `classify_input()` for consistent command routing
- Shell: Add queue and steer dual-channel input during streaming — Enter queues messages for delivery after the current turn; Ctrl+S injects messages immediately into the running turn's context; queued messages display in the prompt area with count indicator and can be recalled with ↑
- Shell: Add `BtwBegin`/`BtwEnd` wire events for cross-client side question support
- Shell: Improve elapsed time formatting in spinners — durations over 60 seconds now display as `"1m 23s"` instead of `"83s"`; sub-second durations show `"<1s"`
- Shell: Fix Rich markup injection in btw panel — user questions containing `[`/`]` characters are now escaped to prevent broken rendering or style injection in spinner text and panel titles
- Core: Improve error diagnostics — enrich internal logging coverage, include relevant log files and system manifest in `kimi export` archives, and surface actionable error messages for common failures (auth, network, timeout, quota)
- Shell: Gracefully exit with crash report when working directory becomes inaccessible during session — detects CWD loss (external drive unplugged, directory deleted, or filesystem unmounted) and prints a session recovery panel with session ID and work directory before exiting cleanly
- Shell: Use `git ls-files` for `@` file mention discovery — file completer now queries `git ls-files --recurse-submodules` with a 5-second timeout as the primary discovery mechanism, falling back to `os.walk` for non-git repositories; this fixes large repositories (e.g., apache/superset with 65k+ files) where the 1000-file limit caused late-alphabetical directories to be unreachable (fixes #1375)
- Core: Add shared `file_filter` module — unifies file mention logic between shell and web UIs via `src/kimi_cli/utils/file_filter.py`, providing consistent path filtering, ignored directory exclusion, and git-aware file discovery
- Shell: Prevent path traversal in file mention scope parameter — the `scope` parameter in file completer requests is now validated to prevent directory traversal attacks
- Web: Restore unfiltered directory listing in file browser API — file browser endpoint no longer applies git-aware filtering, ensuring all files are visible in the web UI file picker
- Todo: Refactor SetTodoList to persist state and prevent tool call storms — todos are now persisted to session state (root agent) and independent state files (sub-agents); adds query mode (omit `todos` to read current state) and clear mode (pass `[]`); includes anti-storm guidance in tool description to prevent repeated calls without progress (fixes #1710)
- ReadFile: Add total line count to every read response and support negative `line_offset` for tail mode — the tool now reports `Total lines in file: N.` in its message so the model can plan subsequent reads; negative `line_offset` (e.g. `-100`) reads the last N lines using a sliding window, useful for viewing recent log output without shell commands; the absolute value is capped at 1000 (MAX_LINES)
- Shell: Fix black background on inline code and code blocks in Markdown rendering — `NEUTRAL_MARKDOWN_THEME` now overrides all Rich default `markdown.*` styles to `"none"`, preventing Rich's built-in `"cyan on black"` from leaking through on non-black terminals

## 1.30.0 (2026-04-02)

- Shell: Refine idle background completion auto-trigger — resumed shell sessions no longer auto-start a foreground turn from stale pending background notifications before the user sends a message, and fresh background completions now wait briefly while the user is actively typing to avoid stealing the prompt or breaking CJK IME composition
- Core: Fix interrupted foreground turns leaving unbalanced wire events — `TurnEnd` is now emitted even when a turn exits via cancellation or step interruption, preventing dirty session wire logs from accumulating across resume cycles
- Core: Improve session startup resilience — `--continue`/`--resume` now tolerate malformed `context.jsonl` records and corrupted subagent, background-task, or notification artifacts; the CLI skips invalid persisted state where possible instead of failing to restore the session
- CLI: Improve `kimi export` session export UX — `kimi export` now previews the previous session for the current working directory and asks for confirmation, showing the session ID, title, and last user-message time; adds `--yes` to skip confirmation; also fixes explicit session-ID invocations where `--output` after the argument was incorrectly parsed as a subcommand
- Grep: Add `include_ignored` parameter to search files excluded by `.gitignore` — when set to `true`, ripgrep's `--no-ignore` flag is enabled, allowing searches in gitignored artifacts such as build outputs or `node_modules`; sensitive files (like `.env`) remain filtered by the sensitive-file protection layer; defaults to `false` to preserve existing behavior
- Core: Add sensitive file protection to Grep and Read tools — `.env`, SSH private keys (`id_rsa`, `id_ed25519`, `id_ecdsa`), and cloud credentials (`.aws/credentials`, `.gcp/credentials`) are now detected and blocked; Grep filters them from results with a warning, Read rejects them outright; `.env.example`/`.env.sample`/`.env.template` are exempted
- Core: Fix parallel foreground subagent approval requests hanging the session — in interactive shell mode, `_set_active_approval_sink` no longer flushes pending approval requests to the live view sink (which cannot render approval modals); requests stay in the pending queue for the prompt modal path; also adds a 300-second timeout to `wait_for_response` so that any unresolved approval request eventually raises `ApprovalCancelledError` instead of hanging forever
- CLI: Add `--session`/`--resume` (`-S`/`-r`) flag to resume sessions — without an argument opens an interactive session picker (shell UI only); with a session ID resumes that specific session; replaces the reverted `--pick-session`/`--list-sessions` design with a unified optional-value flag
- CLI: Add CJK-safe `shorten()` utility — replaces all `textwrap.shorten` calls so that CJK text without spaces is truncated gracefully instead of collapsing to just the placeholder
- Core: Fix skills in brand directories (e.g. `~/.kimi/skills/`) silently disappearing when a generic directory (`~/.config/agents/skills/`) exists but is empty — skill directory discovery now searches brand and generic directory groups independently and merges both results, instead of stopping at the first existing directory across all candidates
- Core: Add `merge_all_available_skills` config option — when enabled, skills from all existing brand directories (`~/.kimi/skills/`, `~/.claude/skills/`, `~/.codex/skills/`) are loaded and merged instead of using only the first one found; same-name skills follow priority order kimi > claude > codex; disabled by default
- CLI: Add `--plan` flag and `default_plan_mode` config option — start new sessions in plan mode via `kimi --plan` or by setting `default_plan_mode = true` in `~/.kimi/config.toml`; resumed sessions preserve their existing plan mode state
- Shell: Add `/undo` and `/fork` commands for session forking — `/undo` lets you pick a previous turn and fork a new session with the selected message pre-filled for re-editing; `/fork` duplicates the entire session history into a new session; the original session is always preserved
- CLI: Add `-r` as a short alias for `--session` and print a resume hint (`kimi -r <session-id>`) whenever a session exits — covers normal exit, Ctrl-C, `/undo`, `/fork`, and `/sessions` switch so users can always find their way back
- Core: Fix `custom_headers` not being passed to non-Kimi providers — OpenAI, Anthropic, Google GenAI, and Vertex AI providers now correctly forward custom headers configured in `providers.*.custom_headers`

## 1.29.0 (2026-04-01)

- Core: Support hierarchical `AGENTS.md` loading — the CLI now discovers and merges `AGENTS.md` files from the git project root down to the working directory, including `.kimi/AGENTS.md` at each level; deeper files take priority under a 32 KiB budget cap, ensuring the most specific instructions are never truncated
- Core: Fix empty sessions lingering on disk after exit — sessions created but never used are now cleaned up on all exit paths (failure exit, session switch, unexpected errors), not just on successful exit
- Shell: Add `KIMI_CLI_PASTE_CHAR_THRESHOLD` and `KIMI_CLI_PASTE_LINE_THRESHOLD` environment variables to control when pasted text is folded into a placeholder — lowering these thresholds works around CJK input method breakage after multiline paste on some terminals (e.g., XShell over SSH)
- Shell: Fix diff panel rendering corruption on terminals without truecolor support (e.g. Xshell) — `render_to_ansi` no longer hardcodes 24-bit color; Rich now auto-detects terminal capability via `COLORTERM`/`TERM` environment variables
- Web: Fix white screen after CLI upgrade caused by browser caching stale `index.html` — the server now returns `Cache-Control: no-cache` for HTML and `immutable` for hashed assets, preventing 404s on renamed chunks
- Core: Fix file write converting LF to CRLF on Windows — `writetext` now opens files with `newline=""` to prevent Python's universal newline translation from silently converting `\n` to `\r\n`
- Core: Support `socks://` proxy scheme — proxy tools like V2RayN set `ALL_PROXY=socks://...` which httpx/aiohttp don't recognise; the CLI now normalises `socks://` to `socks5://` at startup so all HTTP clients and subprocesses work correctly behind a SOCKS proxy
- Shell: Add `/title` (alias `/rename`) command to manually set session titles — titles are now stored in `state.json` alongside other session state; legacy `metadata.json` is automatically migrated on first load
- Shell: Fix garbled pager output when `MANPAGER` is set (e.g. `bat`) — the console pager now ignores `MANPAGER` and delegates to `pydoc.pager()`, preserving `PAGER` and all platform-specific fallbacks
- Explore: Enhance explore agent with specialist role, thoroughness levels, and automatic environment context — explore agents now gather repository environment information at launch to improve investigation quality; the main agent is guided to prefer explore for codebase research and plan mode encourages explore-first investigation
- Shell: Fix tool call display showing raw OSC 8 escape bytes (e.g. `8;id=391551;https://…`) instead of clean text — hyperlink sequences are now wrapped as zero-width escapes for prompt_toolkit compatibility, preserving clickable links in supported terminals
- Core: Add OS and shell information to the system prompt — the model now knows which platform it is running on and receives a Windows-specific instruction to prefer built-in tools over Shell commands, preventing Linux command errors in PowerShell
- Shell: Fix `command` parameter description saying "bash command" regardless of platform — the description is now platform-neutral
- Web: Fix auto-title overwriting manual session rename — when a user renames a session through the web UI, the new title is now preserved and no longer replaced by the auto-generated title
## 1.28.0 (2026-03-30)

- Core: Fix file write/replace tools freezing the event loop — diff computation (`build_diff_blocks`) is now offloaded to a thread via `asyncio.to_thread`, preventing the UI from hanging when editing large files
- Shell: Fix `_watch_root_wire_hub` silently dying on handler exceptions — the watcher now catches and logs exceptions (matching the pattern in `wire/server.py`) and handles `QueueShutDown` gracefully, preventing approval flow from silently breaking mid-session
- Core: Skip O(n²) diff computation for huge files (>10 000 lines) — files above the threshold now show a summary block instead of computing a full diff, and unchanged files short-circuit immediately
- Wire: Add `is_summary` field to `DiffDisplayBlock` (Wire 1.8) — marks diff blocks that contain a line-count summary instead of actual diff content, allowing clients to render them appropriately
- Web: Render large-file diff summaries — when a diff block is marked `is_summary`, the web UI shows a compact "File too large for inline diff" notice with line counts instead of attempting to compute a diff
- Auth: Fix OAuth users getting "incorrect API KEY" when running skills or after idle — 401 errors now show a clear "please /login" message instead of the raw API error; the ACP layer correctly triggers re-login flow for VS Code extension users
- Web: Fix session title generation always failing for OAuth users — the title generator now uses OAuth tokens and refreshes them before calling the model
- Core: Add timeout protection for Agent tool and HTTP requests — all `aiohttp` sessions now default to 120 s total / 60 s read timeout; the Agent tool gains an optional `timeout` parameter (foreground default 10 min, background default 15 min); background agent tasks are marked `timed_out` on expiry with proper notification semantics
- Grep: Fix tool hanging and becoming uninterruptible — replaced blocking `ripgrepy.run()` with async subprocess execution; the tool now responds to Ctrl-C immediately and has a 20-second timeout with partial result return
- Grep: Add token efficiency improvements — default `head_limit` of 250 with `offset` pagination, `--hidden` search with VCS directory exclusion, `files_with_matches` sorted by modification time, relative path output, and `--max-columns 500` for non-content modes
- Grep: `line_number` (`-n`) now defaults to `true` in content mode — line numbers are included by default so the model can reference precise code locations
- Grep: `count_matches` mode now includes a summary in the message — e.g. "Found 30 total occurrences across 10 files."
- ACP: Fix `ValueError: list.index(x): x not in list` crash when ACP is launched via `kimi-code` or `kimi-cli` entry-points (e.g. JetBrains AI Assistant)
- Core: Fix OpenAI-compatible APIs (e.g. One API) returning 400 errors in multi-turn conversations when the server returns `reasoning_content` by default — `reasoning_effort` is now auto-set to `"medium"` when history contains thinking content and `reasoning_key` is configured
- Shell: Add `/theme` command and dark/light theme support — users with light terminal backgrounds can now switch to a light color palette via `/theme light` or `theme = "light"` in `config.toml`; diff highlights, task browser, prompt UI, and MCP status colors all adapt to the selected theme
- Core: Fix context overflow before compaction — tool result tokens are now estimated and included in the auto-compaction trigger check, preventing "exceeded model token limit" errors when large tool outputs push the context beyond the model limit between API calls
- Core: Add hooks system (Beta) — configure `[[hooks]]` in `config.toml` to run custom shell commands at 13 lifecycle events including `PreToolUse`, `PostToolUse`, `SessionStart`, `Stop`, etc.; supports regex matching, timeout handling, and blocking operations via exit code 2
- Shell: Add `/hooks` command — list all configured hooks with event counts
- Wire: Add `HookTriggered` and `HookResolved` event types (Wire 1.7) — notify clients when hooks start and finish executing, including event type, target, action (allow/block), and duration
- Wire: Add `HookRequest` and `HookResponse` message types — allow wire clients to subscribe to hook events and provide their own handling logic with allow/block decisions
- CLI: `--skills-dir` now supports multiple directories and overrides default discovery — when specified, the directories replace user/project skills discovery (repeatable flag)
- Shell: Fix notification messages leaking into session replay and export — background task notification tags (`<notification>`, `<task-notification>`) are now filtered out when resuming a session (`/sessions`) and when exporting (`/export`) or importing (`/import`) conversation history
- Web: The "Open" button in the workspace header now remembers the last-used application — clicking "Open" directly opens with the previous choice, while the dropdown arrow lets you pick a different app
- Web: Fix archived sessions count badge showing only the loaded page size — the badge now displays "100+" when more archived sessions exist beyond the first page
- Shell: Fix pasted text placeholders not expanded in modal answers — clipboard content pasted into approval or question panels is now correctly interpolated before being sent to the model
- Vis: Add `--network / -n` flag — launch the visualizer on all network interfaces with auto-detected LAN IP display, matching `kimi web` behavior
- Vis: Add `/vis` slash command — switch from the interactive shell to the tracing visualizer in one step, mirroring the existing `/web` command
- Vis: Improve session list performance — async backend scanning, request concurrency limiting, and infinite-scroll pagination prevent browser freezes on large session stores
- Vis: Add 7 missing wire event types — `SteerInput`, `MCPLoadingBegin/End`, `Notification`, `PlanDisplay`, `ToolCallRequest`, and `QuestionRequest` now display with proper colors and summaries
- Vis: Show token and cache details in StatusUpdate — each status update now displays context token count, max tokens, input token breakdown with cache hit rate, and MCP connection status
- Vis: Show structured tool call summaries — `ReadFile`, `Shell`, `Glob`, `Grep`, `Agent`, and other tool calls display file paths, commands, or patterns inline instead of just the function name
- Vis: Add System Prompt card in Context Messages — the `_system_prompt` entry is rendered as a dedicated blue card showing estimated token count and expandable full content
- Vis: Show cache hit rate in session header — the stats bar now displays overall cache efficiency (e.g., `89% cache`) alongside token counts
- Vis: Highlight slow operations — time deltas exceeding 10 s appear in amber and those exceeding 60 s in red, making performance bottlenecks immediately visible
- Vis: Prefer human-readable `message` field in ToolResult summaries — results now show descriptive text like "Command executed successfully" instead of raw output
- Vis: Show approval rejection feedback — `ApprovalResponse` summaries include the user's correction text when a tool call is rejected

## 1.27.0 (2026-03-28)

- Shell: Add `/feedback` command — submit feedback directly from the CLI session; the command falls back to opening GitHub Issues on network errors or timeouts
- Shell: Redesign diff rendering for tool results — file diffs now display with line numbers, background colors (green/red), syntax highlighting, and inline word-level change markers; approval previews show only changed lines for a compact view; Ctrl-E pager uses the same unified style
- Shell: Update syntax highlighting theme — replace the magenta-heavy color scheme with a more balanced palette mapped to ANSI colors for terminal compatibility; improved color diversity and readability across dark and light terminal backgrounds
- Shell: Fix approval panel not visible when multiple subagents are running — approval and question panels are now rendered at the top of the live view, ensuring they remain visible even when tool-call output exceeds the terminal height
- CLI: Fix `--print` mode returning exit code 0 on errors — print mode now exits with code 1 for permanent failures (auth errors, invalid config, etc.) and code 75 for retryable failures (429 rate limit, 5xx server errors, connection timeouts), enabling CI/eval runners to detect failures and decide whether to retry
- Plan: Display plan content inline in the chat instead of hiding behind a pager — plans are now rendered as a bordered panel directly in the conversation history, with the plan file path shown for reference
- Plan: Add "Reject and Exit" option to plan approval — users can now reject a plan and exit plan mode in one step, in addition to the existing Approve, Revise, and Reject options
- Wire: Add `PlanDisplay` event type (Wire 1.7) — carries plan content and file path for inline rendering by clients
- Shell: Stream markdown output incrementally — completed markdown blocks (paragraphs, lists, code fences, tables) are now rendered and printed to the terminal as they arrive during streaming, instead of being buffered until the turn ends
- Shell: Show elapsed time and estimated token count on thinking/composing spinners — the spinner now displays `Thinking... 5s · 312 tokens` with a live-updating counter during generation
- Shell: Add scrolling preview for thinking content — the last 6 lines of the model's thinking process are shown in real time as a grey italic preview beneath the spinner
- Shell: Reduce prompt input area reserved space from 10 to 6 lines
- Glob: Allow `Glob` tool to access skills directories — the tool can now search within discovered skill roots in addition to the workspace
- Glob: Expand `~` in directory path before validation — the Glob tool now resolves the tilde to the user's home directory before checking path validity

## 1.26.0 (2026-03-25)

- Kosong: Fix Google GenAI provider sending `id` in `FunctionCall`/`FunctionResponse` parts — Gemini API returns HTTP 400 when `id` is included; remove the field from wire format while keeping internal `tool_call_id` tracking unchanged
- Core: Fix MCP server stderr pollution — stderr redirection is now installed before MCP servers start, so subprocess logs (e.g., OAuth debug output from `mcp-remote`) are captured into the log file instead of being printed to the terminal
- Shell: Fix subprocess hang on interactive prompts — the `Shell` tool now closes stdin immediately and sets `GIT_TERMINAL_PROMPT=0` so commands that require credentials (e.g. `git push` over HTTPS) fail fast instead of blocking until timeout
- Core: Fix JSON parsing error when LLM tool call arguments contain unescaped control characters — use `json.loads(strict=False)` across all LLM output parsing paths to prevent tool execution failure and session corruption
- Shell: Auto-trigger agent when background tasks complete while idle — the shell now detects when a background bash command or agent task finishes and automatically starts a new agent turn to process the results, instead of waiting for the user to type something
- Core: Fix `QuestionRequest` hanging in print mode — `AskUserQuestion`, `EnterPlanMode`, and `ExitPlanMode` now auto-resolve when running in non-interactive (yolo) mode, preventing indefinite tool call hangs in `--print` sessions
- Core: Fix background agent task output not visible until completion — `/task` browser and `TaskOutput` tool now show real-time output while background agent tasks are running, by tee-writing to the task log during execution instead of copying on completion
- Core: Strengthen system prompt to encourage tool use for coding tasks — the agent now defaults to taking action with tools instead of outputting code as plain text
- Core: Retry `httpx.ProtocolError` and `504 Gateway Timeout` during generation — streaming protocol disconnects and transient 504 responses now follow the existing retry path instead of aborting the turn immediately on unstable networks
- Kosong: Fix `httpx.ReadTimeout` leaking through Anthropic provider during streaming — the exception now correctly converts to `APITimeoutError`, enabling retry logic that was previously bypassed

## 1.25.0 (2026-03-23)

- Core: Add plugin system (Skills + Tools) — plugins extend Kimi Code CLI with custom tools packaged as `plugin.json`; tools are commands that run in isolated subprocesses and return their stdout to the agent; plugins support automatic credential injection via `inject` configuration
- Core: Support multi-plugin repositories — `kimi plugin install` accepts git URLs with subpath to install a specific plugin from a monorepo (e.g., `https://github.com/org/repo.git/plugins/my-plugin`); when no subpath is provided and no root `plugin.json` exists, the CLI lists available plugins in immediate subdirectories
- Core: Unify plugin credential injection — plugins can declare `inject` fields in `plugin.json` to receive `api_key` and `base_url` from the host's configured LLM provider; works with both OAuth-managed tokens and static API keys
- Core: Add `Agent` tool for subagent delegation — the agent can now spawn persistent subagent instances with three built-in types (`coder`, `explore`, `plan`) to handle focused subtasks; each instance maintains its own context history within the session and can run in foreground or background with automatic result summarization
- Core: Unified approval runtime — approval requests from both foreground tool calls and background subagents are now coordinated through a single runtime and surfaced through the root UI channel; rejection responses can include feedback text to guide the model's next attempt
- Shell: Add interactive approval request panel — a new inline panel displays tool call details (diffs, shell commands) with options to approve once, approve for session, reject, or reject with written feedback to instruct the model on what to do instead
- Wire: Bump protocol version to 1.6 — `SubagentEvent` now includes `agent_id`, `subagent_type`, and `parent_tool_call_id` fields; `ApprovalRequest` includes source metadata (`source_kind`, `source_id`); `ApprovalResponse` supports a `feedback` field
- Vis: Add agents panel — new "Agents" tab in `kimi vis` to inspect subagent instances, view their events, and filter the wire timeline by agent scope
- Core: Change `TaskOutput` `block` parameter default from `true` to `false` — `TaskOutput` now returns a non-blocking status/output snapshot by default; set `block=true` only when you intentionally want to wait for task completion
- Shell: Show the current working directory, git branch, dirty state, and ahead/behind sync status directly in the prompt toolbar
- Shell: Surface active background bash task counts in the toolbar, rotate shortcut tips on a timer, and gracefully truncate the toolbar on narrow terminals to avoid overflow
- Web: Fix tool execution status synchronization on cancel and approval — tools now correctly transition to `output-denied` state when generation is stopped, and show the loading spinner (instead of checkmark) while executing after approval
- Web: Dismiss stale approval and question dialogs on session replay — when replaying a session or when the backend reports idle/stopped/error status, any pending approval/question dialogs are now properly dismissed to prevent orphaned interactive elements
- Web: Enable inline math formula rendering — single-dollar inline math (`$...$`) is now supported in addition to block math (`$$...$$`)
- Web: Improve Switch toggle proportions and alignment — the toggle track is now larger (36×20) with a consistent 16px thumb and smoother 16px travel animation
- Web: Show subagent type labels in activity panels — subagent activities now display their type (e.g. "Coder agent working") instead of the generic "Agent" label
- Web: Add feedback mode to approval dialog — press `4` to reject with written feedback text that guides the model's next attempt; approval requests from subagents show a source label and preview content (diffs, commands)
- Web: Visually distinguish sub-agent origin tool calls — tool messages originating from a subagent are rendered with a left border and a source type label for clearer attribution

## 1.24.0 (2026-03-18)

- Shell: Increase pasted text placeholder thresholds to 1000 characters or 15 lines (previously 300 characters or 3 lines), making voice/typeless workflows less disruptive
- Core: Plan mode now supports multiple selectable approach options — when the agent's plan contains distinct alternative paths, `ExitPlanMode` can present 2–3 labeled choices for the user to pick which approach to execute; the chosen option is returned to the agent as the selected approach
- Core: Persist plan session ID and file path across process restarts — the plan session identifier and file slug are saved to `SessionState`, so restarting Kimi Code mid-plan resumes the same plan file in `~/.kimi/plans/` instead of creating a new one
- Core: Plan mode now supports incremental plan edits — the agent can use `StrReplaceFile` to surgically update sections of the plan file instead of rewriting the entire file with `WriteFile`, and non-plan file edits are now hard-blocked rather than requiring approval
- Core: Defer MCP startup and surface loading progress — MCP servers now initialize asynchronously after the shell UI starts, with live progress indicators showing connection status; Shell displays connecting and ready states in the status area, Web shows server connection status
- Core: Optimize lightweight startup paths — implement lazy-loading for CLI subcommands and version metadata, significantly reducing startup time for common commands like `--version` and `--help`
- Build: Fix Nix `FileCollisionError` for `bin/kimi` — remove duplicate entry point from `kimi-code` package so `kimi-cli` owns `bin/kimi` exclusively
- Shell: Preserve unsubmitted input across agent turns — text typed in the prompt while the agent is running is no longer lost when the turn ends; the user can press Enter to submit the draft as the next message
- Shell: Fix Ctrl-C and Ctrl-D not working correctly after an agent run completes — keyboard interrupts and EOF were silently swallowed instead of showing the tip or exiting the shell

## 1.23.0 (2026-03-17)

- Shell: Add background bash — the `Shell` tool now accepts `run_in_background=true` to launch long-running commands (builds, tests, servers) as background tasks, freeing the agent to continue working; new `TaskList`, `TaskOutput`, and `TaskStop` tools manage task lifecycle, and the system automatically notifies the agent when tasks reach a terminal state
- Shell: Add `/task` slash command with interactive task browser — a three-column TUI to view, monitor, and manage background tasks with real-time refresh, output preview, and keyboard-driven stopping
- Web: Fix global config not refreshing on other tabs when model is changed — when the model is changed in one tab, other tabs now detect the config update and automatically refresh their global config

## 1.22.0 (2026-03-13)

- Shell: Collapse long pasted text into `[Pasted text #n]` placeholders — text pasted via `Ctrl-V` or bracketed paste that exceeds 300 characters or 3 lines is displayed as a compact placeholder token in the prompt buffer while the full content is sent to the model; the external editor (`Ctrl-O`) expands placeholders for editing and re-folds them on save
- Shell: Cache pasted images as attachment placeholders — images pasted from the clipboard are stored on disk and shown as `[image:…]` tokens in the prompt, keeping the input buffer readable
- Shell: Fix UTF-16 surrogate characters in pasted text causing serialization errors — lone surrogates from Windows clipboard data are now sanitized before storage, preventing `UnicodeEncodeError` in history writes and JSON serialization
- Shell: Redesign slash command completion menu — replace the default completion popup with a full-width custom menu that shows command names and multi-line descriptions, with highlight and scroll support
- Shell: Fix cancelled shell commands not properly terminating child processes — when a running command is cancelled, the subprocess is now explicitly killed to prevent orphaned processes

## 1.21.0 (2026-03-12)

- Shell: Add inline running prompt with steer input — agent output is now rendered inside the prompt area while the model is running, and users can type and send follow-up messages (steers) without waiting for the turn to finish; approval requests and question panels are handled inline with keyboard navigation
- Core: Change steer injection from synthetic tool calls to regular user messages — steer content is now appended as a standard user message instead of a fake `_steer` tool-call/tool-result pair, improving compatibility with context serialization and visualization
- Wire: Add `SteerInput` event — a new Wire protocol event emitted when the user sends a follow-up steer message during a running turn
- Shell: Echo user input after submission in agent mode — the prompt symbol and entered text are printed back to the terminal for a clearer conversation transcript
- Shell: Improve session replay with steer inputs — replay now correctly reconstructs and displays steer messages alongside regular turns, and filters out internal system-reminder messages
- Shell: Fix upgrade command in toast notifications — the upgrade command text is now sourced from a single `UPGRADE_COMMAND` constant for consistency
- Core: Persist system prompt in `context.jsonl` — the system prompt is now written as the first record of the context file and frozen per session, so visualization tools can read the full conversation context and session restores reuse the original prompt instead of regenerating it
- Vis: Add session directory shortcuts in `kimi vis` — open the current session folder directly from the session page, copy the raw session directory path with `Copy DIR`, and support opening directories on both macOS and Windows
- Shell: Improve API key login UX — show a spinner during key verification, display a helpful hint when a 401 error suggests the wrong platform was selected, show a setup summary on success, and default thinking mode to "on"

## 1.20.0 (2026-03-11)

- Web: Add plan mode toggle in web UI — switch control in the input toolbar with a dashed blue border on the composer when plan mode is active, and support setting plan mode via the `set_plan_mode` Wire protocol method
- Core: Persist plan mode state across session restarts — `plan_mode` is saved to `SessionState` and restored when a session resumes
- Core: Fix StatusUpdate not reflecting plan mode changes triggered by tools — send a corrected `StatusUpdate` after `EnterPlanMode`/`ExitPlanMode` tool execution so the client sees the up-to-date state
- Core: Fix HTTP header values containing trailing whitespace/newlines on certain Linux systems (e.g. kernel 6.8.0-101) causing connection errors — strip whitespace from ASCII header values before sending
- Core: Fix OpenAI Responses provider sending implicit `reasoning.effort=null` which breaks Responses-compatible endpoints that require reasoning — reasoning parameters are now omitted unless explicitly set
- Vis: Add session download, import, export and delete — one-click ZIP download from session explorer and detail page, ZIP import into a dedicated `~/.kimi/imported_sessions/` directory with "Imported" filter toggle, `kimi export <session_id>` CLI command, and delete support for imported sessions with AlertDialog confirmation
- Core: Fix context compaction failing when conversation contains media parts (images, audio, video) — switch from blacklist filtering (exclude `ThinkPart`) to whitelist filtering (only keep `TextPart`) to prevent unsupported content types from being sent to the compaction API
- Web: Fix `@` file mention index not refreshing after switching sessions or when workspace files change — reset index on session switch, auto-refresh after 30s staleness, and support path-prefix search beyond the 500-file limit

## 1.19.0 (2026-03-10)

- Core: Add plan mode — the agent can enter a planning phase (`EnterPlanMode`) where only read-only tools (Glob, Grep, ReadFile) are available, write a structured plan to a file, and present it for user approval (`ExitPlanMode`) before executing; toggle manually via `/plan` slash command or `Shift-Tab` keyboard shortcut
- Vis: Add `kimi vis` command for launching an interactive visualization dashboard to inspect session traces — includes wire event timeline, context viewer, session explorer, and usage statistics
- Web: Fix session stream state management — guard against null reference errors during state resets and preserve slash commands across session switches to avoid a brief empty gap

## 1.18.0 (2026-03-09)

- ACP: Support embedded resource content in ACP mode so that Zed's `@` file references correctly include file contents
- Core: Use `parameters_json_schema` instead of `parameters` in Google GenAI provider to bypass Pydantic validation that rejects standard JSON Schema metadata fields in MCP tools
- Shell: Enhance `Ctrl-V` clipboard paste to support video files in addition to images — video file paths are inserted as text, and a crash when clipboard data is `None` is fixed
- Core: Pass session ID as `user_id` metadata to Anthropic API
- Web: Preserve slash commands on WebSocket reconnect and add automatic retry logic for session initialization

## 1.17.0 (2026-03-03)

- Core: Add `/export` command to export current session context (messages, metadata) to a Markdown file, and `/import` command to import context from a file or another session ID into the current session
- Shell: Show token counts (used/total) alongside context usage percentage in the status bar (e.g., `context: 42.0% (4.2k/10.0k)`)
- Shell: Rotate keyboard shortcut tips in the toolbar — tips cycle through available shortcuts on each prompt submission to save horizontal space
- MCP: Add loading indicators for MCP server connections — Shell displays a "Connecting to MCP servers..." spinner and Web shows a status message while MCP tools are being loaded
- Web: Fix scrollable file list overflow in the toolbar changes panel
- Core: Add `compaction_trigger_ratio` config option (default `0.85`) to control when auto-compaction triggers — compaction now fires when context usage reaches the configured ratio or when remaining space falls below `reserved_context_size`, whichever comes first
- Core: Support custom instructions in `/compact` command (e.g., `/compact keep database discussions`) to guide what the compaction preserves
- Web: Add URL action parameters (`?action=create` to open create-session dialog, `?action=create-in-dir&workDir=xxx` to create a session directly) for external integrations, and support Cmd/Ctrl+Click on new-session buttons to open session creation in a new browser tab
- Web: Add todo list display in prompt toolbar — shows task progress with expandable panel when the `SetTodoList` tool is active
- ACP: Add authentication check for session operations with `AUTH_REQUIRED` error responses for terminal-based login flow

## 1.16.0 (2026-02-27)

- Web: Update ASCII logo banner to a new styled design
- Core: Add `--add-dir` CLI option and `/add-dir` slash command to expand the workspace scope with additional directories — added directories are accessible to all file tools (read, write, glob, replace), persisted across sessions, and shown in the system prompt
- Shell: Add `Ctrl-O` keyboard shortcut to open the current input in an external editor (`$VISUAL`/`$EDITOR`), with auto-detection fallback to VS Code, Vim, Vi, or Nano
- Shell: Add `/editor` slash command to configure and switch the default external editor, with interactive selection and persistent config storage
- Shell: Add `/new` slash command to create and switch to a new session without restarting Kimi Code CLI
- Wire: Auto-hide `AskUserQuestion` tool when the client does not support the `supports_question` capability, preventing the LLM from invoking unsupported interactions
- Core: Estimate context token count after compaction so context usage percentage is not reported as 0%
- Web: Show context usage percentage with one decimal place for better precision

## 1.15.0 (2026-02-27)

- Shell: Simplify input prompt by removing username prefix for a cleaner appearance
- Shell: Add horizontal separator line and expanded keyboard shortcut hints to the toolbar
- Shell: Add number key shortcuts (1–5) for quick option selection in question and approval panels, with redesigned bordered panel UI and keyboard hints
- Shell: Add tab-style navigation for multi-question panels — use Left/Right arrows or Tab to switch between questions, with visual indicators for answered, current, and pending states, and automatic state restoration when revisiting a question
- Shell: Allow Space key to submit single-select questions in the question panel
- Web: Add tab-style navigation for multi-question dialogs with clickable tab bar, keyboard navigation, and state restoration when revisiting a question
- Core: Set process title to "Kimi Code" (visible in `ps` / Activity Monitor / terminal tab title) and label web worker subprocesses as "kimi-code-worker"

## 1.14.0 (2026-02-26)

- Shell: Make FetchURL tool's URL parameter a clickable hyperlink in the terminal
- Tool: Add `AskUserQuestion` tool for presenting structured questions with predefined options during execution, supporting single-select, multi-select, and custom text input
- Wire: Add `QuestionRequest` / `QuestionResponse` message types and capability negotiation for structured question interactions
- Shell: Add interactive question panel for `AskUserQuestion` with keyboard-driven option selection
- Web: Add `QuestionDialog` component for answering structured questions inline, replacing the prompt composer when a question is pending
- Core: Persist session state across sessions — approval decisions (YOLO mode, auto-approved actions) and dynamic subagents are now saved and restored when resuming a session
- Core: Use atomic JSON writes for metadata and session state files to prevent data corruption on crash
- Wire: Add `steer` request to inject user messages into an active agent turn (protocol version 1.4)
- Web: Allow Cmd/Ctrl+Click on FetchURL tool's URL parameter to open the link in a new browser tab, with platform-appropriate tooltip hint

## 1.13.0 (2026-02-24)

- Core: Add automatic connection recovery that recreates the HTTP client on connection and timeout errors before retrying, improving resilience against transient network failures

## 1.12.0 (2026-02-11)

- Web: Add subagent activity rendering to display subagent steps (thinking, tool calls, text) inside Task tool messages
- Web: Add Think tool rendering as a lightweight reasoning-style block
- Web: Replace emoji status indicators with Lucide icons for tool states and add category-specific icons for tool names
- Web: Enhance Reasoning component with improved thinking labels and status icons
- Web: Enhance Todo component with status icons and improved styling
- Web: Implement WebSocket reconnection with automatic request resending and stale connection watchdog
- Web: Enhance session creation dialog with command value handling
- Web: Support tilde (`~`) expansion in session work directory paths
- Web: Fix assistant message content overflow clipping
- Wire: Fix deadlock when multiple subagents run concurrently by not blocking the UI loop on approval and tool-call requests
- Wire: Clean up stale pending requests after agent turn ends
- Web: Show placeholder text in prompt input with hints for slash commands and file mentions
- Web: Fix Ctrl+C not working in uvicorn web server by restoring default SIGINT handler and terminal state after shell mode exits
- Web: Improve session stop handling with proper async cleanup and timeout
- ACP: Add protocol version negotiation framework for client-server compatibility
- ACP: Add session resume method to restore session state (experimental)

## 1.11.0 (2026-02-10)

- Web: Move context usage indicator from workspace header to prompt toolbar with a hover card showing detailed token usage breakdown
- Web: Add folder indicator with work directory path to the bottom of the file changes panel
- Web: Fix stderr not being restored when switching to web mode, which could suppress web server error output
- Web: Fix port availability check by setting SO_REUSEADDR on the test socket

## 1.10.0 (2026-02-09)

- Web: Add copy and fork action buttons to assistant messages for quick content copying and session forking
- Web: Add keyboard shortcuts for approval actions — press `1` to approve, `2` to approve for session, `3` to decline
- Web: Add message queueing — queue follow-up messages while the AI is processing; queued messages are sent automatically when the response completes
- Web: Replace Git diff status bar with unified prompt toolbar showing activity status, message queue, and file changes in collapsible tabs
- Web: Load global MCP configuration in web worker so web sessions can use MCP tools
- Web: Improve mobile prompt input UX — reduce textarea min-height, add `autoComplete="off"`, and disable focus ring on small screens
- Web: Handle models that stream text before thinking by ensuring thinking messages always appear before text in the message list
- Web: Show more specific status messages during session connection ("Loading history...", "Starting environment..." instead of generic "Connecting...")
- Web: Send error status when session environment initialization fails instead of leaving UI in a waiting state
- Web: Auto-reconnect when no session status received within 15 seconds after history replay completes
- Web: Use non-blocking file I/O in session streaming to avoid blocking the event loop during history replay

## 1.9.0 (2026-02-06)

- Config: Add `default_yolo` config option to enable YOLO (auto-approve) mode by default
- Config: Accept both `max_steps_per_turn` and `max_steps_per_run` as aliases for the loop control setting
- Wire: Add `replay` request to stream recorded Wire events (protocol version 1.3)
- Web: Add session fork feature to branch off a new session from any assistant response
- Web: Add session archive feature with auto-archive for sessions older than 15 days
- Web: Add multi-select mode for bulk archive, unarchive, and delete operations
- Web: Add media preview for tool results (images/videos from ReadMediaFile) with clickable thumbnails
- Web: Add shell command and todo list display components for tool outputs
- Web: Add activity status indicator showing agent state (processing, waiting for approval, etc.)
- Web: Add error fallback UI when images fail to load
- Web: Redesign tool input UI with expandable parameters and syntax highlighting for long values
- Web: Show compaction indicator when context is being compacted
- Web: Improve auto-scroll behavior in chat for smoother following of new content
- Web: Update `last_session_id` for work directory when session stream starts
- Shell: Remove `Ctrl-/` keyboard shortcut that triggered `/help` command
- Rust: Move the Rust implementation to `MoonshotAI/kimi-agent-rs` with independent releases; binary renamed to `kimi-agent`
- Core: Preserve session id when reloading configuration so the session resumes correctly
- Shell: Fix session replay showing messages that were cleared by `/clear` or `/reset`
- Web: Fix approval request states not updating when session is interrupted or cancelled
- Web: Fix IME composition issue when selecting slash commands
- Web: Fix UI not clearing messages after `/clear`, `/reset`, or `/compact` commands

## 1.8.0 (2026-02-05)

- CLI: Fix startup errors (e.g. invalid config files) being silently swallowed instead of displayed

## 1.7.0 (2026-02-05)

- Rust: Add `kagent`, the Rust implementation of Kimi agent kernel with wire-mode support (experimental)
- Auth: Fix OAuth token refresh conflicts when running multiple sessions simultaneously
- Web: Add file mention menu (`@`) to reference uploaded attachments and workspace files with autocomplete
- Web: Add slash command menu in chat input with autocomplete, keyboard navigation, and alias support
- Web: Prompt to create directory when specified path doesn't exist during session creation
- Web: Fix authentication token persistence by switching from sessionStorage to localStorage with 24-hour expiry
- Web: Add server-side pagination for session list with virtualized scrolling for better performance
- Web: Improve session and work directories loading with smarter caching and invalidation
- Web: Fix WebSocket errors during history replay by checking connection state before sending
- Web: Git diff status bar now shows untracked files (new files not yet added to git)
- Web: Restrict sensitive APIs only in public mode; update origin enforcement logic

## 1.6 (2026-02-03)

- Web: Add token-based authentication and access control for network mode (`--network`, `--lan-only`, `--public`)
- Web: Add security options: `--auth-token`, `--allowed-origins`, `--restrict-sensitive-apis`, `--dangerously-omit-auth`
- Web: Change `--host` option to bind to specific IP address; add automatic network address detection
- Web: Fix WebSocket disconnect when creating new sessions
- Web: Increase maximum image dimension from 1024 to 4096 pixels
- Web: Improve UI responsiveness with enhanced hover effects and better layout handling
- Wire: Add `TurnEnd` event to signal the completion of an agent turn (protocol version 1.2)
- Core: Fix custom agent prompt files containing `$` causing silent startup failure

## 1.5 (2026-01-30)

- Web: Add Git diff status bar showing uncommitted changes in session working directory
- Web: Add "Open in" menu for opening files/directories in Terminal, VS Code, Cursor, or other local applications
- Web: Add search functionality to filter sessions by title or working directory
- Web: Improve session title display with proper overflow handling

## 1.4 (2026-01-30)

- Shell: Merge `/login` and `/setup` commands; `/setup` is now an alias for `/login`
- Shell: `/usage` now shows remaining quota percentage; add `/status` alias
- Config: Add `KIMI_SHARE_DIR` environment variable to customize the share directory path (default: `~/.kimi`)
- Web: Add new Web UI for browser-based interaction
- CLI: Add `kimi web` subcommand to launch the Web UI server
- Auth: Fix encoding error when device name or OS version contains non-ASCII characters
- Auth: OAuth credentials are now stored in files instead of keyring; existing tokens are automatically migrated on startup
- Auth: Fix authorization failure after the system sleeps or hibernates

## 1.3 (2026-01-28)

- Auth: Fix authentication issue during agent turns
- Tool: Wrap media content with descriptive tags in `ReadMediaFile` for better path traceability

## 1.2 (2026-01-27)

- UI: Show description for `kimi-for-coding` model

## 1.1 (2026-01-27)

- LLM: Fix `kimi-for-coding` model's capabilities

## 1.0 (2026-01-27)

- Shell: Add `/login` and `/logout` slash commands for login and logout
- CLI: Add `kimi login` and `kimi logout` subcommands
- Core: Fix subagent approval request handling

## 0.88 (2026-01-26)

- MCP: Remove `Mcp-Session-Id` header when connecting to MCP servers to fix compatibility

## 0.87 (2026-01-25)

- Shell: Fix Markdown rendering error when HTML blocks appear outside any element
- Skills: Add more user-level and project-level skills directory candidates
- Core: Improve system prompt guidance for media file generation and processing tasks
- Shell: Fix image pasting from clipboard on macOS

## 0.86 (2026-01-24)

- Build: Fix binary builds

## 0.85 (2026-01-24)

- Shell: Cache pasted images to disk for persistence across sessions
- Shell: Deduplicate cached attachments based on content hash
- Shell: Fix display of image/audio/video attachments in message history
- Tool: Use file path as media identifier in `ReadMediaFile` for better traceability
- Tool: Fix some MP4 files not being recognized as videos
- Shell: Handle Ctrl-C during slash command execution
- Shell: Fix shlex parsing error in shell mode when input contains invalid shell syntax
- Shell: Fix stderr output from MCP servers and third-party libraries polluting shell UI
- Wire: Graceful shutdown with proper cleanup of pending requests when connection closes or Ctrl-C is received

## 0.84 (2026-01-22)

- Build: Add cross-platform standalone binary builds for Windows, macOS (with code signing and notarization), and Linux (x86_64 and ARM64)
- Shell: Fix slash command autocomplete showing suggestions for exact command/alias matches
- Tool: Treat SVG files as text instead of images
- Flow: Support D2 markdown block strings (`|md` syntax) for multiline node labels in flow skills
- Core: Fix possible "event loop is closed" error after running `/reload`, `/setup`, or `/clear`
- Core: Fix panic when `/clear` is used in a continued session

## 0.83 (2026-01-21)

- Tool: Add `ReadMediaFile` tool for reading image/video files; `ReadFile` now focuses on text files only
- Skills: Flow skills now also register as `/skill:<skill-name>` commands (in addition to `/flow:<skill-name>`)

## 0.82 (2026-01-21)

- Tool: Allow `WriteFile` and `StrReplaceFile` tools to edit/write files outside the working directory when using absolute paths
- Tool: Upload videos to Kimi files API when using Kimi provider, replacing inline data URLs with `ms://` references
- Config: Add `reserved_context_size` setting to customize auto-compaction trigger threshold (default: 50000 tokens)

## 0.81 (2026-01-21)

- Skills: Add flow skill type with embedded Agent Flow (Mermaid/D2) in SKILL.md, invoked via `/flow:<skill-name>` commands
- CLI: Remove `--prompt-flow` option; use flow skills instead
- Core: Replace `/begin` command with `/flow:<skill-name>` commands for flow skills

## 0.80 (2026-01-20)

- Wire: Add `initialize` method for exchanging client/server info, external tools registration and slash commands advertisement
- Wire: Support external tool calls via Wire protocol
- Wire: Rename `ApprovalRequestResolved` to `ApprovalResponse` (backwards-compatible)

## 0.79 (2026-01-19)

- Skills: Add project-level skills support, discovered from `.agents/skills/` (or `.kimi/skills/`, `.claude/skills/`)
- Skills: Unified skills discovery with layered loading (builtin → user → project); user-level skills now prefer `~/.config/agents/skills/`
- Shell: Support fuzzy matching for slash command autocomplete
- Shell: Enhanced approval request preview with shell command and diff content display, use `Ctrl-E` to expand full content
- Wire: Add `ShellDisplayBlock` type for shell command display in approval requests
- Shell: Reorder `/help` to show keyboard shortcuts before slash commands
- Wire: Return proper JSON-RPC 2.0 error responses for invalid requests

## 0.78 (2026-01-16)

- CLI: Add D2 flowchart format support for Prompt Flow (`.d2` extension)

## 0.77 (2026-01-15)

- Shell: Fix line breaking in `/help` and `/changelog` fullscreen pager display
- Shell: Use `/model` to toggle thinking mode instead of Tab key
- Config: Add `default_thinking` config option (need to run `/model` to select thinking mode after upgrade)
- LLM: Add `always_thinking` capability for models that always use thinking mode
- CLI: Rename `--command`/`-c` to `--prompt`/`-p`, keep `--command`/`-c` as alias, remove `--query`/`-q`
- Wire: Fix approval requests not responding properly in Wire mode
- CLI: Add `--prompt-flow` option to load a Mermaid flowchart file as a Prompt Flow
- Core: Add `/begin` slash command if a Prompt Flow is loaded to start the flow
- Core: Replace Ralph Loop with Prompt Flow-based implementation

## 0.76 (2026-01-12)

- Tool: Make `ReadFile` tool description reflect model capabilities for image/video support
- Tool: Fix TypeScript files (`.ts`, `.tsx`, `.mts`, `.cts`) being misidentified as video files
- Shell: Allow slash commands (`/help`, `/exit`, `/version`, `/changelog`, `/feedback`) in shell mode
- Shell: Improve `/help` with fullscreen pager, showing slash commands, skills, and keyboard shortcuts
- Shell: Improve `/changelog` and `/mcp` display with consistent bullet-style formatting
- Shell: Show current model name in the bottom status bar
- Shell: Add `Ctrl-/` shortcut to show help

## 0.75 (2026-01-09)

- Tool: Improve `ReadFile` tool description
- Skills: Add built-in `kimi-cli-help` skill to answer Kimi Code CLI usage and configuration questions

## 0.74 (2026-01-09)

- ACP: Allow ACP clients to select and switch models (with thinking variants)
- ACP: Add `terminal-auth` authentication method for setup flow
- CLI: Deprecate `--acp` option in favor of `kimi acp` subcommand
- Tool: Support reading image and video files in `ReadFile` tool

## 0.73 (2026-01-09)

- Skills: Add built-in skill-creator skill shipped with the package
- Tool: Expand `~` to the home directory in `ReadFile` paths
- MCP: Ensure MCP tools finish loading before starting the agent loop
- Wire: Fix Wire mode failing to accept valid `cancel` requests
- Setup: Allow `/model` to switch between all available models for the selected provider
- Lib: Re-export all Wire message types from `kimi_cli.wire.types`, as a replacement of `kimi_cli.wire.message`
- Loop: Add `max_ralph_iterations` loop control config to limit extra Ralph iterations
- Config: Rename `max_steps_per_run` to `max_steps_per_turn` in loop control config (backward-compatible)
- CLI: Add `--max-steps-per-turn`, `--max-retries-per-step` and `--max-ralph-iterations` options to override loop control config
- SlashCmd: Make `/yolo` toggle auto-approve mode
- UI: Show a YOLO badge in the shell prompt

## 0.72 (2026-01-04)

- Python: Fix installation on Python 3.14.

## 0.71 (2026-01-04)

- ACP: Route file reads/writes and shell commands through ACP clients for synced edits/output
- Shell: Add `/model` slash command to switch default models and reload when using the default config
- Skills: Add `/skill:<name>` slash commands to load `SKILL.md` instructions on demand
- CLI: Add `kimi info` subcommand for version/protocol details (supports `--json`)
- CLI: Add `kimi term` to launch the Toad terminal UI
- Python: Bump the default tooling/CI version to 3.14

## 0.70 (2025-12-31)

- CLI: Add `--final-message-only` (and `--quiet` alias) to only output the final assistant message in print UI
- LLM: Add `video_in` model capability and support video inputs

## 0.69 (2025-12-29)

- Core: Support discovering skills in `~/.kimi/skills` or `~/.claude/skills`
- Python: Lower the minimum required Python version to 3.12
- Nix: Add flake packaging; install with `nix profile install .#kimi-cli` or run `nix run .#kimi-cli`
- CLI: Add `kimi-cli` script alias for invoking the CLI; can be run via `uvx kimi-cli`
- Lib: Move LLM config validation into `create_llm` and return `None` when missing config

## 0.68 (2025-12-24)

- CLI: Add `--config` and `--config-file` options to pass in config JSON/TOML
- Core: Allow `Config` in addition to `Path` for the `config` parameter of `KimiCLI.create`
- Tool: Include diff display blocks in `WriteFile` and `StrReplaceFile` approvals/results
- Wire: Add display blocks to approval requests (including diffs) with backward-compatible defaults
- ACP: Show file diff previews in tool results and approval prompts
- ACP: Connect to MCP servers managed by ACP clients
- ACP: Run shell commands in ACP client terminal if supported
- Lib: Add `KimiToolset.find` method to find tools by class or name
- Lib: Add `ToolResultBuilder.display` method to append display blocks to tool results
- MCP: Add `kimi mcp auth` and related subcommands to manage MCP authorization

## 0.67 (2025-12-22)

- ACP: Advertise slash commands in single-session ACP mode (`kimi --acp`)
- MCP: Add `mcp.client` config section to configure MCP tool call timeout and other future options
- Core: Improve default system prompt and `ReadFile` tool
- UI: Fix Ctrl-C not working in some rare cases

## 0.66 (2025-12-19)

- Lib: Provide `token_usage` and `message_id` in `StatusUpdate` Wire message
- Lib: Add `KimiToolset.load_tools` method to load tools with dependency injection
- Lib: Add `KimiToolset.load_mcp_tools` method to load MCP tools
- Lib: Move `MCPTool` from `kimi_cli.tools.mcp` to `kimi_cli.soul.toolset`
- Lib: Add `InvalidToolError`, `MCPConfigError` and `MCPRuntimeError`
- Lib: Make the detailed Kimi Code CLI exception classes extend `ValueError` or `RuntimeError`
- Lib: Allow passing validated `list[fastmcp.mcp_config.MCPConfig]` as `mcp_configs` for `KimiCLI.create` and `load_agent`
- Lib: Fix exception raising for `KimiCLI.create`, `load_agent`, `KimiToolset.load_tools` and `KimiToolset.load_mcp_tools`
- LLM: Add provider type `vertexai` to support Vertex AI
- LLM: Rename Gemini Developer API provider type from `google_genai` to `gemini`
- Config: Migrate config file from JSON to TOML
- MCP: Connect to MCP servers in background and parallel to reduce startup time
- MCP: Add `mcp-session-id` HTTP header when connecting to MCP servers
- Lib: Split slash commands (prev "meta commands") into two groups: Shell-level and KimiSoul-level
- Lib: Add `available_slash_commands` property to `Soul` protocol
- ACP: Advertise slash commands `/init`, `/compact` and `/yolo` to ACP clients
- SlashCmd: Add `/mcp` slash command to display MCP server and tool status

## 0.65 (2025-12-16)

- Lib: Support creating named sessions via `Session.create(work_dir, session_id)`
- CLI: Automatically create new session when specified session ID is not found
- CLI: Delete empty sessions on exit and ignore sessions whose context file is empty when listing
- UI: Improve session replaying
- Lib: Add `model_config: LLMModel | None` and `provider_config: LLMProvider | None` properties to `LLM` class
- MetaCmd: Add `/usage` meta command to show API usage for Kimi Code users

## 0.64 (2025-12-15)

- UI: Fix UTF-16 surrogate characters input on Windows
- Core: Add `/sessions` meta command to list existing sessions and switch to a selected one
- CLI: Add `--session/-S` option to specify session ID to resume
- MCP: Add `kimi mcp` subcommand group to manage global MCP config file `~/.kimi/mcp.json`

## 0.63 (2025-12-12)

- Tool: Fix `FetchURL` tool incorrect output when fetching via service fails
- Tool: Use `bash` instead of `sh` in `Shell` tool for better compatibility
- Tool: Fix `Grep` tool unicode decoding error on Windows
- ACP: Support ACP session continuation (list/load sessions) with `kimi acp` subcommand
- Lib: Add `Session.find` and `Session.list` static methods to find and list sessions
- ACP: Update agent plans on the client side when `SetTodoList` tool is called
- UI: Prevent normal messages starting with `/` from being treated as meta commands

## 0.62 (2025-12-08)

- ACP: Fix tool results (including Shell tool output) not being displayed in ACP clients like Zed
- ACP: Fix compatibility with the latest version of Zed IDE (0.215.3)
- Tool: Use PowerShell instead of CMD on Windows for better usability
- Core: Fix startup crash when there is broken symbolic link in the working directory
- Core: Add builtin `okabe` agent file with `SendDMail` tool enabled
- CLI: Add `--agent` option to specify builtin agents like `default` and `okabe`
- Core: Improve compaction logic to better preserve relevant information

## 0.61 (2025-12-04)

- Lib: Fix logging when used as a library
- Tool: Harden file path check to protect against shared-prefix escape
- LLM: Improve compatibility with some third-party OpenAI Responses and Anthropic API providers

## 0.60 (2025-12-01)

- LLM: Fix interleaved thinking for Kimi and OpenAI-compatible providers

## 0.59 (2025-11-28)

- Core: Move context file location to `.kimi/sessions/{workdir_md5}/{session_id}/context.jsonl`
- Lib: Move `WireMessage` type alias to `kimi_cli.wire.message`
- Lib: Add `kimi_cli.wire.message.Request` type alias request messages (which currently only includes `ApprovalRequest`)
- Lib: Add `kimi_cli.wire.message.is_event`, `is_request` and `is_wire_message` utility functions to check the type of wire messages
- Lib: Add `kimi_cli.wire.serde` module for serialization and deserialization of wire messages
- Lib: Change `StatusUpdate` Wire message to not using `kimi_cli.soul.StatusSnapshot`
- Core: Record Wire messages to a JSONL file in session directory
- Core: Introduce `TurnBegin` Wire message to mark the beginning of each agent turn
- UI: Print user input again with a panel in shell mode
- Lib: Add `Session.dir` property to get the session directory path
- UI: Improve "Approve for session" experience when there are multiple parallel subagents
- Wire: Reimplement Wire server mode (which is enabled with `--wire` option)
- Lib: Rename `ShellApp` to `Shell`, `PrintApp` to `Print`, `ACPServer` to `ACP` and `WireServer` to `WireOverStdio` for better consistency
- Lib: Rename `KimiCLI.run_shell_mode` to `run_shell`, `run_print_mode` to `run_print`, `run_acp_server` to `run_acp`, and `run_wire_server` to `run_wire_stdio` for better consistency
- Lib: Add `KimiCLI.run` method to run a turn with given user input and yield Wire messages
- Print: Fix stream-json print mode not flushing output properly
- LLM: Improve compatibility with some OpenAI and Anthropic API providers
- Core: Fix chat provider error after compaction when using Anthropic API

## 0.58 (2025-11-21)

- Core: Fix field inheritance of agent spec files when using `extend`
- Core: Support using MCP tools in subagents
- Tool: Add `CreateSubagent` tool to create subagents dynamically (not enabled in default agent)
- Tool: Use MoonshotFetch service in `FetchURL` tool for Kimi Code plan
- Tool: Truncate Grep tool output to avoid exceeding token limit

## 0.57 (2025-11-20)

- LLM: Fix Google GenAI provider when thinking toggle is not on
- UI: Improve approval request wordings
- Tool: Remove `PatchFile` tool
- Tool: Rename `Bash`/`CMD` tool to `Shell` tool
- Tool: Move `Task` tool to `kimi_cli.tools.multiagent` module

## 0.56 (2025-11-19)

- LLM: Add support for Google GenAI provider

## 0.55 (2025-11-18)

- Lib: Add `kimi_cli.app.enable_logging` function to enable logging when directly using `KimiCLI` class
- Core: Fix relative path resolution in agent spec files
- Core: Prevent from panic when LLM API connection failed
- Tool: Optimize `FetchURL` tool for better content extraction
- Tool: Increase MCP tool call timeout to 60 seconds
- Tool: Provide better error message in `Glob` tool when pattern is `**`
- ACP: Fix thinking content not displayed properly
- UI: Minor UI improvements in shell mode

## 0.54 (2025-11-13)

- Lib: Move `WireMessage` from `kimi_cli.wire.message` to `kimi_cli.wire`
- Print: Fix `stream-json` output format missing the last assistant message
- UI: Add warning when API key is overridden by `KIMI_API_KEY` environment variable
- UI: Make a bell sound when there's an approval request
- Core: Fix context compaction and clearing on Windows

## 0.53 (2025-11-12)

- UI: Remove unnecessary trailing spaces in console output
- Core: Throw error when there are unsupported message parts
- MetaCmd: Add `/yolo` meta command to enable YOLO mode after startup
- Tool: Add approval request for MCP tools
- Tool: Disable `Think` tool in default agent
- CLI: Restore thinking mode from last time when `--thinking` is not specified
- CLI: Fix `/reload` not working in binary packed by PyInstaller

## 0.52 (2025-11-10)

- CLI: Remove `--ui` option in favor of `--print`, `--acp`, and `--wire` flags (shell is still the default)
- CLI: More intuitive session continuation behavior
- Core: Add retry for LLM empty responses
- Tool: Change `Bash` tool to `CMD` tool on Windows
- UI: Fix completion after backspacing
- UI: Fix code block rendering issues on light background colors

## 0.51 (2025-11-08)

- Lib: Rename `Soul.model` to `Soul.model_name`
- Lib: Rename `LLMModelCapability` to `ModelCapability` and move to `kimi_cli.llm`
- Lib: Add `"thinking"` to `ModelCapability`
- Lib: Remove `LLM.supports_image_in` property
- Lib: Add required `Soul.model_capabilities` property
- Lib: Rename `KimiSoul.set_thinking_mode` to `KimiSoul.set_thinking`
- Lib: Add `KimiSoul.thinking` property
- UI: Better checks and notices for LLM model capabilities
- UI: Clear the screen for `/clear` meta command
- Tool: Support auto-downloading ripgrep on Windows
- CLI: Add `--thinking` option to start in thinking mode
- ACP: Support thinking content in ACP mode

## 0.50 (2025-11-07)

- Improve UI look and feel
- Improve Task tool observability

## 0.49 (2025-11-06)

- Minor UX improvements

## 0.48 (2025-11-06)

- Support Kimi K2 thinking mode

## 0.47 (2025-11-05)

- Fix Ctrl-W not working in some environments
- Do not load SearchWeb tool when the search service is not configured

## 0.46 (2025-11-03)

- Introduce Wire over stdio for local IPC (experimental, subject to change)
- Support Anthropic provider type

- Fix binary packed by PyInstaller not working due to wrong entrypoint

## 0.45 (2025-10-31)

- Allow `KIMI_MODEL_CAPABILITIES` environment variable to override model capabilities
- Add `--no-markdown` option to disable markdown rendering
- Support `openai_responses` LLM provider type

- Fix crash when continuing a session

## 0.44 (2025-10-30)

- Improve startup time

- Fix potential invalid bytes in user input

## 0.43 (2025-10-30)

- Basic Windows support (experimental)
- Display warnings when base URL or API key is overridden in environment variables
- Support image input if the LLM model supports it
- Replay recent context history when continuing a session

- Ensure new line after executing shell commands

## 0.42 (2025-10-28)

- Support Ctrl-J or Alt-Enter to insert a new line

- Change mode switch shortcut from Ctrl-K to Ctrl-X
- Improve overall robustness

- Fix ACP server `no attribute` error

## 0.41 (2025-10-26)

- Fix a bug for Glob tool when no matching files are found
- Ensure reading files with UTF-8 encoding

- Disable reading command/query from stdin in shell mode
- Clarify the API platform selection in `/setup` meta command

## 0.40 (2025-10-24)

- Support `ESC` key to interrupt the agent loop

- Fix SSL certificate verification error in some rare cases
- Fix possible decoding error in Bash tool

## 0.39 (2025-10-24)

- Fix context compaction threshold check
- Fix panic when SOCKS proxy is set in the shell session

## 0.38 (2025-10-24)

- Minor UX improvements

## 0.37 (2025-10-24)

- Fix update checking

## 0.36 (2025-10-24)

- Add `/debug` meta command to debug the context
- Add auto context compaction
- Add approval request mechanism
- Add `--yolo` option to automatically approve all actions
- Render markdown content for better readability

- Fix "unknown error" message when interrupting a meta command

## 0.35 (2025-10-22)

- Minor UI improvements
- Auto download ripgrep if not found in the system
- Always approve tool calls in `--print` mode
- Add `/feedback` meta command

## 0.34 (2025-10-21)

- Add `/update` meta command to check for updates and auto-update in background
- Support running interactive shell commands in raw shell mode
- Add `/setup` meta command to setup LLM provider and model
- Add `/reload` meta command to reload configuration

## 0.33 (2025-10-18)

- Add `/version` meta command
- Add raw shell mode, which can be switched to by Ctrl-K
- Show shortcuts in bottom status line

- Fix logging redirection
- Merge duplicated input histories

## 0.32 (2025-10-16)

- Add bottom status line
- Support file path auto-completion (`@filepath`)

- Do not auto-complete meta command in the middle of user input

## 0.31 (2025-10-14)

- Fix step interrupting by Ctrl-C, for real

## 0.30 (2025-10-14)

- Add `/compact` meta command to allow manually compacting context

- Fix `/clear` meta command when context is empty

## 0.29 (2025-10-14)

- Support Enter key to accept completion in shell mode
- Remember user input history across sessions in shell mode
- Add `/reset` meta command as an alias for `/clear`

- Fix step interrupting by Ctrl-C

- Disable `SendDMail` tool in Kimi Koder agent

## 0.28 (2025-10-13)

- Add `/init` meta command to analyze the codebase and generate an `AGENTS.md` file
- Add `/clear` meta command to clear the context

- Fix `ReadFile` output

## 0.27 (2025-10-11)

- Add `--mcp-config-file` and `--mcp-config` options to load MCP configs

- Rename `--agent` option to `--agent-file`

## 0.26 (2025-10-11)

- Fix possible encoding error in `--output-format stream-json` mode

## 0.25 (2025-10-11)

- Rename package name `ensoul` to `kimi-cli`
- Rename `ENSOUL_*` builtin system prompt arguments to `KIMI_*`
- Further decouple `App` with `Soul`
- Split `Soul` protocol and `KimiSoul` implementation for better modularity

## 0.24 (2025-10-10)

- Fix ACP `cancel` method

## 0.23 (2025-10-09)

- Add `extend` field to agent file to support agent file extension
- Add `exclude_tools` field to agent file to support excluding tools
- Add `subagents` field to agent file to support defining subagents

## 0.22 (2025-10-09)

- Improve `SearchWeb` and `FetchURL` tool call visualization
- Improve search result output format

## 0.21 (2025-10-09)

- Add `--print` option as a shortcut for `--ui print`, `--acp` option as a shortcut for `--ui acp`
- Support `--output-format stream-json` to print output in JSON format
- Add `SearchWeb` tool with `services.moonshot_search` configuration. You need to configure it with `"services": {"moonshot_search": {"api_key": "your-search-api-key"}}` in your config file.
- Add `FetchURL` tool
- Add `Think` tool
- Add `PatchFile` tool, not enabled in Kimi Koder agent
- Enable `SendDMail` and `Task` tool in Kimi Koder agent with better tool prompts
- Add `ENSOUL_NOW` builtin system prompt argument

- Better-looking `/release-notes`
- Improve tool descriptions
- Improve tool output truncation

## 0.20 (2025-09-30)

- Add `--ui acp` option to start Agent Client Protocol (ACP) server

## 0.19 (2025-09-29)

- Support piped stdin for print UI
- Support `--input-format=stream-json` for piped JSON input

- Do not include `CHECKPOINT` messages in the context when `SendDMail` is not enabled

## 0.18 (2025-09-29)

- Support `max_context_size` in LLM model configurations to configure the maximum context size (in tokens)

- Improve `ReadFile` tool description

## 0.17 (2025-09-29)

- Fix step count in error message when exceeded max steps
- Fix history file assertion error in `kimi_run`
- Fix error handling in print mode and single command shell mode
- Add retry for LLM API connection errors and timeout errors

- Increase default max-steps-per-run to 100

## 0.16.0 (2025-09-26)

- Add `SendDMail` tool (disabled in Kimi Koder, can be enabled in custom agent)

- Session history file can be specified via `_history_file` parameter when creating a new session

## 0.15.0 (2025-09-26)

- Improve tool robustness

## 0.14.0 (2025-09-25)

- Add `StrReplaceFile` tool

- Emphasize the use of the same language as the user

## 0.13.0 (2025-09-25)

- Add `SetTodoList` tool
- Add `User-Agent` in LLM API calls

- Better system prompt and tool description
- Better error messages for LLM

## 0.12.0 (2025-09-24)

- Add `print` UI mode, which can be used via `--ui print` option
- Add logging and `--debug` option

- Catch EOF error for better experience

## 0.11.1 (2025-09-22)

- Rename `max_retry_per_step` to `max_retries_per_step`

## 0.11.0 (2025-09-22)

- Add `/release-notes` command
- Add retry for LLM API errors
- Add loop control configuration, e.g. `{"loop_control": {"max_steps_per_run": 50, "max_retry_per_step": 3}}`

- Better extreme cases handling in `read_file` tool
- Prevent Ctrl-C from exiting the CLI, force the use of Ctrl-D or `exit` instead

## 0.10.1 (2025-09-18)

- Make slash commands look slightly better
- Improve `glob` tool

## 0.10.0 (2025-09-17)

- Add `read_file` tool
- Add `write_file` tool
- Add `glob` tool
- Add `task` tool

- Improve tool call visualization
- Improve session management
- Restore context usage when `--continue` a session

## 0.9.0 (2025-09-15)

- Remove `--session` and `--continue` options

## 0.8.1 (2025-09-14)

- Fix config model dumping

## 0.8.0 (2025-09-14)

- Add `shell` tool and basic system prompt
- Add tool call visualization
- Add context usage count
- Support interrupting the agent loop
- Support project-level `AGENTS.md`
- Support custom agent defined with YAML
- Support oneshot task via `kimi -c`
