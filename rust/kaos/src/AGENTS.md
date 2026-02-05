# Kaos Core Notes

## Scope

- `lib.rs`: core `Kaos` trait, `KaosProcess`, and top-level helpers.
- `current.rs`: task-local override + global fallback for current Kaos.
- `local.rs`: LocalKaos implementation (filesystem + process).
- `path.rs`: `KaosPath` utility wrapper around `PathBuf`.

## Current Kaos

- Use `with_current_kaos_scope` for task-local overrides.
- `get_current_kaos` falls back to global default (LocalKaos) if no task-local value.

## Stat Semantics

- `StatResult` fields follow Python `os.stat_result` shape.
- On Unix, use `MetadataExt`; on non-Unix, fill available fields and infer `st_mode`.

## KaosPath

- `canonical()` uses current Kaos `cwd()` + `normpath()` (no symlink resolution).
- `expanduser()` replaces leading `~` using Kaos home.
- `read_lines_stream()` yields newline-normalized lines (universal newline behavior).

## Process IO

- `KaosProcess::take_stdout()` / `take_stderr()` allow moving pipes for concurrent reads.
- `stdout()` / `stderr()` fall back to empty readers if streams are already taken.
