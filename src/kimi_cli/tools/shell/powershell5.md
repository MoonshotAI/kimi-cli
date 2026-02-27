Execute a ${SHELL} command. Use this tool to explore the filesystem, inspect or edit files, run Windows scripts, collect system information, etc., whenever the agent is running on Windows.

**⚠️ CRITICAL: You are running Windows PowerShell 5.1**

PowerShell 5.1 is the legacy version built into Windows and has **significant syntax limitations**. You MUST follow the compatibility rules below:

**❌ FORBIDDEN in PowerShell 5.1 (will cause syntax errors):**
- `&&` and `||` operators (these are PowerShell 7+ only)
  - BAD: `cd dir && ls`
  - BAD: `python test.py || echo "failed"`

**✅ REQUIRED alternatives for conditional execution:**

| Instead of | Use |
|------------|-----|
| `cmd1 && cmd2` | `cmd1; if ($?) { cmd2 }` or simply `cmd1; cmd2` |
| `cmd1 \|\| cmd2` | `cmd1; if ($LASTEXITCODE -ne 0) { cmd2 }` |
| Command chains | Use `;` to run commands sequentially regardless of success |

**Examples of CORRECT PowerShell 5.1 syntax:**
```powershell
# Sequential execution (always runs both)
Write-Host "Step 1"; Write-Host "Step 2"

# Conditional: only run second command if first succeeded
python script.py; if ($?) { echo "Success" }

# Conditional: run second only if first failed
python script.py; if ($LASTEXITCODE -ne 0) { echo "Failed" }

# Multiple commands
mkdir "test"; Set-Location "test"; New-Item "file.txt"
```

**Output:**
The stdout and stderr streams are combined and returned as a single string. Extremely long output may be truncated. When a command fails, the exit code is provided in a system tag.

**Guidelines for safety and security:**
- Every tool call starts a fresh ${SHELL} session. Environment variables, `cd` changes, and command history do not persist between calls.
- Do not launch interactive programs or anything that is expected to block indefinitely; ensure each command finishes promptly. Provide a `timeout` argument for potentially long runs.
- Avoid using `..` to leave the working directory, and never touch files outside that directory unless explicitly instructed.
- Never attempt commands that require elevated (Administrator) privileges unless explicitly authorized.

**Guidelines for efficiency:**
- **Chain commands with `;` (semicolon)**, not `&&` or `||`
- Use `if ($?)` or `if ($LASTEXITCODE -eq 0)` for conditional logic based on previous command success
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

**Version detected:** ${SHELL_VERSION}
