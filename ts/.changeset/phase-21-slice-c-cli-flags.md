---
'@moonshot-ai/cli': major
'@moonshot-ai/core': minor
---

Phase 21 Slice C — wire orphan CLI flags into runtime; remove unimplemented `--max-*` options.

- `--config` / `--config-file`: parse the inline TOML/JSON or file and deep-merge over the
  disk-loaded `KimiConfig` so CLI overrides win on every key.
- `--add-dir`: extends `WorkspaceConfig.additionalDirs`. Paths that don't exist are
  warned and skipped; paths inside `work-dir` are ignored (the path-guard already
  accepts the workspace root recursively).
- `--mcp-config-file` / `--mcp-config`: layered on top of `[mcp.servers.*]` from
  `config.toml`. New `mergeMcpConfigs` (`@moonshot-ai/core`) is later-wins per
  `mcpServers` key; inline `--mcp-config` JSON beats files which beat disk.
  Malformed JSON now throws `ConfigLoadError` with a clear message instead of
  silently dropping.
- `--skills-dir`: passed through to `resolveSkillRoots` as `explicitDirs`,
  bypassing the default user/project candidate chain.
- **Removed** `--max-steps-per-turn`, `--max-retries-per-step`,
  `--max-ralph-iterations`: the TS port has no Ralph loop or per-step retry
  limit wired in `kimi-core`, so these flags were declared-but-dead. Reintroduce
  them when (and only when) Ralph mode ships in v1.1+.
