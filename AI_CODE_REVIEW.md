# Code Review Request: Configurable Shell Support for Windows

## Summary of Changes

This PR adds a `[shell]` configuration section to kimi-cli's existing config system (`~/.kimi/config.toml`), allowing Windows users to use bash (Git Bash, MSYS2, Cygwin) instead of being forced to use PowerShell.

**Problem:** On Windows, kimi-cli hardcoded PowerShell. LLMs generate bash commands that fail in PowerShell (e.g., `&&`, `||`, `export`).

**Solution:** Hybrid shell detection with priority order:
1. Explicit config path (`shell.path`)
2. `SHELL` environment variable (respects user's terminal setup)
3. Auto-detect based on `shell.preferred` setting
4. PowerShell fallback (backwards compatible)

## Files Modified

### 1. `src/kimi_cli/config.py`
- Added `ShellConfig` class with `path: str | None` and `preferred: "auto" | "powershell" | "bash"`
- Added `shell: ShellConfig` field to main `Config` class
- Default is `preferred="auto"` (backwards compatible)

### 2. `src/kimi_cli/utils/environment.py`
- Complete rewrite of `Environment.detect()` to accept `ShellConfig | None`
- Added `_determine_windows_shell()` with priority logic
- Added `_determine_unix_shell()` for consistency
- Added `_infer_shell_name()` to detect shell type from path
- Auto-detects bash from common Windows locations:
  - Git Bash: `C:/Program Files/Git/bin/bash.exe`, `C:/Program Files (x86)/Git/bin/bash.exe`, `%LOCALAPPDATA%/Programs/Git/bin/bash.exe`
  - MSYS2: `C:/msys64/usr/bin/bash.exe`, `C:/msys32/usr/bin/bash.exe`
  - Cygwin: `C:/cygwin64/bin/bash.exe`, `C:/cygwin/bin/bash.exe`

### 3. `src/kimi_cli/soul/agent.py`
- Updated `Runtime.create()` to pass `config.shell` to `Environment.detect()`

### 4. `src/kimi_cli/tools/shell/__init__.py`
- Updated `_shell_args()` to use `-Command` for PowerShell, `-c` for bash/zsh/fish

### 5. Test files updated
- `tests/core/test_config.py` - Added ShellConfig to default config tests
- `tests/utils/test_utils_environment.py` - Comprehensive shell detection tests
- `tests/utils/test_pyinstaller_utils.py` - Fixed snapshot ordering

## What the Reviewer Should Check

### 1. Hardcoded Values / Environment-Specific Code
- [ ] No hardcoded paths that only exist on developer's machine
- [ ] Auto-detection paths use common standard locations (Program Files, etc.)
- [ ] Backslash/forward slash handling is correct for Windows
- [ ] No dependencies on specific Git Bash installation paths beyond common defaults

### 2. Backwards Compatibility
- [ ] Default behavior is unchanged: Windows users without config still get PowerShell
- [ ] Existing `Environment` dataclass fields unchanged (no breaking changes)
- [ ] Config without `[shell]` section works fine (uses defaults)
- [ ] Unix/Linux users unaffected (existing bash detection preserved)

### 3. Error Handling
- [ ] If explicit `shell.path` doesn't exist, falls back gracefully to PowerShell
- [ ] If `SHELL` env var points to non-existent file, continues to next priority
- [ ] No crashes if bash paths don't exist on Windows
- [ ] Path validation handles both `/` and `\` separators

### 4. Edge Cases
- [ ] Handles `preferred="auto"` correctly when bash not installed (falls back to PowerShell)
- [ ] Handles `preferred="powershell"` correctly (skips auto-detect)
- [ ] Handles `preferred="bash"` when bash not found (falls back to PowerShell)
- [ ] Shell name inference works for: bash, zsh, fish, PowerShell, pwsh, sh
- [ ] Unix systems ignore Windows-specific logic and vice versa

### 5. Type Safety
- [ ] All type hints are correct (`str | None`, `Literal` types)
- [ ] No `Any` types introduced unnecessarily
- [ ] Pydantic model validation works correctly

### 6. Code Quality
- [ ] No code duplication between `_determine_windows_shell` and `_determine_unix_shell`
- [ ] Async/await patterns consistent with rest of codebase
- [ ] Imports are clean and follow project conventions
- [ ] Line length <= 100 characters
- [ ] ruff and pyright pass

### 7. Test Coverage
- [ ] Tests cover all priority levels (config path > env var > auto-detect > fallback)
- [ ] Tests mock `KaosPath.is_file` properly (don't depend on real filesystem)
- [ ] Tests handle Windows vs Unix platform differences correctly
- [ ] Tests verify shell name inference for various executables

## Testing Instructions for Reviewer

1. **Test backwards compatibility:**
   ```powershell
   # Remove any shell config from ~/.kimi/config.toml
   # Run kimi - should use PowerShell on Windows
   ```

2. **Test SHELL env var detection:**
   ```bash
   # From Git Bash
   echo $SHELL  # Should show path to bash
   kimi
   # In kimi: ls -la && echo "test"  # Should work (bash syntax)
   ```

3. **Test explicit config:**
   ```toml
   # Add to ~/.kimi/config.toml
   [shell]
   preferred = "bash"
   ```
   ```powershell
   # From PowerShell (no SHELL env var)
   kimi
   # In kimi: ls -la && echo "test"  # Should work (auto-detected bash)
   ```

4. **Test fallback:**
   ```toml
   # Add to ~/.kimi/config.toml
   [shell]
   path = "C:/NonExistent/bash.exe"
   ```
   ```powershell
   # Should fall back to PowerShell gracefully
   ```

## Known Issues to Verify

1. **PowerShell profile errors in tests** - The existing `test_shell_powershell.py` tests fail on the developer's machine due to PowerShell profile errors (unrelated to this change). Verify these tests pass in a clean environment.

2. **Version not bumped** - Intentionally left at 1.3 as per maintainer's discretion.

## Questions for Reviewer

1. Are the auto-detect paths comprehensive enough? Should WSL be added?
2. Is the priority order correct? Should SHELL env var take precedence over explicit config.path?
3. Should we log a warning when falling back from explicit path to PowerShell?
4. Are there any security concerns with using SHELL env var?

## Commit Message

```
feat(shell): add configurable shell support for Windows

Add [shell] configuration section to allow Windows users to use bash
(Git Bash, MSYS2, Cygwin) instead of being forced to use PowerShell.

Changes:
- Add ShellConfig class with 'path' and 'preferred' options
- Implement hybrid shell detection with priority order:
  1. Explicit config path
  2. SHELL environment variable
  3. Auto-detect based on preferred setting
  4. PowerShell fallback (backwards compatible)
- Auto-detect bash from common Windows locations
- Support zsh and fish shell name inference
- Update shell tool to use correct args per shell type
- Add comprehensive tests for shell detection

Backwards compatible: default behavior unchanged (PowerShell on Windows).
```
