Execute a ${SHELL} command. Use this tool to explore the filesystem, edit files, run scripts, get system information, etc.

**Output:**
The stdout and stderr will be combined and returned as a string. The output may be truncated if it is too long. If the command failed, the exit code will be provided in a system tag.

If `run_in_background=true`, the command will be started as a background task and this tool will return a task ID instead of waiting for command completion. When doing that, you must provide a short `description`. You will be automatically notified when the task completes. Use `TaskOutput` for a non-blocking status/output snapshot, and only set `block=true` when you explicitly want to wait for completion. Use `TaskStop` only if the task must be cancelled. For human users in the interactive shell, background tasks are managed through `/task` only; do not suggest `/task list`, `/task output`, `/task stop`, `/tasks`, or any other invented shell subcommands.

**Guidelines for safety and security:**
- Each shell tool call will be executed in a fresh shell environment. The shell variables, current working directory changes, and the shell history is not preserved between calls.
- The tool call will return after the command is finished. You shall not use this tool to execute an interactive command or a command that may run forever. For possibly long-running commands, you shall set `timeout` argument to a reasonable value.
- Avoid using `..` to access files or directories outside of the working directory.
- Avoid modifying files outside of the working directory unless explicitly instructed to do so.
- Never run commands that require superuser privileges unless explicitly instructed to do so.

**Guidelines for efficiency:**
- For multiple related commands, use `&&` to chain them in a single call, e.g. `cd /path && ls -la`
- Use `;` to run commands sequentially regardless of success/failure
- Use `||` for conditional execution (run second command only if first fails)
- Use pipe operations (`|`) and redirections (`>`, `>>`) to chain input and output between commands
- Always quote file paths containing spaces with double quotes (e.g., cd "/path with spaces/")
- Use `if`, `case`, `for`, `while` control flows to execute complex logic in a single call.
- Verify directory structure before create/edit/delete files or directories to reduce the risk of failure.
- Prefer `run_in_background=true` for long-running builds, tests, watchers, or servers when you need the conversation to continue before the command finishes.
- After starting a background task, do not guess its outcome. Rely on the automatic completion notification whenever possible. Use `TaskOutput` for non-blocking progress snapshots by default, and set `block=true` only when you intentionally want to wait.
- If you need to tell a human shell user how to manage background tasks, only mention `/task`. Do not invent `/task list`, `/task output`, `/task stop`, or `/tasks`.

**Commands available:**
- Shell environment: cd, pwd, export, unset, env
- File system operations: ls, find, mkdir, rm, cp, mv, touch, chmod, chown
- File viewing/editing: cat, grep, head, tail, diff, patch
- Text processing: awk, sed, sort, uniq, wc
- System information/operations: ps, kill, top, df, free, uname, whoami, id, date
- Network operations: curl, wget, ping, telnet, ssh
- Archive operations: tar, zip, unzip
- Other: Other commands available in the shell environment. Check the existence of a command by running `which <command>` before using it.
