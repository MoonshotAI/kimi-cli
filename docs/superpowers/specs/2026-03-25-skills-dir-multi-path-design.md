# `--skills-dir` Multi-Path Append

**Date:** 2026-03-25
**Status:** Approved

## Problem

`--skills-dir` accepts a single path and **replaces** user/project skill discovery (`if/else` branch in `resolve_skills_roots`). An agent product that needs "platform skills + team skills + project skills" simultaneously cannot achieve this — it must pick one, losing the rest.

## Design

### Priority Order (first wins)

```
builtin → user → project → extra_dirs (0..N, CLI order preserved) → plugins
```

All layers always participate. `--skills-dir` paths are **appended** after the default discovery chain, never replacing it. Within `extra_dirs`, the order given on the command line determines priority: `--skills-dir A --skills-dir B` means A wins over B for same-named skills.

### Changes

#### 1. `resolve_skills_roots` (`skill/__init__.py`)

- Rename `skills_dir_override: KaosPath | None` → `extra_skills_dirs: Sequence[KaosPath] | None`
- Remove the `if/else` branch; user/project discovery always runs
- Append `extra_skills_dirs` after project, before plugins
- Add `Sequence` to imports from `collections.abc`

#### 2. `discover_skills_from_roots` (`skill/__init__.py`)

- Change `skills_by_name[name] = skill` → `skills_by_name.setdefault(name, skill)`
- Effect: first-discovered skill wins (matches roots priority order)
- Note: `index_skills` is safe — it receives already-deduplicated output from `discover_skills_from_roots`, so no duplicate names reach it

#### 3. CLI flag (`cli/__init__.py`)

- Type: `Path | None` → `list[Path] | None` (default `None`)
- Typer annotation: `list[Path] | None` with `default=None`
- Usage: `--skills-dir ~/shared --skills-dir ./local` (repeatable)
- Help text updated to reflect append semantics

#### 4. Pass-through (`cli/__init__.py` → `app.py` → `agent.py`)

- Parameter renamed from `skills_dir` to `extra_skills_dirs` throughout the chain
- `app.py` docstring updated from "Override skills directory discovery" to "Additional skills directories appended to default discovery"

#### 5. Other callers

- `tests/core/test_plugin_manager.py`: update `resolve_skills_roots` call to use new kwarg name
- `tests_e2e/wire_helpers.py`: update `skills_dir` param to `skills_dirs: list[Path] | None`, pass multiple `--skills-dir` flags
- `tests_e2e/test_wire_skills_mcp.py`: update call sites passing `skills_dir`
- `examples/`: these don't pass `skills_dir` to `Runtime.create`, no change needed

#### 6. Tests (`tests/core/test_skill.py`)

- Update `test_resolve_skills_roots_respects_override`: verify extra dirs are appended (user/project still present)
- Add test: multiple extra dirs preserve order
- Add test: same-name skill — first-discovered wins (builtin > user > extra)
- Add test: `extra_skills_dirs=[]` behaves same as `None`

## Non-Goals

- Config-file-based skill paths (future work)
- Changing builtin skill priority (builtin always wins)
