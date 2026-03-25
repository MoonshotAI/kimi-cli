# Kimi Code CLI Tools

## Guidelines

- Tools should not refer to types in `kimi_cli/wire/` unless they are explicitly implementing a UI / runtime bridge. When importing things like `ToolReturnValue` or `DisplayBlock`, prefer `kosong.tooling`.
