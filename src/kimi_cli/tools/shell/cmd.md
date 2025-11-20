Execute a Windows Command Prompt (`cmd.exe`) command. Use this tool to explore the filesystem, inspect or edit files, run Windows scripts, collect system information, etc., whenever the agent is running on Windows.

Note that you are running on Windows, so make sure to use Windows commands, paths, and conventions.

**Output:**
The stdout and stderr streams are combined and returned as a single string. Extremely long output may be truncated. When a command fails, the exit code is provided in a system tag.

**Guidelines for safety and security:**
- Every tool call starts a fresh `cmd.exe` session. Environment variables, `cd` changes, and command history do not persist between calls.
- Do not launch interactive programs or anything that is expected to block indefinitely; ensure each command finishes promptly. Provide a `timeout` argument for potentially long runs.
- Avoid using `..` to leave the working directory, and never touch files outside that directory unless explicitly instructed.
- Never attempt commands that require elevated (Administrator) privileges unless explicitly authorized.

**Windows-specific tips:**
- Use `cd /d "<path>"` when you must switch drives and directories in one command.
- Quote any path containing spaces with double quotes. Escape special characters such as `&`, `|`, `>`, and `<` with `^` when needed.
- Prefer non-interactive file editing techniques such as `type`, `more`, `copy`, `powershell -Command "Get-Content"`, or `python - <<'PY' ... PY`.
- Convert forward slashes to backslashes only when a command explicitly requires it; most tooling on Windows accepts `/` as well.

**Guidelines for efficiency:**
- Chain related commands with `&&` (stop on failure) or `&` (always continue); use `||` to run a fallback after a failure.
- Redirect or pipe output with `>`, `>>`, `|`, and leverage `for /f`, `if`, and `set` to build richer one-liners instead of multiple tool calls.
- Reuse built-in utilities (e.g., `findstr`, `where`, `powershell`) to filter, transform, or locate data in a single invocation.

**Commands available:**
- Shell environment: `cd`, `dir`, `set`, `setlocal`, `echo`, `call`, `where`
- File operations: `type`, `copy`, `move`, `del`, `erase`, `mkdir`, `rmdir`, `attrib`, `mklink`
- Text/search: `find`, `findstr`, `more`, `sort`, `powershell -Command "Get-Content"`
- System info: `ver`, `systeminfo`, `tasklist`, `wmic`, `hostname`
- Archives/scripts: `tar`, `powershell -Command "Compress-Archive"`, `powershell`, `python`, `node`
- Other: Any other binaries available on the system PATH; run `where <command>` first if unsure.
