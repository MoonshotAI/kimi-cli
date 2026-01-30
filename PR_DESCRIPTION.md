<!--
Thank you for your contribution to Kimi Code CLI!
Please make sure you already discussed the feature or bugfix you are proposing in an issue with the maintainers.
Please understand that if you have not gotten confirmation from the maintainers, your pull request may be closed or ignored without further review due to limited bandwidth.

See https://github.com/MoonshotAI/kimi-cli/blob/main/CONTRIBUTING.md for more.
-->

## Related Issue

<!-- Please link to the issue here. -->

N/A - Feature addition for shell configuration support on Windows

## Description

<!-- Please describe your changes in detail. -->

Add `[shell]` configuration section to allow Windows users to use bash (Git Bash, MSYS2, Cygwin, WSL) instead of being forced to use PowerShell.

**Motivation:** LLMs tend to generate bash commands (e.g., with `&&`, `||`, `export`) that fail in PowerShell. This change allows Windows users to use bash for better command compatibility with LLM-generated commands.

**Changes:**
- Add `ShellConfig` class with `path` and `preferred` options
- Implement hybrid shell detection with priority order:
  1. Explicit config path
  2. SHELL environment variable (only when `preferred="auto"`)
  3. Auto-detect based on preferred setting
  4. PowerShell fallback (backwards compatible)
- Auto-detect bash from common Windows locations (Git Bash, MSYS2, Cygwin, WSL)
- Support zsh and fish shell name inference
- Update shell tool to use correct args per shell type (`-Command` for PowerShell, `-c` for bash)
- Log warning when explicit shell path not found
- Fix type annotation for `_infer_shell_name`
- Add comprehensive tests for shell detection

**Backwards compatible:** default behavior unchanged (PowerShell on Windows when no config/SHELL).

**Example config:**
```toml
[shell]
path = "C:/Program Files/Git/bin/bash.exe"
# OR
preferred = "bash"  # auto, powershell, bash
```

**Documentation:** Updated both English and Chinese documentation in `docs/en/configuration/config-files.md` and `docs/zh/configuration/config-files.md`.

## Checklist

- [x] I have read the [CONTRIBUTING](https://github.com/MoonshotAI/kimi-cli/blob/main/CONTRIBUTING.md) document.
- [ ] I have linked the related issue, if any.
- [x] I have added tests that prove my fix is effective or that my feature works.
- [ ] I have run `make gen-changelog` to update the changelog.
- [x] I have run `make gen-docs` to update the user documentation.
