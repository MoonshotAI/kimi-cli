# Tools Module Guide

This directory holds the built-in tools exposed to the agent runtime.

- `shell.rs`: Executes shell commands with approval gating and output truncation.
- `file/`: File tool implementations and shared helpers.
  - `read.rs`: `ReadFile` tool (text reading with size/line limits).
  - `read_media.rs`: `ReadMediaFile` tool (image/video loading + Kimi upload path).
  - `write.rs`: `WriteFile` tool (diff preview + approval gating).
  - `replace.rs`: `StrReplaceFile` tool (string edits + diff/approval).
  - `glob.rs`: `Glob` tool.
  - `grep.rs`: `Grep` tool (rg-backed search).
  - `mod.rs`: shared file detection helpers/constants + re-exports.
- `web/`: Web tool implementations.
  - `search.rs`: `SearchWeb` tool (Moonshot search service).
  - `fetch.rs`: `FetchURL` tool (Moonshot fetch service + HTML extraction).
  - `mod.rs`: re-exports.
- `todo.rs`: Todo list tool emitting `TodoDisplayBlock` updates.
- `multiagent/`: Subagent tools and orchestration.
  - `task.rs`: `Task` tool (run subagent + wire forwarding).
  - `create.rs`: `CreateSubagent` tool.
  - `mod.rs`: re-exports.
- `dmail.rs`: D-Mail sender wired to `DenwaRenji`.
- `think.rs`: Thought logging tool.
- `test.rs`: Test-only math/panic tools (`plus`, `compare`, `panic`).
- `desc/`: Embedded markdown descriptions used to generate tool metadata.
- `utils.rs`: Shared helpers (result builder, truncation, description templating).
