# Changelog

<!--
Release notes will be parsed and available as /release-notes
The parser extracts for each version:
  - a short description (first paragraph after the version header)
  - bullet entries beginning with "- " under that version (across any subsections)
Internal builds may append content to the Unreleased section.
Only write entries that are worth mentioning to users.
-->

## [Unreleased]

- ACP: Advertise slash commands in single-session ACP mode (`kimi --acp`)
- MCP: Add `mcp.client` config section to configure MCP tool call timeout and other future options
- Core: Improve default system prompt and `ReadFile` tool
- UI: Fix Ctrl-C not working in some rare cases

## [0.66] - 2025-12-19

- Lib: Provide `token_usage` and `message_id` in `StatusUpdate` Wire message
- Lib: Add `KimiToolset.load_tools` method to load tools with dependency injection
- Lib: Add `KimiToolset.load_mcp_tools` method to load MCP tools
- Lib: Move `MCPTool` from `kimi_cli.tools.mcp` to `kimi_cli.soul.toolset`
- Lib: Add `InvalidToolError`, `MCPConfigError` and `MCPRuntimeError`
- Lib: Make the detailed Kimi CLI exception classes extend `ValueError` or `RuntimeError`
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

## [0.65] - 2025-12-16

- Lib: Support creating named sessions via `Session.create(work_dir, session_id)`
- CLI: Automatically create new session when specified session ID is not found
- CLI: Delete empty sessions on exit and ignore sessions whose context file is empty when listing
- UI: Improve session replaying
- Lib: Add `model_config: LLMModel | None` and `provider_config: LLMProvider | None` properties to `LLM` class
- MetaCmd: Add `/usage` meta command to show API usage for Kimi for Coding users

## [0.64] - 2025-12-15

- UI: Fix UTF-16 surrogate characters input on Windows
- Core: Add `/sessions` meta command to list existing sessions and switch to a selected one
- CLI: Add `--session/-S` option to specify session ID to resume
- MCP: Add `kimi mcp` subcommand group to manage global MCP config file `~/.kimi/mcp.json`

## [0.63] - 2025-12-12

- Tool: Fix `FetchURL` tool incorrect output when fetching via service fails
- Tool: Use `bash` instead of `sh` in `Shell` tool for better compatibility
- Tool: Fix `Grep` tool unicode decoding error on Windows
- ACP: Support ACP session continuation (list/load sessions) with `kimi acp` subcommand
- Lib: Add `Session.find` and `Session.list` static methods to find and list sessions
- ACP: Update agent plans on the client side when `SetTodoList` tool is called
- UI: Prevent normal messages starting with `/` from being treated as meta commands

## [0.62] - 2025-12-08

- ACP: Fix tool results (including Shell tool output) not being displayed in ACP clients like Zed
- ACP: Fix compatibility with the latest version of Zed IDE (0.215.3)
- Tool: Use PowerShell instead of CMD on Windows for better usability
- Core: Fix startup crash when there is broken symbolic link in the working directory
- Core: Add builtin `okabe` agent file with `SendDMail` tool enabled
- CLI: Add `--agent` option to specify builtin agents like `default` and `okabe`
- Core: Improve compaction logic to better preserve relevant information

## [0.61] - 2025-12-04

- Lib: Fix logging when used as a library
- Tool: Harden file path check to protect against shared-prefix escape
- LLM: Improve compatibility with some third-party OpenAI Responses and Anthropic API providers

## [0.60] - 2025-12-01

- LLM: Fix interleaved thinking for Kimi and OpenAI-compatible providers

## [0.59] - 2025-11-28

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

## [0.58] - 2025-11-21

- Core: Fix field inheritance of agent spec files when using `extend`
- Core: Support using MCP tools in subagents
- Tool: Add `CreateSubagent` tool to create subagents dynamically (not enabled in default agent)
- Tool: Use MoonshotFetch service in `FetchURL` tool for Kimi for Coding plan
- Tool: Truncate Grep tool output to avoid exceeding token limit

## [0.57] - 2025-11-20

- LLM: Fix Google GenAI provider when thinking toggle is not on
- UI: Improve approval request wordings
- Tool: Remove `PatchFile` tool
- Tool: Rename `Bash`/`CMD` tool to `Shell` tool
- Tool: Move `Task` tool to `kimi_cli.tools.multiagent` module

## [0.56] - 2025-11-19

- LLM: Add support for Google GenAI provider

## [0.55] - 2025-11-18

- Lib: Add `kimi_cli.app.enable_logging` function to enable logging when directly using `KimiCLI` class
- Core: Fix relative path resolution in agent spec files
- Core: Prevent from panic when LLM API connection failed
- Tool: Optimize `FetchURL` tool for better content extraction
- Tool: Increase MCP tool call timeout to 60 seconds
- Tool: Provide better error message in `Glob` tool when pattern is `**`
- ACP: Fix thinking content not displayed properly
- UI: Minor UI improvements in shell mode

## [0.54] - 2025-11-13

- Lib: Move `WireMessage` from `kimi_cli.wire.message` to `kimi_cli.wire`
- Print: Fix `stream-json` output format missing the last assistant message
- UI: Add warning when API key is overridden by `KIMI_API_KEY` environment variable
- UI: Make a bell sound when there's an approval request
- Core: Fix context compaction and clearing on Windows

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
