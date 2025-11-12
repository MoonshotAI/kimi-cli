# Changelog

<!--
Release notes will be parsed and available as /release-notes
The parser extracts for each version:
  - a short description (first paragraph after the version header)
  - bullet entries beginning with "- " under that version (across any subsections)
Internal builds may append content to the Unreleased section.
Only write entries that are worth mentioning to users.
-->

## [0.53] - 2025-11-12

- UI: Remove unnecessary trailing spaces in console output
- Core: Throw error when there are unsupported message parts
- MetaCmd: Add `/yolo` meta command to enable YOLO mode after startup
- Tool: Add approval request for MCP tools
- Tool: Disable `Think` tool in default agent
- CLI: Restore thinking mode from last time when `--thinking` is not specified
- CLI: Fix `/reload` not working in binary packed by PyInstaller

## [0.52] - 2025-11-10

- CLI: Remove `--ui` option in favor of `--print`, `--acp`, and `--wire` flags (shell is still the default)
- CLI: More intuitive session continuation behavior
- Core: Add retry for LLM empty responses
- Tool: Change `Bash` tool to `CMD` tool on Windows
- UI: Fix completion after backspacing
- UI: Fix code block rendering issues on light background colors

## [0.51] - 2025-11-8

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

## [0.50] - 2025-11-07

### Changed

- Improve UI look and feel
- Improve Task tool observability

## [0.49] - 2025-11-06

### Fixed

- Minor UX improvements

## [0.48] - 2025-11-06

### Added

- Support Kimi K2 thinking mode

## [0.47] - 2025-11-05

### Fixed

- Fix Ctrl-W not working in some environments
- Do not load SearchWeb tool when the search service is not configured

## [0.46] - 2025-11-03

### Added

- Introduce Wire over stdio for local IPC (experimental, subject to change)
- Support Anthropic provider type

### Fixed

- Fix binary packed by PyInstaller not working due to wrong entrypoint

## [0.45] - 2025-10-31

### Added

- Allow `KIMI_MODEL_CAPABILITIES` environment variable to override model capabilities
- Add `--no-markdown` option to disable markdown rendering
- Support `openai_responses` LLM provider type

### Fixed

- Fix crash when continuing a session

## [0.44] - 2025-10-30

### Changed

- Improve startup time

### Fixed

- Fix potential invalid bytes in user input

## [0.43] - 2025-10-30

### Added

- Basic Windows support (experimental)
- Display warnings when base URL or API key is overridden in environment variables
- Support image input if the LLM model supports it
- Replay recent context history when continuing a session

### Fixed

- Ensure new line after executing shell commands

## [0.42] - 2025-10-28

### Added

- Support Ctrl-J or Alt-Enter to insert a new line

### Changed

- Change mode switch shortcut from Ctrl-K to Ctrl-X
- Improve overall robustness

### Fixed

- Fix ACP server `no attribute` error

## [0.41] - 2025-10-26

### Fixed

- Fix a bug for Glob tool when no matching files are found
- Ensure reading files with UTF-8 encoding

### Changed

- Disable reading command/query from stdin in shell mode
- Clarify the API platform selection in `/setup` meta command

## [0.40] - 2025-10-24

### Added

- Support `ESC` key to interrupt the agent loop

### Fixed

- Fix SSL certificate verification error in some rare cases
- Fix possible decoding error in Bash tool

## [0.39] - 2025-10-24

### Fixed

- Fix context compaction threshold check
- Fix panic when SOCKS proxy is set in the shell session

## [0.38] - 2025-10-24

- Minor UX improvements

## [0.37] - 2025-10-24

### Fixed

- Fix update checking

## [0.36] - 2025-10-24

### Added

- Add `/debug` meta command to debug the context
- Add auto context compaction
- Add approval request mechanism
- Add `--yolo` option to automatically approve all actions
- Render markdown content for better readability

### Fixed

- Fix "unknown error" message when interrupting a meta command

## [0.35] - 2025-10-22

### Changed

- Minor UI improvements
- Auto download ripgrep if not found in the system
- Always approve tool calls in `--print` mode
- Add `/feedback` meta command

## [0.34] - 2025-10-21

### Added

- Add `/update` meta command to check for updates and auto-update in background
- Support running interactive shell commands in raw shell mode
- Add `/setup` meta command to setup LLM provider and model
- Add `/reload` meta command to reload configuration

## [0.33] - 2025-10-18

### Added

- Add `/version` meta command
- Add raw shell mode, which can be switched to by Ctrl-K
- Show shortcuts in bottom status line

### Fixed

- Fix logging redirection
- Merge duplicated input histories

## [0.32] - 2025-10-16

### Added

- Add bottom status line
- Support file path auto-completion (`@filepath`)

### Fixed

- Do not auto-complete meta command in the middle of user input

## [0.31] - 2025-10-14

### Fixed

- Fix step interrupting by Ctrl-C, for real

## [0.30] - 2025-10-14

### Added

- Add `/compact` meta command to allow manually compacting context

### Fixed

- Fix `/clear` meta command when context is empty

## [0.29] - 2025-10-14

### Added

- Support Enter key to accept completion in shell mode
- Remember user input history across sessions in shell mode
- Add `/reset` meta command as an alias for `/clear`

### Fixed

- Fix step interrupting by Ctrl-C

### Changed

- Disable `SendDMail` tool in Kimi Koder agent

## [0.28] - 2025-10-13

### Added

- Add `/init` meta command to analyze the codebase and generate an `AGENTS.md` file
- Add `/clear` meta command to clear the context

### Fixed

- Fix `ReadFile` output

## [0.27] - 2025-10-11

### Added

- Add `--mcp-config-file` and `--mcp-config` options to load MCP configs

### Changed

- Rename `--agent` option to `--agent-file`

## [0.26] - 2025-10-11

### Fixed

- Fix possible encoding error in `--output-format stream-json` mode

## [0.25] - 2025-10-11

### Changed

- Rename package name `ensoul` to `kimi-cli`
- Rename `ENSOUL_*` builtin system prompt arguments to `KIMI_*`
- Further decouple `App` with `Soul`
- Split `Soul` protocol and `KimiSoul` implementation for better modularity

## [0.24] - 2025-10-10

### Fixed

- Fix ACP `cancel` method

## [0.23] - 2025-10-09

### Added

- Add `extend` field to agent file to support agent file extension
- Add `exclude_tools` field to agent file to support excluding tools
- Add `subagents` field to agent file to support defining subagents

## [0.22] - 2025-10-09

### Changed

- Improve `SearchWeb` and `FetchURL` tool call visualization
- Improve search result output format

## [0.21] - 2025-10-09

### Added

- Add `--print` option as a shortcut for `--ui print`, `--acp` option as a shortcut for `--ui acp`
- Support `--output-format stream-json` to print output in JSON format
- Add `SearchWeb` tool with `services.moonshot_search` configuration. You need to configure it with `"services": {"moonshot_search": {"api_key": "your-search-api-key"}}` in your config file.
- Add `FetchURL` tool
- Add `Think` tool
- Add `PatchFile` tool, not enabled in Kimi Koder agent
- Enable `SendDMail` and `Task` tool in Kimi Koder agent with better tool prompts
- Add `ENSOUL_NOW` builtin system prompt argument

### Changed

- Better-looking `/release-notes`
- Improve tool descriptions
- Improve tool output truncation

## [0.20] - 2025-09-30

### Added

- Add `--ui acp` option to start Agent Client Protocol (ACP) server

## [0.19] - 2025-09-29

### Added

- Support piped stdin for print UI
- Support `--input-format=stream-json` for piped JSON input

### Fixed

- Do not include `CHECKPOINT` messages in the context when `SendDMail` is not enabled

## [0.18] - 2025-09-29

### Added

- Support `max_context_size` in LLM model configurations to configure the maximum context size (in tokens)

### Improved

- Improve `ReadFile` tool description

## [0.17] - 2025-09-29

### Fixed

- Fix step count in error message when exceeded max steps
- Fix history file assertion error in `kimi_run`
- Fix error handling in print mode and single command shell mode
- Add retry for LLM API connection errors and timeout errors

### Changed

- Increase default max-steps-per-run to 100

## [0.16.0] - 2025-09-26

### Tools

- Add `SendDMail` tool (disabled in Kimi Koder, can be enabled in custom agent)

### SDK

- Session history file can be specified via `_history_file` parameter when creating a new session

## [0.15.0] - 2025-09-26

- Improve tool robustness

## [0.14.0] - 2025-09-25

### Added

- Add `StrReplaceFile` tool

### Improved

- Emphasize the use of the same language as the user

## [0.13.0] - 2025-09-25

### Added

- Add `SetTodoList` tool
- Add `User-Agent` in LLM API calls

### Improved

- Better system prompt and tool description
- Better error messages for LLM

## [0.12.0] - 2025-09-24

### Added

- Add `print` UI mode, which can be used via `--ui print` option
- Add logging and `--debug` option

### Changed

- Catch EOF error for better experience

## [0.11.1] - 2025-09-22

### Changed

- Rename `max_retry_per_step` to `max_retries_per_step`

## [0.11.0] - 2025-09-22

### Added

- Add `/release-notes` command
- Add retry for LLM API errors
- Add loop control configuration, e.g. `{"loop_control": {"max_steps_per_run": 50, "max_retry_per_step": 3}}`

### Changed

- Better extreme cases handling in `read_file` tool
- Prevent Ctrl-C from exiting the CLI, force the use of Ctrl-D or `exit` instead

## [0.10.1] - 2025-09-18

- Make slash commands look slightly better
- Improve `glob` tool

## [0.10.0] - 2025-09-17

### Added

- Add `read_file` tool
- Add `write_file` tool
- Add `glob` tool
- Add `task` tool

### Changed

- Improve tool call visualization
- Improve session management
- Restore context usage when `--continue` a session

## [0.9.0] - 2025-09-15

- Remove `--session` and `--continue` options

## [0.8.1] - 2025-09-14

- Fix config model dumping

## [0.8.0] - 2025-09-14

- Add `shell` tool and basic system prompt
- Add tool call visualization
- Add context usage count
- Support interrupting the agent loop
- Support project-level `AGENTS.md`
- Support custom agent defined with YAML
- Support oneshot task via `kimi -c`
