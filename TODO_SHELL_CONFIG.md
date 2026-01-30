# Feature Proposal: Configurable Shell Support for Windows

---

## ⚠️⚠️⚠️ CRITICAL INSTRUCTIONS ⚠️⚠️⚠️

### 1. DO NOT PUSH
**DO NOT PUSH ANY CHANGES TO GITHUB.**

The user will:
1. Review all changes first
2. Run with `--yolo` mode (no confirmation prompts)
3. Push themselves after approval

**YOU ARE FORBIDDEN FROM:**
- Running `git push`
- Running `git push origin`
- Running any push command
- Creating pull requests via API

Only commit locally. The user handles pushing.

### 2. DO NOT RUN `uv run kimi`
**DO NOT RUN `uv run kimi` - THIS IS CRITICAL!**

- `uv run kimi` starts the Kimi CLI AI agent
- You are **implementing** the tool, not **using** it
- Running the AI agent could create infinite recursion (AI using AI)
- Use `make test`, `make check`, `make format` instead for testing your changes

---

> **For the AI agent implementing this feature**: Read this entire document carefully before starting. Pay special attention to the "Implementation Instructions for AI Agent" section at the end.
> 
> **Quick Summary**: 
> - Kimi CLI already has a config system at `~/.kimi/config.toml` with sections like `[providers]`, `[models]`, etc.
> - Add a new `[shell]` section to the **existing** config system
> - Implementation: Add `ShellConfig` class to `config.py`, modify `Environment.detect()` in `environment.py`
> - **Hybrid approach**: Config path → SHELL env var → Auto-detect → PowerShell fallback
> - **Backwards compatible**: Default behavior unchanged (PowerShell on Windows)

---

## Overview
Add user-configurable shell preference to kimi-cli, allowing Windows users to use bash (Git Bash, MSYS2, Cygwin, WSL) instead of being forced to use PowerShell.

---

## 🔍 IMPORTANT FINDING: Existing Config System

**Kimi CLI already has a config file system!**

- **Location**: `~/.kimi/config.toml` (TOML format)
- **Existing sections**: `[providers]`, `[models]`, `[loop_control]`, `[services]`, `[mcp]`
- **See**: `docs/en/configuration/config-files.md` for full documentation

This means adding a `[shell]` section is **consistent with existing architecture** - not a one-off file!

### Example existing config structure:
```toml
default_model = "kimi-for-coding"
default_thinking = false

[providers.kimi-for-coding]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
api_key = "sk-xxx"

[loop_control]
max_steps_per_turn = 100
max_retries_per_step = 3

[services.moonshot_search]
base_url = "https://api.kimi.com/coding/v1/search"
api_key = "sk-xxx"
```

### Recommended Implementation Strategy:
Use a **hybrid approach** with priority order:

1. **Config file** (`~/.kimi/config.toml` `[shell]` section) - explicit user preference
2. **Environment variable** (`SHELL`) - respects user's terminal setup  
3. **Auto-detection** - search common bash locations on Windows
4. **Fallback** - PowerShell (current behavior, backwards compatible)

This follows the principle of "explicit is better than implicit" while maintaining backwards compatibility.

---

## Problem Statement

### Current Behavior
On Windows, kimi-cli hardcodes PowerShell as the shell:

```python
# src/kimi_cli/utils/environment.py - current implementation
if os_kind == "Windows":
    shell_name = "Windows PowerShell"
    shell_path = KaosPath("powershell.exe")
```

### Issues with Current Approach

1. **AI/LLM Compatibility**: Most LLMs (including Kimi, GPT-4, Claude) are trained primarily on bash syntax. They struggle with:
   - PowerShell's verbose cmdlet names (`Get-ChildItem` vs `ls`)
   - Different operators (`;` vs `&&`, `||`)
   - Different quoting rules
   - Different path separators and escaping

2. **Command Failures**: Common bash patterns that fail in PowerShell:
   ```bash
   # This fails in PowerShell:
   ls -la && cat file.txt
   # Error: '&&' is not a valid statement separator
   
   # This fails:
   cat file | grep pattern | wc -l
   # Error: pipeline syntax differences
   
   # This fails:
   export VAR=value
   # Error: export is not recognized
   ```

3. **Developer Experience**: Most developers on Windows already have Git Bash installed and are more comfortable with bash syntax.

4. **Tooling Ecosystem**: Many development tools, CI/CD pipelines, and documentation assume bash syntax.

---

## Proposed Solution

Add a `[shell]` configuration section to the **existing** `~/.kimi/config.toml` with auto-detection and explicit override options.

### Configuration Schema

Add to `src/kimi_cli/config.py`:
```python
class ShellConfig(BaseModel):
    """Shell configuration for command execution."""
    
    path: str | None = None
    """Explicit path to shell executable. Highest priority."""
    
    preferred: Literal["auto", "powershell", "bash"] = "auto"
    """Preferred shell when path is not set. 
        - "auto": Check SHELL env var, then auto-detect
        - "powershell": Use PowerShell (default/current behavior)
        - "bash": Auto-detect bash on Windows
    """
```

User config in `~/.kimi/config.toml`:
```toml
[shell]
# Option 1: Explicit path (highest priority)
path = "C:/Program Files/Git/bin/bash.exe"

# Option 2: Preferred shell with auto-detection
preferred = "bash"  # or "powershell", "auto"
```

**Priority order:**
1. `shell.path` in config.toml (explicit override)
2. `SHELL` environment variable (respects user's terminal)
3. `shell.preferred = "bash"` or `"auto"` → auto-detect common locations
4. Fallback → PowerShell (backwards compatible)

---

## Implementation Details

### 1. Modify: `src/kimi_cli/config.py` - Add ShellConfig

Add this class to the existing `config.py` file:

```python
from pydantic import BaseModel, Field
from typing import Literal

class ShellConfig(BaseModel):
    """Shell configuration for command execution."""
    
    path: str | None = Field(default=None, description="Explicit path to shell executable")
    """Explicit path to shell executable. Highest priority. Example: 'C:/Program Files/Git/bin/bash.exe'"""
    
    preferred: Literal["auto", "powershell", "bash"] = Field(default="auto")
    """Preferred shell when path is not set. 'auto' checks SHELL env var then auto-detects."""


# Add to existing Config class:
class Config(BaseModel):
    # ... existing fields ...
    
    shell: ShellConfig = Field(default_factory=ShellConfig, description="Shell configuration")
    """Shell configuration for command execution."""
```

**Note**: Add `ShellConfig` class and add the `shell` field to the existing `Config` class. The default should be `auto` which preserves current behavior (PowerShell) unless SHELL env var or bash is detected.

### 2. Modified File: `src/kimi_cli/utils/environment.py`

```python
from __future__ import annotations

import os
import platform
from dataclasses import dataclass
from typing import Literal

from kaos.path import KaosPath
from kimi_cli.config import ShellConfig  # New import


@dataclass(slots=True, frozen=True, kw_only=True)
class Environment:
    os_kind: Literal["Windows", "Linux", "macOS"] | str
    os_arch: str
    os_version: str
    shell_name: Literal["bash", "sh", "Windows PowerShell", "zsh", "fish"]
    shell_path: KaosPath

    @staticmethod
    async def detect(shell_config: ShellConfig | None = None) -> Environment:
        """Detect environment with optional shell configuration."""
        
        # Detect OS
        match platform.system():
            case "Darwin":
                os_kind = "macOS"
            case "Windows":
                os_kind = "Windows"
            case "Linux":
                os_kind = "Linux"
            case system:
                os_kind = system

        os_arch = platform.machine()
        os_version = platform.version()

        # Determine shell based on OS
        if os_kind == "Windows":
            shell_name, shell_path = await Environment._determine_windows_shell(
                shell_config
            )
        else:
            shell_name, shell_path = await Environment._determine_unix_shell(
                shell_config
            )

        return Environment(
            os_kind=os_kind,
            os_arch=os_arch,
            os_version=os_version,
            shell_name=shell_name,
            shell_path=shell_path,
        )

    @staticmethod
    async def _determine_windows_shell(
        shell_config: ShellConfig | None = None
    ) -> tuple[str, KaosPath]:
        """Determine shell on Windows with priority: config > env var > auto-detect > fallback."""
        
        config = shell_config or ShellConfig()
        
        # Priority 1: Explicit path in config
        if config.path:
            path = KaosPath(config.path.replace("\\", "/"))
            if await path.is_file():
                shell_name = Environment._infer_shell_name(str(path))
                return shell_name, path
            # Log warning: explicit path not found, continuing to next priority
        
        # Priority 2: SHELL environment variable (respects user's terminal setup)
        # This helps users who have Git Bash or other shells set as their terminal
        if env_shell := os.environ.get("SHELL"):
            path = KaosPath(env_shell.replace("\\", "/"))
            if await path.is_file():
                shell_name = Environment._infer_shell_name(str(path))
                return shell_name, path
        
        # Priority 3: Auto-detect bash if preferred is "auto" or "bash"
        if config.preferred in ("auto", "bash"):
            bash_paths = [
                # Git Bash - standard locations
                KaosPath("C:/Program Files/Git/bin/bash.exe"),
                KaosPath("C:/Program Files (x86)/Git/bin/bash.exe"),
                KaosPath(os.path.expanduser("~/AppData/Local/Programs/Git/bin/bash.exe")),
                # MSYS2
                KaosPath("C:/msys64/usr/bin/bash.exe"),
                KaosPath("C:/msys32/usr/bin/bash.exe"),
                # Cygwin
                KaosPath("C:/cygwin64/bin/bash.exe"),
                KaosPath("C:/cygwin/bin/bash.exe"),
            ]
            
            for path in bash_paths:
                if await path.is_file():
                    return "bash", path
        
        # Priority 4: Fallback to PowerShell (backwards compatible default)
        return "Windows PowerShell", KaosPath("powershell.exe")

    @staticmethod
    async def _determine_unix_shell(
        shell_config: ShellConfig | None = None
    ) -> tuple[str, KaosPath]:
        """Determine shell on Unix-like systems."""
        
        config = shell_config or ShellConfig()
        
        # Priority 1: Explicit path in config
        if config.path:
            path = KaosPath(config.path)
            if await path.is_file():
                shell_name = Environment._infer_shell_name(str(path))
                return shell_name, path
        
        # Priority 2: SHELL environment variable
        if env_shell := os.environ.get("SHELL"):
            path = KaosPath(env_shell)
            if await path.is_file():
                shell_name = Environment._infer_shell_name(str(path))
                return shell_name, path
        
        # Priority 3: Auto-detect common shells
        preferred_order = ["bash", "zsh", "fish", "sh"]
        
        common_paths = [
            KaosPath("/bin/bash"),
            KaosPath("/usr/bin/bash"),
            KaosPath("/usr/local/bin/bash"),
            KaosPath("/bin/zsh"),
            KaosPath("/usr/bin/zsh"),
            KaosPath("/usr/local/bin/zsh"),
            KaosPath("/bin/fish"),
            KaosPath("/usr/bin/fish"),
            KaosPath("/bin/sh"),
            KaosPath("/usr/bin/sh"),
        ]
        
        for path in common_paths:
            if await path.is_file():
                shell_name = Environment._infer_shell_name(str(path))
                if config.preferred == "auto" or shell_name == config.preferred:
                    return shell_name, path
        
        # Fallback to sh
        return "sh", KaosPath("/bin/sh")

    @staticmethod
    def _infer_shell_name(path: str) -> str:
        """Infer shell name from executable path."""
        path_lower = path.lower()
        if "powershell" in path_lower or "pwsh" in path_lower:
            return "Windows PowerShell"
        elif "bash" in path_lower:
            return "bash"
        elif "zsh" in path_lower:
            return "zsh"
        elif "fish" in path_lower:
            return "fish"
        else:
            return "sh"
```

### 3. Modified File: `src/kimi_cli/soul/agent.py`

```python
# In Runtime.create():
environment = await Environment.detect(config.shell)  # Pass config
```

### 4. Modified File: `src/kimi_cli/tools/shell/__init__.py`

Update shell args generation to handle different shells:

```python
def _shell_args(self, command: str) -> tuple[str, ...]:
    """Generate shell arguments based on shell type."""
    
    if self._is_powershell:
        return (str(self._shell_path), "-Command", command)
    elif self._shell_name == "bash":
        return (str(self._shell_path), "-c", command)
    elif self._shell_name == "zsh":
        return (str(self._shell_path), "-c", command)
    elif self._shell_name == "fish":
        return (str(self._shell_path), "-c", command)
    else:  # sh and others
        return (str(self._shell_path), "-c", command)
```

---

## Usage Examples

### Example 1: No Config (Default Behavior)
**No changes to `~/.kimi/config.toml` needed.**

**Behavior on Windows:**
- Checks `SHELL` environment variable → if set to bash, uses it
- Auto-detects Git Bash in common locations → if found, uses it
- Falls back to PowerShell

### Example 2: Force PowerShell (Explicit)
```toml
# ~/.kimi/config.toml
[shell]
preferred = "powershell"
```

### Example 3: Force Bash Auto-Detection
```toml
# ~/.kimi/config.toml
[shell]
preferred = "bash"
```

### Example 4: Explicit Path (Recommended for Power Users)
```toml
# ~/.kimi/config.toml
[shell]
path = "C:/Program Files/Git/bin/bash.exe"
```

### Example 5: Using SHELL Environment Variable
Simply set the `SHELL` environment variable in your terminal:
```powershell
# In PowerShell or Git Bash
$env:SHELL = "C:/Program Files/Git/bin/bash.exe"
kimi
```

Or set it permanently in Windows System Environment Variables.

**Note**: Config `path` takes precedence over `SHELL` env var.

---

## Benefits

1. **Better AI Performance**: LLMs generate correct bash commands more often than PowerShell
2. **Developer Familiarity**: Most developers know bash better than PowerShell
3. **Cross-Platform Consistency**: Same shell syntax across Windows, macOS, and Linux
4. **Backwards Compatible**: Default behavior unchanged (PowerShell on Windows)
5. **Flexible**: Supports explicit paths, auto-detection, and preferences
6. **Future-Proof**: Easy to add new shells (fish, zsh, nushell, etc.)

---

## Testing Checklist

### Unit Tests (in `tests/test_utils_environment.py`)
- [ ] Test `_determine_windows_shell()` with no config, no env var → PowerShell
- [ ] Test `_determine_windows_shell()` with `SHELL` env var set → uses env var
- [ ] Test `_determine_windows_shell()` with config `path` set → uses config path
- [ ] Test `_determine_windows_shell()` with config `preferred = "bash"` → auto-detects
- [ ] Test `_determine_windows_shell()` with config `preferred = "powershell"` → PowerShell
- [ ] Test `_infer_shell_name()` with various paths
- [ ] Test fallback when explicit path doesn't exist

### Integration Tests
- [ ] Default behavior unchanged (PowerShell on Windows without config/env var)
- [ ] Auto-detect finds Git Bash on Windows
- [ ] Shell commands execute correctly in detected shell
- [ ] Unix systems still prefer bash (existing behavior preserved)

### Backwards Compatibility
- [ ] Existing Windows users without config → still get PowerShell
- [ ] Existing Unix users → still get bash/sh (no change)
- [ ] Config file without `[shell]` section → works fine (uses defaults)

---

## Migration Path

1. Current users: No change required, PowerShell remains default
2. New Windows users with Git Bash: Set `auto_detect_bash_on_windows = true`
3. Power users: Set explicit `path` for complete control

---

## Related Issues

This addresses the common issue where AI agents generate bash commands that fail on Windows:
- `ls -la && cat file.txt` fails in PowerShell
- `export VAR=value` fails in PowerShell
- `grep`, `awk`, `sed` patterns fail in PowerShell

---

## Future Enhancements

1. Add `shell_args` config for custom shell arguments
2. Add per-project shell configuration (`.kimi/config.toml`)
3. Support for container shells (Docker, Podman)
4. Shell capability detection (which features are available)

---

# Implementation Instructions for AI Agent

## ⚠️ BEFORE YOU START - MANDATORY CHECKS

### Step 1: Read CONTRIBUTING.md
**File**: `CONTRIBUTING.md` in the repo root

Key points from CONTRIBUTING.md:
- We only merge pull requests that align with our roadmap
- For changes larger than 100 lines of code, raise an issue first
- Code quality must be as good as frontier coding agents
- Use `make prepare` to set up pre-commit hooks
- Run `prek run --all-files` before sending PR

### Step 2: Check for Existing Issues/PRs

**⚠️ IMPORTANT: Check if this feature already exists before implementing!**

Search the repository for:

1. **Existing PRs**: Check if someone already implemented this feature
   ```bash
   git log --all --oneline --grep="shell" | head -20
   git log --all --oneline --grep="bash" | head -20
   git log --all --oneline --grep="powershell" | head -20
   git log --all --oneline --grep="configurable" | head -10
   git log --all --oneline --grep="environment" | head -10
   ```

2. **Check the current environment.py**: 
   ```bash
   cat src/kimi_cli/utils/environment.py
   ```
   If it already accepts a `shell_config` parameter, this feature may already be implemented!

3. **Existing Issues**: Look at GitHub issues for similar requests
   - Search for: "shell", "bash", "powershell", "git bash", "windows shell"

4. **Similar PR to Reference**: PR #452 "feat: use bash instead of sh"
   ```bash
   git show 1747408 --stat
   ```
   This PR added bash support for Unix systems. Use it as a reference for:
   - Code style
   - Test patterns
   - Documentation updates

**If this feature already exists**, inform the user immediately and do not implement.

### Step 3: Development Environment Setup

From README.md, the development workflow is:

```bash
# Clone and setup (already done if reading this)
git clone https://github.com/MoonshotAI/kimi-cli.git
cd kimi-cli
make prepare  # prepare the development environment
```

**Available make commands:**
```bash
# ⚠️ DO NOT RUN THIS - SEE WARNING BELOW ⚠️
# uv run kimi        # Starts the AI agent - DO NOT USE (you're building it!)

# USE THESE INSTEAD:
make format          # format code (run before committing)
make check           # run linting and type checking (run before committing)
make test            # run all tests
make test-kimi-cli   # run Kimi Code CLI tests only
make test-kosong     # run kosong tests only
make test-pykaos     # run pykaos tests only
make build-web       # build the web UI (requires Node.js/npm)
make build           # build python packages
make build-bin       # build standalone binary
make help            # show all make targets
```

### ⚠️⚠️⚠️ CRITICAL: DO NOT RUN `uv run kimi` ⚠️⚠️⚠️

**Why:**
- `uv run kimi` starts the Kimi CLI AI agent
- You are **implementing** the tool, not **using** it
- Running the AI agent could create infinite recursion (AI using AI)
- The AI agent might try to modify its own source code

**What to do instead:**
- Use `make test` to run unit tests
- Use `make check` to verify code quality
- Use `make format` to format code
- Manually verify the code compiles without errors

**Focus on:**
- Implementing the shell configuration feature
- Writing tests in `tests/test_utils_environment.py`
- Verifying backwards compatibility

---

### Step 4: Understand the Codebase Structure

**Key Files to Modify** (in `src/kimi_cli/`):
1. `config.py` - Add `ShellConfig` class
2. `utils/environment.py` - Rewrite `Environment.detect()`
3. `soul/agent.py` - Pass config to `Environment.detect()`
4. `tools/shell/__init__.py` - Handle different shell types

**Test Files** (in `tests/`):
1. `test_utils_environment.py` - Add tests for shell detection
2. Update existing tests if they mock Environment

**Documentation**:
1. `docs/configuration/config-files.md` - Document new config options
2. `CHANGELOG.md` - Add entry for this feature

### Step 5: Follow Commit Message Convention

The repo uses **Conventional Commits**:
```
feat: add configurable shell support for Windows

- Add ShellConfig class to config.py
- Auto-detect bash on Windows (Git Bash, MSYS2, Cygwin, WSL)
- Allow explicit shell path configuration
- Maintain backwards compatibility with PowerShell default

Signed-off-by: Your Name <your.email@example.com>
```

Common prefixes from the repo:
- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `refactor:` - Code refactoring
- `test:` - Test changes
- `chore:` - Maintenance tasks

### Step 6: Implementation Order

1. **Start with tests first** (TDD approach):
   - Write tests in `tests/test_utils_environment.py`
   - Tests should cover Windows shell detection logic

2. **Implement the feature**:
   - Add `ShellConfig` to `config.py`
   - Modify `Environment.detect()` in `utils/environment.py`
   - Update `agent.py` to pass config
   - Update shell tool in `tools/shell/__init__.py`

3. **Run tests**:
   ```bash
   make test
   # or
   pytest tests/test_utils_environment.py -v
   ```

4. **Run linting/formatting**:
   ```bash
   make format
   make check
   # or
   prek run --all-files
   ```

5. **Update documentation**:
   - Add config examples to `docs/configuration/config-files.md`
   - Update `CHANGELOG.md`

### Step 7: Backwards Compatibility Requirements

- **Default behavior must NOT change**: Windows users without config should still get PowerShell
- **Config is optional**: All new config fields have defaults
- **Graceful fallback**: If explicit path is invalid, log warning and use default
- **No breaking changes**: Existing `Environment` dataclass fields remain unchanged

### Step 8: Testing on Windows (If Possible)

If you have access to Windows:
```bash
# Test with Git Bash installed
# Should auto-detect and use bash

# Test without Git Bash
# Should fall back to PowerShell

# Test with explicit config
# Should use configured shell
```

### Step 9: Final Review (DO NOT PUSH!)

⚠️ **STOP HERE - DO NOT PUSH TO GITHUB** ⚠️

Checklist before informing the user:
- [ ] All tests pass
- [ ] Pre-commit hooks pass (`prek run --all-files`)
- [ ] CHANGELOG.md updated
- [ ] Documentation updated
- [ ] Commit message follows convention
- [ ] No breaking changes
- [ ] Backwards compatible defaults
- [ ] All changes committed locally with `git commit`

**REMEMBER: DO NOT RUN `git push` - The user will review and push themselves**

### Step 10: Inform User (Not Push!)

Template:
```markdown
## Summary
Add configurable shell support for Windows, allowing users to use bash (Git Bash, MSYS2, Cygwin, WSL) instead of PowerShell.

## Problem
On Windows, kimi-cli hardcodes PowerShell. LLMs generate bash commands that fail in PowerShell (e.g., `&&`, `||`, `export`).

## Solution
- Add `[shell]` config section with `preferred`, `path`, and `auto_detect_bash_on_windows` options
- Auto-detect bash installations on Windows
- Allow explicit shell path override
- Default unchanged (PowerShell) for backwards compatibility

## Changes
- `src/kimi_cli/config.py`: Add `ShellConfig` class
- `src/kimi_cli/utils/environment.py`: Add shell detection logic
- `src/kimi_cli/soul/agent.py`: Pass shell config to Environment
- `src/kimi_cli/tools/shell/__init__.py`: Handle shell-specific args
- Tests and documentation updated

## Testing
- [ ] Unit tests added for shell detection
- [ ] Tested on Windows with Git Bash
- [ ] Backwards compatibility verified

## Related
- Similar to PR #452 which added bash support for Unix
- Addresses common issue with AI-generated bash commands on Windows
```

**STOP - DO NOT PUSH!**  
Inform the user that implementation is complete. They will review and push with `--yolo` mode.

---

## Reference: Similar PR for Code Style

**PR #452**: `1747408 feat: use bash instead of sh (#452)`

Look at this commit for:
- How they modified `environment.py`
- How they added tests
- Commit message format
- Documentation updates

Files changed in PR #452:
- `src/kimi_cli/soul/agent.py`
- `src/kimi_cli/tools/shell/__init__.py`
- `src/kimi_cli/tools/shell/bash.md` (renamed from sh.md)
- `src/kimi_cli/tools/shell/powershell.md`
- `src/kimi_cli/tools/utils.py`
- `src/kimi_cli/utils/environment.py`
- `tests/test_utils_environment.py` (new file)
- `tests/test_shell_bash.py` (renamed from test_shell_sh.py)

---

## Final Reminder: DO NOT PUSH

```
╔════════════════════════════════════════════════════════════╗
║  ⚠️  YOU ARE FORBIDDEN FROM PUSHING CHANGES TO GITHUB   ⚠️  ║
║                                                            ║
║  DO NOT RUN:                                               ║
║  - git push                                                ║
║  - git push origin                                         ║
║  - Any push command                                        ║
║                                                            ║
║  The user will:                                            ║
║  1. Review your changes                                    ║
║  2. Run with --yolo mode (no confirmation prompts)         ║
║  3. Push themselves after approval                         ║
║                                                            ║
║  Only commit locally. The user handles pushing.            ║
╚════════════════════════════════════════════════════════════╝
```

## Questions?

If anything is unclear:
1. Look at existing code in the repo
2. Check PR #452 for patterns
3. Follow existing code style
4. When in doubt, prioritize backwards compatibility
