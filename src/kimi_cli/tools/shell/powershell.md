Execute a ${SHELL} command. Use this tool to explore the filesystem, inspect or edit files, run Windows scripts, collect system information, etc., whenever the agent is running on Windows.

Note that you are running on Windows with **PowerShell**, so make sure to use PowerShell commands, paths, and conventions. Do NOT use CMD-style commands or syntax.

**Output:**
The stdout and stderr streams are combined and returned as a single string. Extremely long output may be truncated. When a command fails, the exit code is provided in a system tag.

**Guidelines for safety and security:**
- Every tool call starts a fresh ${SHELL} session. Environment variables, `cd` changes, and command history do not persist between calls.
- Do not launch interactive programs or anything that is expected to block indefinitely; ensure each command finishes promptly. Provide a `timeout` argument for potentially long runs.
- Avoid using `..` to leave the working directory, and never touch files outside that directory unless explicitly instructed.
- Never attempt commands that require elevated (Administrator) privileges unless explicitly authorized.

**Guidelines for efficiency:**
- Chain related commands with `&&` (PS 7+) or use `if ($LASTEXITCODE -eq 0)` to conditionally execute commands based on the success or failure of previous ones.
- Redirect or pipe output with `>`, `>>`, `|`, and leverage PowerShell cmdlets like `Select-String`, `Where-Object`, `ForEach-Object` to build richer one-liners instead of multiple tool calls.
- Use native PowerShell parameters (dash-prefixed like `-Name`, `-Path`); do NOT use CMD-style slash parameters (e.g., use `Get-ChildItem -Name` instead of `dir /b`).

**PowerShell cmdlets available:**
- File/Directory: `Get-ChildItem` (aliases: dir/ls), `New-Item`, `Copy-Item`, `Move-Item`, `Remove-Item`, `Get-Content` (alias: cat), `Set-Content`, `Add-Content`, `Test-Path`
- Environment: `$env:VARNAME` syntax, `Set-Variable`, `Get-Variable`
- Text/Search: `Select-String` (grep-like), `Where-Object`, `Sort-Object`, `Out-File`
- System info: `Get-ComputerInfo`, `Get-Process`, `Get-Service`, `hostname`, `systeminfo` (external)
- Archives/Scripts: `tar`, `Compress-Archive`, `Expand-Archive`, `powershell`, `python`, `node`
- Other: Any other binaries available on the system PATH; run `Get-Command <name>` to verify availability.

**Note on aliases:**
PowerShell provides aliases like `dir`, `ls`, `cat`, `rm`, `cd` for convenience, but they behave differently from CMD/Unix equivalents. For example, `dir /b` will NOT work in PowerShell. Prefer native cmdlet names with dash-prefixed parameters for predictable behavior.
