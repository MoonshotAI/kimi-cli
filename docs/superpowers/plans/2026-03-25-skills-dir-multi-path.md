# `--skills-dir` Multi-Path Append Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change `--skills-dir` from a single-path override to a repeatable append flag, so extra skill directories are added alongside (not replacing) the default builtin/user/project discovery chain.

**Architecture:** Rename `skills_dir_override` to `extra_skills_dirs` (a list), remove the if/else branch in `resolve_skills_roots` so all layers always participate, and flip `discover_skills_from_roots` to first-wins semantics via `setdefault`.

**Tech Stack:** Python, typer, kaos, pytest

**Spec:** `docs/superpowers/specs/2026-03-25-skills-dir-multi-path-design.md`

---

### Task 1: Fix `discover_skills_from_roots` to first-wins semantics

**Files:**
- Modify: `src/kimi_cli/skill/__init__.py:129-132`
- Test: `tests/core/test_skill.py`

- [ ] **Step 1: Write the failing test for first-wins dedup**

In `tests/core/test_skill.py`, add after the existing tests (line ~209):

```python
@pytest.mark.asyncio
async def test_discover_skills_from_roots_first_wins(tmp_path):
    """When the same skill name appears in multiple roots, the first root wins."""
    # Root A has skill "greet" with description "A"
    root_a = tmp_path / "root_a" / "greet"
    root_a.mkdir(parents=True)
    (root_a / "SKILL.md").write_text(
        "---\nname: greet\ndescription: A\n---\nHello from A",
        encoding="utf-8",
    )

    # Root B has skill "greet" with description "B"
    root_b = tmp_path / "root_b" / "greet"
    root_b.mkdir(parents=True)
    (root_b / "SKILL.md").write_text(
        "---\nname: greet\ndescription: B\n---\nHello from B",
        encoding="utf-8",
    )

    skills = await discover_skills_from_roots([
        KaosPath.unsafe_from_local_path(tmp_path / "root_a"),
        KaosPath.unsafe_from_local_path(tmp_path / "root_b"),
    ])

    assert len(skills) == 1
    assert skills[0].description == "A"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/core/test_skill.py::test_discover_skills_from_roots_first_wins -xvs`
Expected: FAIL — description will be "B" (current last-wins behavior)

- [ ] **Step 3: Implement first-wins in `discover_skills_from_roots`**

In `src/kimi_cli/skill/__init__.py`, change line 132 from:

```python
            skills_by_name[normalize_skill_name(skill.name)] = skill
```

to:

```python
            skills_by_name.setdefault(normalize_skill_name(skill.name), skill)
```

- [ ] **Step 4: Update existing `test_discover_skills_from_roots_prefers_later_dirs` (lines 120-166)**

This test asserts last-wins behavior. Rename and update to expect first-wins:

```python
@pytest.mark.asyncio
async def test_discover_skills_from_roots_prefers_earlier_dirs(tmp_path):
    root = tmp_path / "root"
    system_dir = root / "system"
    user_dir = root / "user"
    system_dir.mkdir(parents=True)
    user_dir.mkdir(parents=True)

    _write_skill(
        system_dir / "shared",
        """---
name: shared
description: System version
---
""",
    )
    _write_skill(
        user_dir / "shared",
        """---
name: shared
description: User version
---
""",
    )

    root_path = KaosPath.unsafe_from_local_path(root)
    skills = await discover_skills_from_roots(
        [
            KaosPath.unsafe_from_local_path(system_dir),
            KaosPath.unsafe_from_local_path(user_dir),
        ]
    )
    base_dir = KaosPath.unsafe_from_local_path(Path("/path/to"))
    for skill in skills:
        relative_dir = skill.dir.relative_to(root_path)
        skill.dir = base_dir / relative_dir

    assert skills == snapshot(
        [
            Skill(
                name="shared",
                description="System version",
                type="standard",
                dir=KaosPath.unsafe_from_local_path(Path("/path/to/system/shared")),
                flow=None,
            )
        ]
    )
```

- [ ] **Step 5: Run all tests to verify they pass**

Run: `python -m pytest tests/core/test_skill.py -xvs --snapshot-update`
Expected: ALL PASS (snapshot updated)

- [ ] **Step 6: Commit**

```bash
git add src/kimi_cli/skill/__init__.py tests/core/test_skill.py
git commit -m "fix(skills): use first-wins semantics in discover_skills_from_roots"
```

---

### Task 2: Change `resolve_skills_roots` to append instead of override

**Files:**
- Modify: `src/kimi_cli/skill/__init__.py:5,85-112`
- Test: `tests/core/test_skill.py`

- [ ] **Step 1: Write the failing test for append behavior**

In `tests/core/test_skill.py`, replace `test_resolve_skills_roots_respects_override` (lines 192-209) with:

```python
@pytest.mark.asyncio
async def test_resolve_skills_roots_appends_extra_dirs(tmp_path, monkeypatch):
    """Extra dirs are appended after user/project, not replacing them."""
    home_dir = tmp_path / "home"
    user_dir = home_dir / ".config" / "agents" / "skills"
    user_dir.mkdir(parents=True)
    monkeypatch.setattr(Path, "home", lambda: home_dir)

    work_dir = tmp_path / "project"
    project_dir = work_dir / ".agents" / "skills"
    project_dir.mkdir(parents=True)

    extra_a = tmp_path / "extra_a"
    extra_a.mkdir()
    extra_b = tmp_path / "extra_b"
    extra_b.mkdir()

    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))

    roots = await resolve_skills_roots(
        KaosPath.unsafe_from_local_path(work_dir),
        extra_skills_dirs=[
            KaosPath.unsafe_from_local_path(extra_a),
            KaosPath.unsafe_from_local_path(extra_b),
        ],
    )

    assert roots == [
        KaosPath.unsafe_from_local_path(get_builtin_skills_dir()),
        KaosPath.unsafe_from_local_path(user_dir),
        KaosPath.unsafe_from_local_path(project_dir),
        KaosPath.unsafe_from_local_path(extra_a),
        KaosPath.unsafe_from_local_path(extra_b),
    ]


@pytest.mark.asyncio
async def test_resolve_skills_roots_empty_extra_dirs(tmp_path, monkeypatch):
    """Empty extra_skills_dirs behaves same as None."""
    monkeypatch.setenv("KIMI_SHARE_DIR", str(tmp_path / "share"))

    roots_none = await resolve_skills_roots(
        KaosPath.unsafe_from_local_path(tmp_path),
        extra_skills_dirs=None,
    )
    roots_empty = await resolve_skills_roots(
        KaosPath.unsafe_from_local_path(tmp_path),
        extra_skills_dirs=[],
    )

    assert roots_none == roots_empty
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/core/test_skill.py::test_resolve_skills_roots_appends_extra_dirs tests/core/test_skill.py::test_resolve_skills_roots_empty_extra_dirs -xvs`
Expected: FAIL — `extra_skills_dirs` kwarg not recognized

- [ ] **Step 3: Implement the change in `resolve_skills_roots`**

In `src/kimi_cli/skill/__init__.py`, add `Sequence` to the import on line 5:

```python
from collections.abc import Callable, Iterable, Iterator, Sequence
```

Replace lines 85-112 with:

```python
async def resolve_skills_roots(
    work_dir: KaosPath,
    *,
    extra_skills_dirs: Sequence[KaosPath] | None = None,
) -> list[KaosPath]:
    """
    Resolve layered skill roots in priority order.

    Built-in skills load first when supported by the active KAOS backend,
    followed by user/project discovery, then any extra directories supplied
    via ``--skills-dir``, and finally plugin directories.  Extra directories
    are **appended** to the default discovery chain — they never replace
    user or project skills.
    """
    from kimi_cli.plugin.manager import get_plugins_dir

    roots: list[KaosPath] = []
    if _supports_builtin_skills():
        roots.append(KaosPath.unsafe_from_local_path(get_builtin_skills_dir()))
    if user_dir := await find_user_skills_dir():
        roots.append(user_dir)
    if project_dir := await find_project_skills_dir(work_dir):
        roots.append(project_dir)
    if extra_skills_dirs:
        roots.extend(extra_skills_dirs)
    # Plugins are always discoverable
    plugins_path = get_plugins_dir()
    if plugins_path.is_dir():
        roots.append(KaosPath.unsafe_from_local_path(plugins_path))
    return roots
```

- [ ] **Step 4: Run all skill tests to verify they pass**

Run: `python -m pytest tests/core/test_skill.py -xvs`
Expected: ALL PASS (including existing `test_resolve_skills_roots_uses_layers`)

- [ ] **Step 5: Commit**

```bash
git add src/kimi_cli/skill/__init__.py tests/core/test_skill.py
git commit -m "feat(skills): change resolve_skills_roots to append extra dirs instead of override"
```

---

### Task 3: Update pass-through chain (agent.py, app.py, cli/__init__.py)

**Files:**
- Modify: `src/kimi_cli/soul/agent.py:118,127`
- Modify: `src/kimi_cli/app.py:87,108-109,189`
- Modify: `src/kimi_cli/cli/__init__.py:274-284,469-471,537`

- [ ] **Step 1: Update `Runtime.create` in `agent.py`**

In `src/kimi_cli/soul/agent.py`, change line 118 from:

```python
        skills_dir: KaosPath | None = None,
```

to:

```python
        extra_skills_dirs: list[KaosPath] | None = None,
```

Change line 127 from:

```python
        skills_roots = await resolve_skills_roots(session.work_dir, skills_dir_override=skills_dir)
```

to:

```python
        skills_roots = await resolve_skills_roots(session.work_dir, extra_skills_dirs=extra_skills_dirs)
```

- [ ] **Step 2: Update `KimiCLI.create` in `app.py`**

In `src/kimi_cli/app.py`, change line 87 from:

```python
        skills_dir: KaosPath | None = None,
```

to:

```python
        extra_skills_dirs: list[KaosPath] | None = None,
```

Change lines 108-109 (docstring) from:

```python
            skills_dir (KaosPath | None, optional): Override skills directory discovery. Defaults
                to None.
```

to:

```python
            extra_skills_dirs (list[KaosPath] | None, optional): Additional skills directories
                appended to default discovery. Defaults to None.
```

Change line 189 from:

```python
        runtime = await Runtime.create(config, oauth, llm, session, yolo, skills_dir)
```

to:

```python
        runtime = await Runtime.create(config, oauth, llm, session, yolo, extra_skills_dirs)
```

- [ ] **Step 3: Update CLI flag in `cli/__init__.py`**

Change lines 274-284 from:

```python
    local_skills_dir: Annotated[
        Path | None,
        typer.Option(
            "--skills-dir",
            exists=True,
            file_okay=False,
            dir_okay=True,
            readable=True,
            help="Path to the skills directory. Overrides discovery.",
        ),
    ] = None,
```

to:

```python
    local_skills_dir: Annotated[
        list[Path] | None,
        typer.Option(
            "--skills-dir",
            exists=True,
            file_okay=False,
            dir_okay=True,
            readable=True,
            help="Additional skills directories (repeatable). Appended to default discovery.",
        ),
    ] = None,
```

Change lines 469-471 from:

```python
    skills_dir: KaosPath | None = None
    if local_skills_dir is not None:
        skills_dir = KaosPath.unsafe_from_local_path(local_skills_dir)
```

to:

```python
    extra_skills_dirs: list[KaosPath] | None = None
    if local_skills_dir:
        extra_skills_dirs = [KaosPath.unsafe_from_local_path(p) for p in local_skills_dir]
```

Change line 537 from:

```python
                skills_dir=skills_dir,
```

to:

```python
                extra_skills_dirs=extra_skills_dirs,
```

- [ ] **Step 4: Run existing tests to verify nothing is broken**

Run: `python -m pytest tests/core/test_skill.py tests/core/test_load_agent.py -xvs`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/kimi_cli/soul/agent.py src/kimi_cli/app.py src/kimi_cli/cli/__init__.py
git commit -m "refactor(skills): rename skills_dir to extra_skills_dirs through pass-through chain"
```

---

### Task 4: Update test callers of `resolve_skills_roots`

**Files:**
- Modify: `tests/core/test_plugin_manager.py:217`

- [ ] **Step 1: Update `test_plugin_manager.py`**

Line 217 calls `resolve_skills_roots(KaosPath(str(tmp_path)))` — this call uses no keyword args, so it already works. No code change needed. Verify:

Run: `python -m pytest tests/core/test_plugin_manager.py -xvs -k skills`
Expected: PASS

- [ ] **Step 2: Commit (skip if no changes)**

No commit needed — call site uses positional arg only.

---

### Task 5: Update e2e helpers and tests

**Files:**
- Modify: `tests_e2e/wire_helpers.py:257,269-270`
- Modify: `tests_e2e/test_wire_skills_mcp.py:81,168`

- [ ] **Step 1: Update `start_wire` in `wire_helpers.py`**

In `tests_e2e/wire_helpers.py`, change line 257 from:

```python
    skills_dir: Path | None = None,
```

to:

```python
    skills_dirs: list[Path] | None = None,
```

Change lines 269-270 from:

```python
    if skills_dir is not None:
        cmd.extend(["--skills-dir", str(skills_dir)])
```

to:

```python
    for sd in skills_dirs or []:
        cmd.extend(["--skills-dir", str(sd)])
```

- [ ] **Step 2: Update call sites in `test_wire_skills_mcp.py`**

Change line 81 from:

```python
        skills_dir=skill_dir,
```

to:

```python
        skills_dirs=[skill_dir],
```

Change line 168 from:

```python
        skills_dir=skill_dir,
```

to:

```python
        skills_dirs=[skill_dir],
```

- [ ] **Step 3: Run e2e skill tests (if CI-compatible)**

Run: `python -m pytest tests_e2e/test_wire_skills_mcp.py -xvs --timeout=30`
Expected: PASS (or skip if requires running server)

- [ ] **Step 4: Commit**

```bash
git add tests_e2e/wire_helpers.py tests_e2e/test_wire_skills_mcp.py
git commit -m "refactor(tests): update e2e helpers for multi-path skills_dirs"
```

---

### Task 6: Final verification

- [ ] **Step 1: Run full test suite**

Run: `python -m pytest tests/core/test_skill.py tests/core/test_plugin_manager.py -xvs`
Expected: ALL PASS

- [ ] **Step 2: Verify no remaining references to old parameter name**

Run: `grep -r "skills_dir_override" src/ tests/` — should return nothing.
Run: `grep -rn "skills_dir" src/ tests/ tests_e2e/ --include="*.py"` — verify all references use new naming.
